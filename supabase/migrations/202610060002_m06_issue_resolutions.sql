-- M06 Reported Issues. Original submission stays immutable; resolution is additive.
begin;
alter table public.employee_time_issues add constraint employee_time_issues_identity_unique unique(business_id,employee_id,id);
alter table public.employee_management_actions add constraint employee_management_actions_identity_unique unique(business_id,subject_employee_id,id);
alter table public.employee_management_actions add column issue_id uuid;
alter table public.employee_management_actions add constraint employee_management_actions_issue_fk foreign key(business_id,subject_employee_id,issue_id) references public.employee_time_issues(business_id,employee_id,id);
alter table public.employee_management_actions drop constraint employee_management_actions_action_check;
alter table public.employee_management_actions add constraint employee_management_actions_action_check check(action in ('employee.created','employee.updated','employee.deactivated','employee.reactivated','employee.pin_reset','time.corrected','time.issue_resolved'));
alter table public.employee_management_actions drop constraint employee_management_actions_snapshot_check;
alter table public.employee_management_actions add constraint employee_management_actions_snapshot_check check (
 (before_value is null or jsonb_typeof(before_value)='object') and jsonb_typeof(after_value)='object' and
 case when action='time.corrected' then before_value is not null and before_value-array['revision','watermark','state','event_count']::text[]='{}'::jsonb and after_value-array['revision','watermark','state','event_count','operation_count']::text[]='{}'::jsonb
 when action='time.issue_resolved' then before_value=jsonb_build_object('status','open') and after_value=jsonb_build_object('status','resolved')
 else (before_value is null or before_value-array['display_name','role','is_active']::text[]='{}'::jsonb) and after_value-array['display_name','role','is_active']::text[]='{}'::jsonb end);
alter table public.employee_management_actions drop constraint employee_management_actions_correction_check;
alter table public.employee_management_actions add constraint employee_management_actions_correction_check check (
 (action='time.corrected')=(correction_id is not null) and (action in ('time.corrected','time.issue_resolved'))=(reason is not null)
 and (reason is null or (reason=btrim(reason) and length(reason) between 1 and 500)));
alter table public.employee_management_actions add constraint employee_management_actions_issue_check check ((action='time.issue_resolved')=(issue_id is not null));
create table public.employee_time_issue_resolutions (
 id uuid primary key default gen_random_uuid(), business_id uuid not null references public.businesses(id) on delete cascade,
 employee_id uuid not null, issue_id uuid not null unique, audit_id uuid not null unique, correction_id uuid,
 note text not null check(note=btrim(note) and length(note) between 3 and 500 and note ~ '[[:alnum:]]'),
 request_id uuid not null, recorded_at timestamptz not null default clock_timestamp(),
 unique(business_id,request_id),
 foreign key(business_id,employee_id,issue_id) references public.employee_time_issues(business_id,employee_id,id),
 foreign key(business_id,employee_id,audit_id) references public.employee_management_actions(business_id,subject_employee_id,id),
 foreign key(business_id,employee_id,correction_id) references public.employee_time_corrections(business_id,employee_id,id)
);
alter table public.employee_time_issue_resolutions enable row level security;
revoke all on public.employee_time_issue_resolutions from public,anon,authenticated,service_role;
grant select on public.employee_time_issue_resolutions to service_role;
create trigger employee_time_issue_resolutions_immutable before update or delete on public.employee_time_issue_resolutions for each row execute function public.m06_management_actions_immutable();
create trigger employee_time_issue_resolutions_no_truncate before truncate on public.employee_time_issue_resolutions for each statement execute function public.m06_management_actions_immutable();

create function public.m06_issue_submission_guard() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='DELETE' and not exists(select 1 from public.businesses where id=old.business_id) then return old; end if;
 if tg_op='UPDATE' then
  if (to_jsonb(new)-array['status','resolved_at','resolved_by_user_id','resolution_note'])=(to_jsonb(old)-array['status','resolved_at','resolved_by_user_id','resolution_note'])
    and old.status='open' and new.status='resolved' and exists (
      select 1 from public.employee_time_issue_resolutions r join public.employee_management_actions a on a.id=r.audit_id
      where r.issue_id=old.id and new.resolved_at=r.recorded_at and new.resolution_note=r.note and new.resolved_by_user_id=a.actor_user_id) then return new; end if;
 end if;
 raise exception 'Issue submission is immutable' using errcode='42501';
end; $$;
revoke all on function public.m06_issue_submission_guard() from public,anon,authenticated,service_role;
create trigger employee_time_issues_immutable before update or delete on public.employee_time_issues for each row execute function public.m06_issue_submission_guard();
create trigger employee_time_issues_no_truncate before truncate on public.employee_time_issues for each statement execute function public.m06_issue_submission_guard();

