-- M06 Slice 4.1: atomic, service-only read tokens over immutable history.
-- No mutable state cache. Both index-backed heads share the calling statement
-- snapshot (STABLE SQL function). Original appends and correction commits
-- already update their history and effective projection in one transaction.
begin;
create function public.m06_ledger_read_versions(p_business_id uuid, p_employee_id uuid default null)
returns jsonb
language sql stable security invoker
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'employeeId', e.id,
    'originalWatermark', coalesce((
      select t.seq from public.employee_time_events t
      where t.business_id = p_business_id and t.employee_id = e.id
      order by t.seq desc limit 1
    ), 0)::text,
    'correctionRevision', coalesce((
      select c.revision from public.employee_time_corrections c
      where c.business_id = p_business_id and c.employee_id = e.id
      order by c.revision desc limit 1
    ), 0)::text
  ) order by e.id), '[]'::jsonb)
  from (
    select id from public.employees
    where business_id = p_business_id and (p_employee_id is null or id = p_employee_id)
    order by id limit 201
  ) e
$$;
revoke all on function public.m06_ledger_read_versions(uuid, uuid) from public, anon, authenticated;
grant execute on function public.m06_ledger_read_versions(uuid, uuid) to service_role;
comment on function public.m06_ledger_read_versions(uuid, uuid) is
  'Internal ledger read tokens. Service only; caller must authorize tenant and target. 201 rows detects the 200-employee roster bound.';
commit;
