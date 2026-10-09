-- WORKFORCE-01. Forward-only; review before application. No time records change.
begin;
create function public.wf01_report_targets(p_business_id uuid,p_actor_id uuid,p_authority_mode text,p_expected_account_role text,p_actor_employee_id uuid,p_actor_device_id uuid,p_actor_session_id uuid,p_employee_id uuid default null)
returns table(id uuid,display_name text,role text,is_active boolean)
language plpgsql security definer set search_path='' as $$
declare actor_role text;
begin
 select a.effective_role into actor_role from public.m06_assert_management_actor(p_business_id,p_actor_id,p_authority_mode,p_expected_account_role,p_actor_employee_id,p_actor_device_id,p_actor_session_id) a;
 return query select e.id,e.display_name,e.role,e.is_active from public.employees e
 where e.business_id=p_business_id and (p_employee_id is null or e.id=p_employee_id)
 and (actor_role='owner' or (actor_role='manager' and (e.role='employee' or
   (p_authority_mode='shared-device' and e.role='manager' and e.id=p_actor_employee_id))))
 order by e.id limit 201;
end; $$;
revoke all on function public.wf01_report_targets(uuid,uuid,text,text,uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role;

create function public.wf01_report_dataset(p_business_id uuid,p_actor_id uuid,p_authority_mode text,p_expected_account_role text,p_actor_employee_id uuid,p_actor_device_id uuid,p_actor_session_id uuid,p_employee_id uuid,p_from timestamptz,p_to timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
declare employee record; report_window jsonb; result jsonb:='[]'; total integer:=0; roster integer:=0;
begin
 if p_business_id is null or p_from is null or p_to is null or p_to<=p_from or p_to-p_from>interval '94 days' then raise exception 'Invalid report range' using errcode='22023'; end if;
 for employee in select * from public.wf01_report_targets(p_business_id,p_actor_id,p_authority_mode,p_expected_account_role,p_actor_employee_id,p_actor_device_id,p_actor_session_id,p_employee_id) loop
  roster:=roster+1;if roster>200 then raise exception 'Report limit' using errcode='54000'; end if;
  report_window:=public.m06_report_window(p_business_id,employee.id,p_from,p_to);
  total:=total+jsonb_array_length(report_window->'events');if total>20000 then raise exception 'Report limit' using errcode='54000'; end if;
  result:=result||jsonb_build_array(jsonb_build_object('employee',jsonb_build_object('id',employee.id,'name',employee.display_name,'role',employee.role,'isActive',employee.is_active),'events',report_window->'events','head',report_window->'head',
   'hasCorrections',exists(select 1 from public.employee_time_corrections where business_id=p_business_id and employee_id=employee.id)));
 end loop;
 if p_employee_id is not null and roster=0 then raise exception 'Employee unavailable' using errcode='Z0003'; end if;
 return result;
end; $$;
revoke all on function public.wf01_report_dataset(uuid,uuid,text,text,uuid,uuid,uuid,uuid,timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.wf01_report_dataset(uuid,uuid,text,text,uuid,uuid,uuid,uuid,timestamptz,timestamptz) to service_role;

create function public.wf01_report_directory(p_business_id uuid,p_actor_id uuid,p_authority_mode text,p_expected_account_role text,p_actor_employee_id uuid,p_actor_device_id uuid,p_actor_session_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'name',e.display_name,'role',e.role,'isActive',e.is_active) order by e.display_name,e.id),'[]') into result
 from public.wf01_report_targets(p_business_id,p_actor_id,p_authority_mode,p_expected_account_role,p_actor_employee_id,p_actor_device_id,p_actor_session_id,null) e;
 if jsonb_array_length(result)>200 then raise exception 'Report limit' using errcode='54000'; end if;
 return result;
end; $$;
revoke all on function public.wf01_report_directory(uuid,uuid,text,text,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.wf01_report_directory(uuid,uuid,text,text,uuid,uuid,uuid) to service_role;

create or replace function public.m06_record_time_export(p_business_id uuid,p_actor_id uuid,p_authority_mode text,p_expected_account_role text,p_actor_employee_id uuid,p_actor_device_id uuid,p_actor_session_id uuid,p_start_date date,p_end_date date,p_employee_id uuid,p_employee_ids uuid[],p_grouping text,p_row_count integer,p_generated_at timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor_role text; actor_name text; target record; found_count integer:=0; audit_id uuid:=gen_random_uuid();
begin
 if p_start_date is null or p_end_date is null or p_end_date<p_start_date or p_end_date-p_start_date>92 or p_grouping is null or p_grouping not in ('employee','day','week','team') or p_row_count is null or p_row_count not between 0 and 20000 or p_generated_at is null or p_employee_ids is null or cardinality(p_employee_ids)>200 or array_position(p_employee_ids,null) is not null then raise exception 'Invalid export' using errcode='22023'; end if;
 select a.effective_role,a.actor_name into actor_role,actor_name from public.m06_assert_management_actor(p_business_id,p_actor_id,p_authority_mode,p_expected_account_role,p_actor_employee_id,p_actor_device_id,p_actor_session_id) a;
 -- Check every employee included in the already generated result under locks.
 -- Export is refused if a target was promoted or removed during generation.
 for target in select id,role from public.employees where business_id=p_business_id and id=any(p_employee_ids) order by id for share loop
  found_count:=found_count+1;
  if not (actor_role='owner' or (actor_role='manager' and (target.role='employee' or (p_authority_mode='shared-device' and target.role='manager' and target.id=p_actor_employee_id)))) then raise exception 'Export authority unavailable' using errcode='42501'; end if;
 end loop;
 if found_count<>cardinality(p_employee_ids) or (p_employee_id is not null and (found_count<>1 or p_employee_ids[1]<>p_employee_id)) then raise exception 'Export scope unavailable' using errcode='42501'; end if;
 insert into public.employee_management_actions(id,business_id,subject_employee_id,actor_user_id,authority_mode,actor_employee_id,actor_device_id,actor_session_id,actor_name_snapshot,account_role,effective_role,action,before_value,after_value)
 values(audit_id,p_business_id,p_employee_id,p_actor_id,p_authority_mode,p_actor_employee_id,p_actor_device_id,p_actor_session_id,actor_name,p_expected_account_role,actor_role,'report.exported',null,
 jsonb_build_object('start_date',p_start_date,'end_date',p_end_date,'employee_filter',p_employee_id,'grouping',p_grouping,'row_count',p_row_count,'generated_at',p_generated_at));
 return jsonb_build_object('id',audit_id);
end; $$;

commit;
