-- M04: Team + registered device + PIN employee identity foundation.
--
-- Account authorization remains in public.business_members.
-- These tables do NOT replace Supabase Auth or business_members.
--
-- All three tables are application-server security tables. Native/web clients
-- do not receive direct anon/authenticated table privileges.
--
-- PIN plaintext, device credentials, and employee-session credentials are
-- never stored. The application server hashes those values before persistence.
--
-- Employees and devices are deactivated/revoked rather than deleted during
-- normal business operation. If the business itself is deleted, its M04
-- security data is tenant-owned and is deleted with it.
--
-- Auth-user actor references are historical attribution only. Deleting an auth
-- account must not destroy the operational record or block account deletion,
-- so actor references are nullable and use ON DELETE SET NULL.

begin;

-- ---------------------------------------------------------------------------
-- Employees
-- ---------------------------------------------------------------------------

create table public.employees (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  display_name text not null,
  role text not null default 'employee',
  pin_hash text not null,
  pin_salt text not null,
  is_active boolean not null default true,
  created_by_user_id uuid references auth.users(id) on delete set null,
  updated_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint employees_display_name_not_blank
    check (length(btrim(display_name)) > 0),

  constraint employees_role_check
    check (role in ('employee', 'manager', 'owner')),

  constraint employees_pin_hash_not_blank
    check (length(btrim(pin_hash)) > 0),

  constraint employees_pin_salt_not_blank
    check (length(btrim(pin_salt)) > 0),

  constraint employees_business_id_id_unique
    unique (business_id, id)
);

create index employees_business_id_idx
  on public.employees (business_id);

create index employees_business_active_idx
  on public.employees (business_id, is_active);

create index employees_created_by_user_id_idx
  on public.employees (created_by_user_id);

alter table public.employees enable row level security;

-- Intentionally no anon/authenticated policies.
--
-- employees contains PIN verification material and is therefore accessed only
-- by trusted application-server code after account and tenant authorization.


-- ---------------------------------------------------------------------------
-- Registered ZUDE devices
-- ---------------------------------------------------------------------------

create table public.zude_devices (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null,
  credential_hash text not null,
  credential_salt text not null,
  registered_by_user_id uuid references auth.users(id) on delete set null,
  registered_at timestamptz not null default now(),
  last_seen_at timestamptz,
  failed_pin_attempts integer not null default 0,
  last_failed_pin_at timestamptz,
  pin_locked_until timestamptz,
  revoked_at timestamptz,
  revoked_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint zude_devices_name_not_blank
    check (length(btrim(name)) > 0),

  constraint zude_devices_credential_hash_not_blank
    check (length(btrim(credential_hash)) > 0),

  constraint zude_devices_credential_salt_not_blank
    check (length(btrim(credential_salt)) > 0),

  constraint zude_devices_failed_pin_attempts_nonnegative
    check (failed_pin_attempts >= 0),

  constraint zude_devices_revocation_consistency
    check (
      (revoked_at is null and revoked_by_user_id is null)
      or
      revoked_at is not null
    ),

  constraint zude_devices_business_id_id_unique
    unique (business_id, id)
);

create index zude_devices_business_id_idx
  on public.zude_devices (business_id);

create index zude_devices_business_active_idx
  on public.zude_devices (business_id, revoked_at);

create index zude_devices_pin_lock_idx
  on public.zude_devices (pin_locked_until)
  where revoked_at is null;

alter table public.zude_devices enable row level security;

-- Intentionally no anon/authenticated policies.
--
-- Device credentials and PIN-attempt state are server security primitives.
-- Device registration/revocation endpoints authenticate the account first,
-- then perform these operations through trusted server code.


-- ---------------------------------------------------------------------------
-- Employee sessions
-- ---------------------------------------------------------------------------

create table public.employee_sessions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  device_id uuid not null,
  employee_id uuid not null,
  token_hash text not null,
  token_salt text not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  expires_at timestamptz not null,
  revoked_at timestamptz,

  constraint employee_sessions_token_hash_not_blank
    check (length(btrim(token_hash)) > 0),

  constraint employee_sessions_token_salt_not_blank
    check (length(btrim(token_salt)) > 0),

  constraint employee_sessions_expiry_after_creation
    check (expires_at > created_at),

  constraint employee_sessions_business_device_fkey
    foreign key (business_id, device_id)
    references public.zude_devices (business_id, id)
    on delete cascade,

  constraint employee_sessions_business_employee_fkey
    foreign key (business_id, employee_id)
    references public.employees (business_id, id)
    on delete cascade
);

create index employee_sessions_business_id_idx
  on public.employee_sessions (business_id);

create index employee_sessions_device_id_idx
  on public.employee_sessions (device_id);

