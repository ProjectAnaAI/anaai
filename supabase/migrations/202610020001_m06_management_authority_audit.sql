-- M06 Slice 1 ONLY. Forward migration; no changes to M04/M05 ledger data.
-- Deploy together with the updated Team API: the old RPC signature is removed.
begin;

create table public.employee_management_actions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  subject_employee_id uuid not null,
  -- Historical identifiers intentionally survive auth-user/session deletion.
  -- No credentials, PINs, verification hashes or salts are stored here.
  actor_user_id uuid not null,
  authority_mode text not null check (authority_mode in ('account','shared-device')),
  actor_employee_id uuid,
  actor_device_id uuid,
  actor_session_id uuid,
  actor_name_snapshot text,
  account_role text not null check (account_role in ('manager','owner')),
  effective_role text not null check (effective_role in ('manager','owner')),
  action text not null check (action in ('employee.created','employee.updated','employee.deactivated','employee.reactivated','employee.pin_reset')),
  pin_reset boolean not null default false,
  before_value jsonb,
  after_value jsonb not null,
  recorded_at timestamptz not null default clock_timestamp(),
  constraint employee_management_actions_subject_fk foreign key (business_id,subject_employee_id)
    references public.employees(business_id,id),
  constraint employee_management_actions_actor_fk foreign key (business_id,actor_employee_id)
    references public.employees(business_id,id),
  constraint employee_management_actions_device_fk foreign key (business_id,actor_device_id)
    references public.zude_devices(business_id,id),
  constraint employee_management_actions_mode_check check (
    (authority_mode='account' and actor_employee_id is null and actor_device_id is null and actor_session_id is null and actor_name_snapshot is null)
    or (authority_mode='shared-device' and actor_employee_id is not null and actor_device_id is not null and actor_session_id is not null and actor_name_snapshot is not null)
  ),
  constraint employee_management_actions_snapshot_check check (
    (before_value is null or jsonb_typeof(before_value)='object') and jsonb_typeof(after_value)='object'
    and (before_value is null or before_value - array['display_name','role','is_active']::text[] = '{}'::jsonb)
    and after_value - array['display_name','role','is_active']::text[] = '{}'::jsonb
  )
);
create index employee_management_actions_business_time_idx
  on public.employee_management_actions(business_id,recorded_at desc,id);
create index employee_management_actions_subject_time_idx
  on public.employee_management_actions(business_id,subject_employee_id,recorded_at desc,id);
alter table public.employee_management_actions enable row level security;
-- No client policies: all authorization happens at verified server boundaries.
revoke all on public.employee_management_actions from public,anon,authenticated,service_role;
grant select on public.employee_management_actions to service_role;

create function public.m06_management_actions_immutable() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_op='DELETE' then
    if not exists(select 1 from public.businesses where id=old.business_id) then return old; end if;
  end if;
  raise exception 'Management history is immutable' using errcode='42501';
end;
$$;
revoke all on function public.m06_management_actions_immutable() from public,anon,authenticated,service_role;
create trigger employee_management_actions_no_update before update on public.employee_management_actions
  for each row execute function public.m06_management_actions_immutable();
create trigger employee_management_actions_no_delete before delete on public.employee_management_actions
  for each row execute function public.m06_management_actions_immutable();
create trigger employee_management_actions_no_truncate before truncate on public.employee_management_actions
  for each statement execute function public.m06_management_actions_immutable();

-- Internal revalidation of IDs already cryptographically verified by the API.
-- Not callable by clients or service_role on its own. Rows stay locked through
-- the mutation/audit commit, preventing authority changes after this check.
create function public.m06_assert_management_actor(
  p_business_id uuid,p_actor_id uuid,p_authority_mode text,p_expected_account_role text,
  p_actor_employee_id uuid,p_actor_device_id uuid,p_actor_session_id uuid
) returns table(effective_role text,actor_name text)
language plpgsql security definer set search_path='' as $$
declare
  membership_role text;
  employee public.employees;
  device public.zude_devices;
  session public.employee_sessions;