create function public.m06_resolve_time_issue(p_business_id uuid,p_issue_id uuid,p_actor_id uuid,p_authority_mode text,p_expected_account_role text,p_actor_employee_id uuid,p_actor_device_id uuid,p_actor_session_id uuid,p_note text,p_correction_id uuid,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor_role text; actor_name text; target_role text; issue public.employee_time_issues; existing public.employee_time_issue_resolutions; audit_id uuid:=gen_random_uuid(); resolution_id uuid:=gen_random_uuid(); stamp timestamptz:=clock_timestamp(); v_note text:=btrim(p_note);
begin
 if p_request_id is null or p_issue_id is null or v_note is null or length(v_note) not between 3 and 500 or v_note !~ '[[:alnum:]]' then raise exception 'Invalid resolution' using errcode='22023'; end if;
 select a.effective_role,a.actor_name into actor_role,actor_name from public.m06_assert_management_actor(p_business_id,p_actor_id,p_authority_mode,p_expected_account_role,p_actor_employee_id,p_actor_device_id,p_actor_session_id) a;
 select * into issue from public.employee_time_issues where business_id=p_business_id and id=p_issue_id for update;
 if not found then raise exception 'Issue unavailable' using errcode='Z0003'; end if;
 select role into target_role from public.employees where business_id=p_business_id and id=issue.employee_id for share;
 if not (actor_role='owner' or (actor_role='manager' and target_role='employee')) then raise exception 'Authority unavailable' using errcode='42501'; end if;
 select * into existing from public.employee_time_issue_resolutions where issue_id=p_issue_id;
 if found then
  if existing.request_id=p_request_id and existing.note=v_note and existing.correction_id is not distinct from p_correction_id and exists(select 1 from public.employee_management_actions where id=existing.audit_id and actor_user_id=p_actor_id and actor_employee_id is not distinct from p_actor_employee_id) then return jsonb_build_object('ok',true,'replayed',true,'id',existing.id); end if;
  return jsonb_build_object('ok',false,'code',case when existing.request_id=p_request_id then 'TIME_REQUEST_CONFLICT' else 'ISSUE_ALREADY_RESOLVED' end);
 end if;
 if issue.status<>'open' then return jsonb_build_object('ok',false,'code','ISSUE_ALREADY_RESOLVED'); end if;
 if exists(select 1 from public.employee_time_issue_resolutions where business_id=p_business_id and request_id=p_request_id) then return jsonb_build_object('ok',false,'code','TIME_REQUEST_CONFLICT'); end if;
 if p_correction_id is not null and not exists(select 1 from public.employee_time_corrections where business_id=p_business_id and employee_id=issue.employee_id and id=p_correction_id) then raise exception 'Invalid correction reference' using errcode='22023'; end if;
 insert into public.employee_management_actions(id,business_id,subject_employee_id,actor_user_id,authority_mode,actor_employee_id,actor_device_id,actor_session_id,actor_name_snapshot,account_role,effective_role,action,before_value,after_value,reason,issue_id)
 values(audit_id,p_business_id,issue.employee_id,p_actor_id,p_authority_mode,p_actor_employee_id,p_actor_device_id,p_actor_session_id,actor_name,p_expected_account_role,actor_role,'time.issue_resolved','{"status":"open"}','{"status":"resolved"}',v_note,p_issue_id);
 insert into public.employee_time_issue_resolutions(id,business_id,employee_id,issue_id,audit_id,correction_id,note,request_id,recorded_at) values(resolution_id,p_business_id,issue.employee_id,p_issue_id,audit_id,p_correction_id,v_note,p_request_id,stamp);
 update public.employee_time_issues set status='resolved',resolved_at=stamp,resolved_by_user_id=p_actor_id,resolution_note=v_note where id=p_issue_id;
 return jsonb_build_object('ok',true,'replayed',false,'id',resolution_id);
end; $$;
revoke all on function public.m06_resolve_time_issue(uuid,uuid,uuid,text,text,uuid,uuid,uuid,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.m06_resolve_time_issue(uuid,uuid,uuid,text,text,uuid,uuid,uuid,text,uuid,uuid) to service_role;

-- Trusted API supplies the verified role. Scope filtering precedes cursor/limit.
create function public.m06_time_issues_page(p_business_id uuid,p_role text,p_issue_id uuid,p_status text,p_before_at timestamptz,p_before_id uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(q) order by q.created_at desc,q.id desc),'[]'::jsonb) from (
 select i.id,i.employee_id,e.display_name as employee_name,e.role as employee_role,e.is_active,i.note,i.work_date,i.time_event_id,i.created_at,i.status,
 case when r.id is null then null else jsonb_build_object('id',r.id,'note',r.note,'recordedAt',r.recorded_at,'correctionId',r.correction_id,'auditId',r.audit_id) end as resolution
 from public.employee_time_issues i join public.employees e on e.business_id=i.business_id and e.id=i.employee_id
 left join public.employee_time_issue_resolutions r on r.issue_id=i.id
 where i.business_id=p_business_id and (p_role='owner' or (p_role='manager' and e.role='employee'))
 and (p_issue_id is null or i.id=p_issue_id) and (p_status is null or i.status=p_status)
 and (p_before_at is null or (i.created_at,i.id)<(p_before_at,p_before_id))
 order by i.created_at desc,i.id desc limit 51) q
$$;
revoke all on function public.m06_time_issues_page(uuid,text,uuid,text,timestamptz,uuid) from public,anon,authenticated;
grant execute on function public.m06_time_issues_page(uuid,text,uuid,text,timestamptz,uuid) to service_role;
commit;