create index employee_sessions_employee_id_idx
  on public.employee_sessions (employee_id);

create index employee_sessions_active_expiry_idx
  on public.employee_sessions (expires_at)
  where revoked_at is null;

alter table public.employee_sessions enable row level security;

-- Intentionally no anon/authenticated policies.
--
-- Employee sessions are opaque application-server credentials. Native clients
-- receive only the issued opaque session credential and never enumerate or
-- mutate session rows through the Supabase client API.


-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke all on table public.employees from anon, authenticated;
revoke all on table public.zude_devices from anon, authenticated;
revoke all on table public.employee_sessions from anon, authenticated;

-- The application server accesses these tables with its server-only Supabase
-- service client after independently validating the request's authenticated
-- account, business membership, role, device credential, or employee session
-- as appropriate.

-- PIN uniqueness must survive concurrent server workers. Node still performs
-- salted scrypt verification. This server-only commit boundary locks the tenant,
-- checks that the verified active PIN snapshot is unchanged, then writes once.
create function public.m04_write_employee(
  p_business_id uuid, p_actor_id uuid, p_employee_id uuid,
  p_expected_updated_at timestamptz, p_pin_snapshot jsonb, p_values jsonb
) returns setof public.employees
language plpgsql security invoker set search_path = '' as $$
declare
  actor_role text;
  existing public.employees;
  current_snapshot jsonb;
  expected_snapshot jsonb;
  next_role text;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_business_id::text, 404));
  select role into actor_role from public.business_members
    where business_id = p_business_id and user_id = p_actor_id;
  if actor_role is null or actor_role not in ('owner', 'manager') then
    raise exception 'Team authority unavailable' using errcode = '42501';
  end if;
  if p_employee_id is not null then
    select * into existing from public.employees
      where business_id = p_business_id and id = p_employee_id for update;
    if not found or existing.updated_at is distinct from p_expected_updated_at then
      raise exception 'Team changed; retry' using errcode = '40001';
    end if;
    if actor_role = 'manager' and existing.role <> 'employee' then
      raise exception 'Team authority unavailable' using errcode = '42501';
    end if;
  end if;
  next_role := coalesce(p_values->>'role', existing.role, 'employee');
  if actor_role = 'manager' and next_role <> 'employee' then
    raise exception 'Team authority unavailable' using errcode = '42501';
  end if;
  if p_employee_id is null or p_values ? 'pin_hash' then
    if p_pin_snapshot is null then
      raise exception 'PIN verification required' using errcode = '22023';
    end if;
    select coalesce(jsonb_agg(jsonb_build_object('id', id, 'pin_hash', pin_hash,
      'pin_salt', pin_salt) order by id), '[]'::jsonb) into current_snapshot
      from public.employees where business_id = p_business_id and is_active;
    select coalesce(jsonb_agg(value order by value->>'id'), '[]'::jsonb)
      into expected_snapshot from jsonb_array_elements(p_pin_snapshot);
    if current_snapshot <> expected_snapshot then
      raise exception 'Team changed; recheck PIN' using errcode = '40001';
    end if;
  end if;
  if p_employee_id is null then
    return query insert into public.employees
      (business_id, display_name, role, pin_hash, pin_salt, created_by_user_id, updated_by_user_id)
      values (p_business_id, p_values->>'display_name', next_role, p_values->>'pin_hash',
        p_values->>'pin_salt', p_actor_id, p_actor_id) returning *;
  else
    if not existing.is_active and coalesce((p_values->>'is_active')::boolean, false)
       and not (p_values ? 'pin_hash') then
      raise exception 'Fresh PIN required' using errcode = '22023';
    end if;
    -- A single transaction invalidates old identity before any role/PIN or
    -- activation change. Reactivation cannot resurrect old sessions.
    update public.employee_sessions set revoked_at = clock_timestamp()
      where business_id = p_business_id and employee_id = p_employee_id and revoked_at is null;
    return query update public.employees set
      display_name = coalesce(p_values->>'display_name', existing.display_name),
      role = next_role,
      is_active = coalesce((p_values->>'is_active')::boolean, existing.is_active),
      pin_hash = coalesce(p_values->>'pin_hash', existing.pin_hash),
      pin_salt = coalesce(p_values->>'pin_salt', existing.pin_salt),
      updated_by_user_id = p_actor_id,
      updated_at = greatest(clock_timestamp(), existing.updated_at + interval '1 microsecond')
      where business_id = p_business_id and id = p_employee_id returning *;
  end if;
end;
$$;
revoke all on function public.m04_write_employee(uuid, uuid, uuid, timestamptz, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.m04_write_employee(uuid, uuid, uuid, timestamptz, jsonb, jsonb) to service_role;

commit;