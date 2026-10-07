-- Read-only, bounded audit history over the existing immutable source.
begin;
create function public.m06_audit_page(p_business_id uuid,p_role text,p_employee_id uuid,p_action text,p_category text,p_from timestamptz,p_to timestamptz,p_before_at timestamptz,p_before_id uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(q) order by q.recorded_at desc,q.id desc),'[]'::jsonb) from (
 select a.id,a.subject_employee_id as employee_id,e.display_name as employee_name,a.recorded_at,
 case when a.action='employee.updated' and a.before_value->>'role' is distinct from a.after_value->>'role' then 'employee.role_changed' else a.action end as action,
 jsonb_build_object('userId',a.actor_user_id,'employeeId',a.actor_employee_id,'name',a.actor_name_snapshot,'mode',a.authority_mode) as actor,
 a.before_value,a.after_value,a.reason,a.correction_id,a.issue_id,a.pin_reset
 from public.employee_management_actions a left join public.employees e on e.business_id=a.business_id and e.id=a.subject_employee_id
 where a.business_id=p_business_id
 and (p_role='owner' or (p_role='manager' and (e.role='employee' or (a.subject_employee_id is null and a.action='report.exported' and a.effective_role='manager'))))
 and (p_employee_id is null or a.subject_employee_id=p_employee_id)
 and (p_action is null or (case when a.action='employee.updated' and a.before_value->>'role' is distinct from a.after_value->>'role' then 'employee.role_changed' else a.action end)=p_action)
 and (p_category is null or (p_category='team' and a.action like 'employee.%') or (p_category='time' and a.action like 'time.%') or (p_category='reports' and a.action='report.exported'))
 and a.recorded_at>=p_from and a.recorded_at<p_to
 and (p_before_at is null or (a.recorded_at,a.id)<(p_before_at,p_before_id))
 order by a.recorded_at desc,a.id desc limit 51) q
$$;
revoke all on function public.m06_audit_page(uuid,text,uuid,text,text,timestamptz,timestamptz,timestamptz,uuid) from public,anon,authenticated;
grant execute on function public.m06_audit_page(uuid,text,uuid,text,text,timestamptz,timestamptz,timestamptz,uuid) to service_role;
commit;