begin
  if p_business_id is null or p_actor_id is null or p_authority_mode is null
    or p_authority_mode not in ('account','shared-device') then
    raise exception 'Management authority unavailable' using errcode='42501';
  end if;
  select role into membership_role from public.business_members
    where business_id=p_business_id and user_id=p_actor_id for share;
  if membership_role is null or membership_role not in ('owner','manager')
    or membership_role is distinct from p_expected_account_role then
    raise exception 'Management authority unavailable' using errcode='42501';
  end if;
  if p_authority_mode='account' then
    if p_actor_employee_id is not null or p_actor_device_id is not null or p_actor_session_id is not null then
      raise exception 'Management authority unavailable' using errcode='42501';
    end if;
    return query select membership_role,null::text;
    return;
  end if;
  if p_actor_employee_id is null or p_actor_device_id is null or p_actor_session_id is null then
    raise exception 'Management authority unavailable' using errcode='42501';
  end if;
  -- Same employee -> device -> session lock order as M05's identity assertion.
  select * into employee from public.employees
    where business_id=p_business_id and id=p_actor_employee_id for share;
  if not found or not employee.is_active then
    raise exception 'Employee identity unavailable' using errcode='28000';
  end if;
  select * into device from public.zude_devices
    where business_id=p_business_id and id=p_actor_device_id for share;
  if not found or device.revoked_at is not null then
    raise exception 'Employee identity unavailable' using errcode='28000';
  end if;
  select * into session from public.employee_sessions
    where business_id=p_business_id and id=p_actor_session_id
      and employee_id=p_actor_employee_id and device_id=p_actor_device_id for share;
  if not found or session.revoked_at is not null or session.expires_at<=clock_timestamp()
    or session.created_at is distinct from device.updated_at or employee.updated_at>session.created_at then
    raise exception 'Employee identity unavailable' using errcode='28000';
  end if;
  if employee.role not in ('owner','manager') then
    raise exception 'Management authority unavailable' using errcode='42501';
  end if;
  return query select case when membership_role='owner' and employee.role='owner' then 'owner' else 'manager' end,employee.display_name;
end;
$$;
revoke all on function public.m06_assert_management_actor(uuid,uuid,text,text,uuid,uuid,uuid) from public,anon,authenticated,service_role;

-- Eliminate the old account-only commit path; no executable legacy overload.
drop function public.m04_write_employee(uuid,uuid,uuid,timestamptz,jsonb,jsonb);
-- Employee writes now require the audited definer boundary. Reads are needed
-- by existing PIN verification and identity validation, which are unchanged.
revoke insert,update,delete,truncate,references,trigger on public.employees from public,anon,authenticated,service_role;
grant select on public.employees to service_role;

create function public.m04_write_employee(
  p_business_id uuid,p_actor_id uuid,p_employee_id uuid,
  p_expected_updated_at timestamptz,p_pin_snapshot jsonb,p_values jsonb,
  p_authority_mode text,p_expected_account_role text,
  p_actor_employee_id uuid,p_actor_device_id uuid,p_actor_session_id uuid
) returns setof public.employees
language plpgsql security definer set search_path='' as $$
declare
  actor_role text;
  actor_name text;
  existing public.employees;
  written public.employees;
  current_snapshot jsonb;
  expected_snapshot jsonb;
  next_role text;
  action_name text;
