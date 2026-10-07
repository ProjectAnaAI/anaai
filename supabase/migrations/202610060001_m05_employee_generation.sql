-- M05 transactional employee-generation hardening. No data or interface changes.
begin;

create or replace function public.m05_assert_employee_identity(
  p_business_id uuid, p_employee_id uuid, p_device_id uuid, p_session_id uuid
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  employee_generation timestamptz;
begin
  select updated_at into employee_generation from public.employees
    where business_id = p_business_id and id = p_employee_id and is_active
    for share;
  if not found then
    raise exception 'Employee identity unavailable' using errcode = '42501';
  end if;
  perform 1 from public.zude_devices
    where business_id = p_business_id and id = p_device_id and revoked_at is null
    for share;
  if not found then
    raise exception 'Employee identity unavailable' using errcode = '42501';
  end if;
  -- Mirrors M04 session validation (server/employee-identity.ts): a session
  -- is current only while it belongs to the device's latest PIN generation
  -- (zude_devices.updated_at), so a later PIN attempt on the device
  -- invalidates it even if its Lock never reached the server.
  perform 1 from public.employee_sessions s
    join public.zude_devices d on d.business_id = s.business_id and d.id = s.device_id
    where s.business_id = p_business_id and s.id = p_session_id
      and s.device_id = p_device_id and s.employee_id = p_employee_id
      and s.revoked_at is null and s.expires_at > clock_timestamp()
      and s.created_at = d.updated_at
      -- Match server/employee-identity.ts Date.parse comparison (milliseconds).
      -- Employee row is already locked through commit; equality is valid.
      and date_trunc('milliseconds', s.created_at) >= date_trunc('milliseconds', employee_generation)
    for share of s;
  if not found then
    raise exception 'Employee identity unavailable' using errcode = '42501';
  end if;
end;
$$;
revoke all on function public.m05_assert_employee_identity(uuid, uuid, uuid, uuid) from public, anon, authenticated, service_role;

commit;
