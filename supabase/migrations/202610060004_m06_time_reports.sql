-- Reports reuse the existing effective window and immutable management audit.
begin;
-- Bounded variant of the existing effective window query, not a calculation engine.
create function public.m06_report_window(p_business_id uuid, p_employee_id uuid, p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
  head public.employee_time_effective_events;
  before_event public.employee_time_effective_events;
  last_in public.employee_time_effective_events;
  first_seq bigint;
  last_seq bigint;
  events jsonb;
begin
  select * into head from public.employee_time_effective_events
    where business_id = p_business_id and employee_id = p_employee_id order by seq desc limit 1;
  if head.id is null then
    return jsonb_build_object('events', '[]'::jsonb, 'head', null);
  end if;
  select * into before_event from public.employee_time_effective_events
    where business_id = p_business_id and employee_id = p_employee_id and occurred_at < p_from
    order by seq desc limit 1;
  if before_event.id is not null and before_event.event_type <> 'CLOCK_OUT' then
    select seq into first_seq from public.employee_time_effective_events
      where business_id = p_business_id and employee_id = p_employee_id and event_type = 'CLOCK_IN' and seq <= before_event.seq
      order by seq desc limit 1;
  end if;
  select * into last_in from public.employee_time_effective_events
    where business_id = p_business_id and employee_id = p_employee_id and occurred_at < p_to
    order by seq desc limit 1;
  if last_in.id is null or (first_seq is null and last_in.occurred_at < p_from) then
    events := '[]'::jsonb;
  else
    if last_in.event_type <> 'CLOCK_OUT' then
      select seq into last_seq from public.employee_time_effective_events
        where business_id = p_business_id and employee_id = p_employee_id and event_type = 'CLOCK_OUT' and seq > last_in.seq
        order by seq limit 1;
      last_seq := coalesce(last_seq, head.seq);
    else
      last_seq := last_in.seq;
    end if;
    select coalesce(jsonb_agg(jsonb_build_object('id', id, 'seq', seq, 'event_type', event_type, 'break_type', break_type,
        'occurred_at', occurred_at, 'origin', origin, 'replaced', replaced, 'correction_revision', correction_revision) order by seq), '[]')
      into events from (select * from public.employee_time_effective_events
      where business_id = p_business_id and employee_id = p_employee_id and seq <= last_seq
        and (case when first_seq is null then occurred_at >= p_from else seq >= first_seq end)
      order by seq limit 10001) bounded;
    if jsonb_array_length(events)>10000 then raise exception 'Report event limit' using errcode='54000'; end if;
  end if;
  return jsonb_build_object('events', events, 'head', jsonb_build_object(
    'id', head.id, 'seq', head.seq, 'event_type', head.event_type, 'break_type', head.break_type, 'occurred_at', head.occurred_at));
end;
$$;
revoke all on function public.m06_report_window(uuid, uuid, timestamptz, timestamptz) from public, anon, authenticated, service_role;
create function public.m06_report_dataset(p_business_id uuid,p_role text,p_employee_id uuid,p_from timestamptz,p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare employee record; report_window jsonb; result jsonb:='[]'; total integer:=0; roster integer:=0;
begin
 if p_role is null or p_role not in ('manager','owner') then raise exception 'Authority unavailable' using errcode='42501'; end if;
 if p_business_id is null or p_from is null or p_to is null or p_to<=p_from or p_to-p_from>interval '94 days' then raise exception 'Invalid report range' using errcode='22023'; end if;
 for employee in select id,display_name,role,is_active from public.employees where business_id=p_business_id and (p_employee_id is null or id=p_employee_id) and (p_role='owner' or role='employee') order by id limit 201 loop
  roster:=roster+1;if roster>200 then raise exception 'Report limit' using errcode='54000'; end if;
  report_window:=public.m06_report_window(p_business_id,employee.id,p_from,p_to);
  total:=total+jsonb_array_length(report_window->'events');if total>20000 then raise exception 'Report limit' using errcode='54000'; end if;
  result:=result||jsonb_build_array(jsonb_build_object('employee',jsonb_build_object('id',employee.id,'name',employee.display_name,'role',employee.role,'isActive',employee.is_active),'events',report_window->'events','head',report_window->'head',
    -- Includes VOID-only corrections, whose provenance is absent from live rows.
    -- Conservative lifetime flag: never silently labels corrected history original.
    'hasCorrections',exists(select 1 from public.employee_time_corrections where business_id=p_business_id and employee_id=employee.id)));
 end loop;
 if p_employee_id is not null and roster=0 then raise exception 'Employee unavailable' using errcode='Z0003'; end if;
 return result;
end; $$;
revoke all on function public.m06_report_dataset(uuid,text,uuid,timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.m06_report_dataset(uuid,text,uuid,timestamptz,timestamptz) to service_role;

alter table public.employee_management_actions alter column subject_employee_id drop not null;
alter table public.employee_management_actions add constraint employee_management_actions_subject_required check(subject_employee_id is not null or action='report.exported');
alter table public.employee_management_actions drop constraint employee_management_actions_action_check;
alter table public.employee_management_actions add constraint employee_management_actions_action_check check(action in ('employee.created','employee.updated','employee.deactivated','employee.reactivated','employee.pin_reset','time.corrected','time.issue_resolved','report.exported'));
alter table public.employee_management_actions drop constraint employee_management_actions_snapshot_check;
alter table public.employee_management_actions add constraint employee_management_actions_snapshot_check check (
 (before_value is null or jsonb_typeof(before_value)='object') and jsonb_typeof(after_value)='object' and
 case when action='time.corrected' then before_value is not null and before_value-array['revision','watermark','state','event_count']::text[]='{}'::jsonb and after_value-array['revision','watermark','state','event_count','operation_count']::text[]='{}'::jsonb
 when action='time.issue_resolved' then before_value=jsonb_build_object('status','open') and after_value=jsonb_build_object('status','resolved')
 when action='report.exported' then before_value is null and after_value-array['start_date','end_date','employee_filter','grouping','row_count','generated_at']::text[]='{}'::jsonb
 else (before_value is null or before_value-array['display_name','role','is_active']::text[]='{}'::jsonb) and after_value-array['display_name','role','is_active']::text[]='{}'::jsonb end);
create function public.m06_record_time_export(p_business_id uuid,p_actor_id uuid,p_authority_mode text,p_expected_account_role text,p_actor_employee_id uuid,p_actor_device_id uuid,p_actor_session_id uuid,p_start_date date,p_end_date date,p_employee_id uuid,p_employee_ids uuid[],p_grouping text,p_row_count integer,p_generated_at timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor_role text; actor_name text; target record; found_count integer:=0; audit_id uuid:=gen_random_uuid();
begin
 if p_start_date is null or p_end_date is null or p_end_date<p_start_date or p_end_date-p_start_date>92 or p_grouping is null or p_grouping not in ('employee','day','week','team') or p_row_count is null or p_row_count not between 0 and 20000 or p_generated_at is null or p_employee_ids is null or cardinality(p_employee_ids)>200 or array_position(p_employee_ids,null) is not null then raise exception 'Invalid export' using errcode='22023'; end if;
 select a.effective_role,a.actor_name into actor_role,actor_name from public.m06_assert_management_actor(p_business_id,p_actor_id,p_authority_mode,p_expected_account_role,p_actor_employee_id,p_actor_device_id,p_actor_session_id) a;
 -- Check every employee included in the already generated result under locks.
 -- Export is refused if a target was promoted or removed during generation.
 for target in select id,role from public.employees where business_id=p_business_id and id=any(p_employee_ids) order by id for share loop
  found_count:=found_count+1;
  if not (actor_role='owner' or (actor_role='manager' and target.role='employee')) then raise exception 'Export authority unavailable' using errcode='42501'; end if;
 end loop;
 if found_count<>cardinality(p_employee_ids) or (p_employee_id is not null and (found_count<>1 or p_employee_ids[1]<>p_employee_id)) then raise exception 'Export scope unavailable' using errcode='42501'; end if;
 insert into public.employee_management_actions(id,business_id,subject_employee_id,actor_user_id,authority_mode,actor_employee_id,actor_device_id,actor_session_id,actor_name_snapshot,account_role,effective_role,action,before_value,after_value)
 values(audit_id,p_business_id,p_employee_id,p_actor_id,p_authority_mode,p_actor_employee_id,p_actor_device_id,p_actor_session_id,actor_name,p_expected_account_role,actor_role,'report.exported',null,
 jsonb_build_object('start_date',p_start_date,'end_date',p_end_date,'employee_filter',p_employee_id,'grouping',p_grouping,'row_count',p_row_count,'generated_at',p_generated_at));
 return jsonb_build_object('id',audit_id);
end; $$;
revoke all on function public.m06_record_time_export(uuid,uuid,text,text,uuid,uuid,uuid,date,date,uuid,uuid[],text,integer,timestamptz) from public,anon,authenticated;
grant execute on function public.m06_record_time_export(uuid,uuid,text,text,uuid,uuid,uuid,date,date,uuid,uuid[],text,integer,timestamptz) to service_role;
commit;