begin
  -- Preserve M04's tenant lock and PIN snapshot protocol. All Team writes use
  -- this lock before actor/target rows, including self-edits.
  perform pg_advisory_xact_lock(hashtextextended(p_business_id::text,404));
  select a.effective_role,a.actor_name into actor_role,actor_name from public.m06_assert_management_actor(
    p_business_id,p_actor_id,p_authority_mode,p_expected_account_role,
    p_actor_employee_id,p_actor_device_id,p_actor_session_id) a;

  if p_values is null or jsonb_typeof(p_values)<>'object' or p_values='{}'::jsonb
    or p_values - array['business_id','display_name','role','pin_hash','pin_salt','is_active','created_by_user_id','updated_by_user_id','updated_at']::text[] <> '{}'::jsonb
    or (p_values ? 'business_id' and p_values->>'business_id' is distinct from p_business_id::text)
    or (p_values ? 'created_by_user_id' and p_values->>'created_by_user_id' is distinct from p_actor_id::text)
    or (p_values ? 'updated_by_user_id' and p_values->>'updated_by_user_id' is distinct from p_actor_id::text)
    or (p_values ? 'display_name' and (jsonb_typeof(p_values->'display_name')<>'string' or length(btrim(p_values->>'display_name')) not between 1 and 100))
    or (p_values ? 'role' and (jsonb_typeof(p_values->'role')<>'string' or p_values->>'role' not in ('employee','manager','owner')))
    or (p_values ? 'is_active' and jsonb_typeof(p_values->'is_active')<>'boolean')
    or (p_values ? 'pin_hash') <> (p_values ? 'pin_salt')
    or (p_values ? 'pin_hash' and (jsonb_typeof(p_values->'pin_hash')<>'string' or jsonb_typeof(p_values->'pin_salt')<>'string'
      or length(btrim(p_values->>'pin_hash'))=0 or length(btrim(p_values->>'pin_salt'))=0)) then
    raise exception 'Invalid Team change' using errcode='22023';
  end if;
  if p_employee_id is not null then
    select * into existing from public.employees where business_id=p_business_id and id=p_employee_id for update;
    if not found then raise exception 'Team changed; retry' using errcode='40001'; end if;
    -- Check current role BEFORE version, so target promotion never weakens hierarchy.
    if actor_role='manager' and existing.role<>'employee' then
      raise exception 'Team authority unavailable' using errcode='42501';
    end if;
    if existing.updated_at is distinct from p_expected_updated_at then
      raise exception 'Team changed; retry' using errcode='40001';
    end if;
  elsif not (p_values ? 'display_name' and p_values ? 'pin_hash' and p_values ? 'role') then
    raise exception 'Invalid Team change' using errcode='22023';
  end if;
  next_role:=coalesce(p_values->>'role',existing.role,'employee');
  if actor_role='manager' and next_role<>'employee' then
    raise exception 'Team authority unavailable' using errcode='42501';
  end if;
  if p_employee_id is null or p_values ? 'pin_hash' then
    if p_pin_snapshot is null or jsonb_typeof(p_pin_snapshot)<>'array' then
      raise exception 'PIN verification required' using errcode='22023';
    end if;
    select coalesce(jsonb_agg(jsonb_build_object('id',id,'pin_hash',pin_hash,'pin_salt',pin_salt) order by id),'[]'::jsonb)
      into current_snapshot from public.employees where business_id=p_business_id and is_active;
    select coalesce(jsonb_agg(value order by value->>'id'),'[]'::jsonb)
      into expected_snapshot from jsonb_array_elements(p_pin_snapshot);
    if current_snapshot<>expected_snapshot then
      raise exception 'Team changed; recheck PIN' using errcode='40001';
    end if;
  end if;
  if p_employee_id is null then
    insert into public.employees(business_id,display_name,role,pin_hash,pin_salt,created_by_user_id,updated_by_user_id)
      values(p_business_id,btrim(p_values->>'display_name'),next_role,p_values->>'pin_hash',p_values->>'pin_salt',p_actor_id,p_actor_id)
      returning * into written;
    action_name:='employee.created';
  else
    if not existing.is_active and coalesce((p_values->>'is_active')::boolean,false) and not (p_values ? 'pin_hash') then
      raise exception 'Fresh PIN required' using errcode='22023';
    end if;
    update public.employee_sessions set revoked_at=clock_timestamp()
      where business_id=p_business_id and employee_id=p_employee_id and revoked_at is null;
    update public.employees set
      display_name=coalesce(btrim(p_values->>'display_name'),existing.display_name),role=next_role,
      is_active=coalesce((p_values->>'is_active')::boolean,existing.is_active),
      pin_hash=coalesce(p_values->>'pin_hash',existing.pin_hash),pin_salt=coalesce(p_values->>'pin_salt',existing.pin_salt),
      updated_by_user_id=p_actor_id,updated_at=greatest(clock_timestamp(),existing.updated_at+interval '1 microsecond')
      where business_id=p_business_id and id=p_employee_id returning * into written;
    action_name:=case when existing.is_active and not written.is_active then 'employee.deactivated'
      when not existing.is_active and written.is_active then 'employee.reactivated'
      when p_values ? 'pin_hash' then 'employee.pin_reset' else 'employee.updated' end;
  end if;
  -- Whitelist-built snapshots, never to_jsonb(employee) or client JSON.
  insert into public.employee_management_actions(
    business_id,subject_employee_id,actor_user_id,authority_mode,actor_employee_id,actor_device_id,actor_session_id,
    actor_name_snapshot,account_role,effective_role,action,pin_reset,before_value,after_value)
  values(p_business_id,written.id,p_actor_id,p_authority_mode,p_actor_employee_id,p_actor_device_id,p_actor_session_id,
    actor_name,p_expected_account_role,actor_role,action_name,p_employee_id is not null and p_values ? 'pin_hash',
    case when p_employee_id is null then null else jsonb_build_object('display_name',existing.display_name,'role',existing.role,'is_active',existing.is_active) end,
    jsonb_build_object('display_name',written.display_name,'role',written.role,'is_active',written.is_active));
  return next written;
end;
$$;
revoke all on function public.m04_write_employee(uuid,uuid,uuid,timestamptz,jsonb,jsonb,text,text,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.m04_write_employee(uuid,uuid,uuid,timestamptz,jsonb,jsonb,text,text,uuid,uuid,uuid) to service_role;
commit;
