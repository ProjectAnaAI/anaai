-- M05: Employee Time Clock + My Time.
--
-- Builds on M04 identity (employees, zude_devices, employee_sessions). The M04
-- migration is unchanged.
--
-- employee_time_events is an APPEND-ONLY ledger and the only authority for
-- whether an employee is clocked in or on break. There is no mutable "current
-- status" column: state is the latest event (by seq) for the employee.
--
-- Writes happen only through m05_record_time_event(), which:
--   * serializes per business+employee with a transaction advisory lock,
--   * re-verifies the employee, device and employee session inside the
--     transaction,
--   * derives the current state from the ledger and rejects invalid
--     transitions,
--   * stamps occurred_at from the database clock (never the client's),
--   * is idempotent per client request key.
--
-- PIN unlock, Lock, app background, session expiry, device revocation and
-- account sign-out never write here. Only an explicit employee action does.
--
-- Clients (anon/authenticated) have no table or function access. The
-- application server reads with its service client after M04 identity checks;
-- even the service role cannot insert, update or delete ledger rows directly.

begin;

-- ---------------------------------------------------------------------------
-- Time events (append-only ledger)
-- ---------------------------------------------------------------------------

create table public.employee_time_events (
  id uuid primary key default gen_random_uuid(),
  -- Total order of an employee's events. Writes for one employee are
  -- serialized by the advisory lock, so seq order is commit order.
  seq bigint generated always as identity,
  business_id uuid not null references public.businesses(id) on delete cascade,
  employee_id uuid not null,
  device_id uuid,
  event_type text not null,
  break_type text,
  occurred_at timestamptz not null,
  request_id uuid not null,
  source text not null default 'device_pin',
  created_at timestamptz not null default now(),

  constraint employee_time_events_event_type_check
    check (event_type in ('CLOCK_IN', 'BREAK_START', 'BREAK_END', 'CLOCK_OUT')),

  -- BREAK_START and BREAK_END both carry the break type (BREAK_END copies the
  -- open break's type), so every break interval is auditable from either end.
  -- CLOCK_IN / CLOCK_OUT never carry one. coalesce() keeps the expression
  -- strictly true/false: a NULL result would let a CHECK pass.
  constraint employee_time_events_break_type_check
    check (
      (event_type in ('BREAK_START', 'BREAK_END') and coalesce(break_type in ('PAID', 'MEAL'), false))
      or
      (event_type in ('CLOCK_IN', 'CLOCK_OUT') and break_type is null)
    ),

  -- M05 events always come from a PIN-verified employee on a registered
  -- device. M06 corrections must add their own source value deliberately.
  constraint employee_time_events_source_check
    check (source = 'device_pin' and device_id is not null),

  -- An event never references an employee or device of another business.
  -- NO ACTION (not cascade): hard-deleting an employee or device with history
  -- fails; deleting the whole business still removes its tenant data.
  constraint employee_time_events_business_employee_fkey
    foreign key (business_id, employee_id)
    references public.employees (business_id, id),

  constraint employee_time_events_business_device_fkey
    foreign key (business_id, device_id)
    references public.zude_devices (business_id, id),

  -- One retry-safe key per employee action. Clock-out from a break writes
  -- BREAK_END + CLOCK_OUT under the same key, distinguished by event_type.
  constraint employee_time_events_request_unique
    unique (business_id, employee_id, request_id, event_type),

  constraint employee_time_events_business_employee_id_unique
    unique (business_id, employee_id, id)
);

-- Latest event (current state) for a business + employee.
create index employee_time_events_employee_seq_idx
  on public.employee_time_events (business_id, employee_id, seq desc);

-- Employee current-week history.
create index employee_time_events_employee_time_idx
  on public.employee_time_events (business_id, employee_id, occurred_at);

-- Later (M06) manager business/time-range queries.
create index employee_time_events_business_time_idx
  on public.employee_time_events (business_id, occurred_at);

create index employee_time_events_device_idx
  on public.employee_time_events (business_id, device_id);

alter table public.employee_time_events enable row level security;

-- Intentionally no anon/authenticated policies.

-- The ledger is immutable: no UPDATE, no TRUNCATE, and no DELETE except as
-- part of deleting the whole business.
create function public.m05_time_events_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'employee_time_events is append-only' using errcode = '42501';
end;
$$;
revoke all on function public.m05_time_events_immutable() from public, anon, authenticated, service_role;

create trigger employee_time_events_no_update
  before update on public.employee_time_events
  for each row execute function public.m05_time_events_immutable();

create trigger employee_time_events_no_truncate
  before truncate on public.employee_time_events
  for each statement execute function public.m05_time_events_immutable();

-- DELETE is refused while the event's business still exists. Deleting the
-- business (the tenant-deletion contract) cascades here; PostgreSQL fires this
-- row trigger during that cascade too, but only after the business row is
-- deleted, so the cascade proceeds while any direct DELETE fails, whatever
-- privileges a role is later granted. SECURITY DEFINER so the existence check
-- cannot be hidden by the caller's RLS or privileges.
create function public.m05_time_events_delete_guard()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.businesses where id = old.business_id) then
    raise exception 'employee_time_events is append-only' using errcode = '42501';
  end if;
  return old;
end;
$$;
revoke all on function public.m05_time_events_delete_guard() from public, anon, authenticated, service_role;

create trigger employee_time_events_no_delete
  before delete on public.employee_time_events
  for each row execute function public.m05_time_events_delete_guard();


-- ---------------------------------------------------------------------------
-- Time issue reports (employee -> manager, resolved in M06)
-- ---------------------------------------------------------------------------

create table public.employee_time_issues (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  employee_id uuid not null,
  device_id uuid not null,
  work_date date,
  time_event_id uuid,
  note text not null,
  status text not null default 'open',
  request_id uuid not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by_user_id uuid references auth.users(id) on delete set null,
  resolution_note text,

  constraint employee_time_issues_note_check
    check (length(btrim(note)) between 1 and 1000),

  constraint employee_time_issues_status_check
    check (
      (status = 'open' and resolved_at is null and resolved_by_user_id is null and resolution_note is null)
      or
      (status = 'resolved' and resolved_at is not null)
    ),

  constraint employee_time_issues_business_employee_fkey
    foreign key (business_id, employee_id)
    references public.employees (business_id, id),

  constraint employee_time_issues_business_device_fkey
    foreign key (business_id, device_id)
    references public.zude_devices (business_id, id),

  -- An optional referenced event must be the SAME employee's, same business.
  constraint employee_time_issues_event_fkey
    foreign key (business_id, employee_id, time_event_id)
    references public.employee_time_events (business_id, employee_id, id),

  constraint employee_time_issues_request_unique
    unique (business_id, employee_id, request_id)
);

create index employee_time_issues_employee_idx
  on public.employee_time_issues (business_id, employee_id, created_at);

create index employee_time_issues_open_idx
  on public.employee_time_issues (business_id, created_at)
  where status = 'open';

create index employee_time_issues_device_idx
  on public.employee_time_issues (business_id, device_id);

alter table public.employee_time_issues enable row level security;

-- Intentionally no anon/authenticated policies.


-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke all on table public.employee_time_events from public, anon, authenticated, service_role;
revoke all on table public.employee_time_issues from public, anon, authenticated, service_role;

-- The server reads with its service client after M04 identity verification.
-- All writes go through the functions below.
grant select on table public.employee_time_events to service_role;
grant select on table public.employee_time_issues to service_role;


-- ---------------------------------------------------------------------------
-- Identity re-verification inside the write transaction
-- ---------------------------------------------------------------------------

-- The application server has already verified the device credential and the
-- employee session. This re-checks, under row locks, that nothing changed
-- before the write commits (deactivation, device revocation, Lock, expiry).
-- FOR SHARE blocks a concurrent Team change / revocation until commit.
create function public.m05_assert_employee_identity(
  p_business_id uuid, p_employee_id uuid, p_device_id uuid, p_session_id uuid
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.employees
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
    for share of s;
  if not found then
    raise exception 'Employee identity unavailable' using errcode = '42501';
  end if;
end;
$$;
revoke all on function public.m05_assert_employee_identity(uuid, uuid, uuid, uuid) from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- State transitions
-- ---------------------------------------------------------------------------

-- Actions: CLOCK_IN, BREAK_START (p_break_type PAID | MEAL), BREAK_END,
-- CLOCK_OUT. Clocking out while on a break writes BREAK_END then CLOCK_OUT at
-- the same occurred_at in one transaction.
--
-- Returns jsonb:
--   { ok: true,  replayed: false, state }   new event(s) written
--   { ok: true,  replayed: true,  state }   this request key already recorded
--   { ok: false, code: 'TIME_INVALID_TRANSITION', state }
--   { ok: false, code: 'TIME_REQUEST_CONFLICT',  state }  key reused for a
--                                                         different action
-- Raises 22023 for malformed input and 42501 when identity is unavailable.
create function public.m05_record_time_event(
  p_business_id uuid, p_employee_id uuid, p_device_id uuid, p_session_id uuid,
  p_action text, p_break_type text, p_request_id uuid
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  latest public.employee_time_events;
  current_state text;
  next_state text;
  replayed text[];
  replayed_break text;
  stamp timestamptz;
begin
  if p_business_id is null or p_employee_id is null or p_device_id is null
     or p_session_id is null or p_request_id is null
     or p_action is null
     or p_action not in ('CLOCK_IN', 'BREAK_START', 'BREAK_END', 'CLOCK_OUT')
     or (p_action = 'BREAK_START') <> (p_break_type is not null)
     or (p_break_type is not null and p_break_type not in ('PAID', 'MEAL')) then
    raise exception 'Invalid time action' using errcode = '22023';
  end if;

  -- One writer per business + employee at a time, across all devices and
  -- server workers. Held until commit.
  perform pg_advisory_xact_lock(
    hashtextextended('zude:m05:time:' || p_business_id::text || ':' || p_employee_id::text, 505)
  );

  perform public.m05_assert_employee_identity(p_business_id, p_employee_id, p_device_id, p_session_id);

  select * into latest from public.employee_time_events
    where business_id = p_business_id and employee_id = p_employee_id
    order by seq desc limit 1;

  current_state := case
    when latest.id is null or latest.event_type = 'CLOCK_OUT' then 'OFF_CLOCK'
    when latest.event_type = 'BREAK_START' and latest.break_type = 'PAID' then 'ON_PAID_BREAK'
    when latest.event_type = 'BREAK_START' then 'ON_MEAL_BREAK'
    else 'WORKING'
  end;

  -- Idempotent retry: the same request key for the same action is a success
  -- that writes nothing. A key reused for another action is refused.
  select array_agg(event_type order by seq), max(break_type) filter (where event_type = 'BREAK_START')
    into replayed, replayed_break
    from public.employee_time_events
    where business_id = p_business_id and employee_id = p_employee_id and request_id = p_request_id;
  if replayed is not null then
    if (p_action = 'CLOCK_OUT' and 'CLOCK_OUT' = any(replayed))
       or (p_action <> 'CLOCK_OUT' and replayed = array[p_action]
           and (p_action <> 'BREAK_START' or replayed_break = p_break_type)) then
      return jsonb_build_object('ok', true, 'replayed', true, 'state', current_state);
    end if;
    return jsonb_build_object('ok', false, 'code', 'TIME_REQUEST_CONFLICT', 'state', current_state);
  end if;

  if (p_action = 'CLOCK_IN' and current_state <> 'OFF_CLOCK')
     or (p_action = 'BREAK_START' and current_state <> 'WORKING')
     or (p_action = 'BREAK_END' and current_state not in ('ON_PAID_BREAK', 'ON_MEAL_BREAK'))
     or (p_action = 'CLOCK_OUT' and current_state = 'OFF_CLOCK') then
    return jsonb_build_object('ok', false, 'code', 'TIME_INVALID_TRANSITION', 'state', current_state);
  end if;

  -- Database time, never earlier than the employee's previous event.
  stamp := greatest(clock_timestamp(), latest.occurred_at);

  if current_state in ('ON_PAID_BREAK', 'ON_MEAL_BREAK') and p_action in ('BREAK_END', 'CLOCK_OUT') then
    insert into public.employee_time_events
      (business_id, employee_id, device_id, event_type, break_type, occurred_at, request_id)
      values (p_business_id, p_employee_id, p_device_id, 'BREAK_END', latest.break_type, stamp, p_request_id);
  end if;
  if p_action <> 'BREAK_END' then
    insert into public.employee_time_events
      (business_id, employee_id, device_id, event_type, break_type, occurred_at, request_id)
      values (p_business_id, p_employee_id, p_device_id, p_action, p_break_type, stamp, p_request_id);
  end if;

  next_state := case p_action
    when 'CLOCK_IN' then 'WORKING'
    when 'BREAK_END' then 'WORKING'
    when 'CLOCK_OUT' then 'OFF_CLOCK'
    else case p_break_type when 'PAID' then 'ON_PAID_BREAK' else 'ON_MEAL_BREAK' end
  end;
  return jsonb_build_object('ok', true, 'replayed', false, 'state', next_state);
end;
$$;
revoke all on function public.m05_record_time_event(uuid, uuid, uuid, uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.m05_record_time_event(uuid, uuid, uuid, uuid, text, text, uuid) to service_role;


-- ---------------------------------------------------------------------------
-- Time issue reports
-- ---------------------------------------------------------------------------

-- Records an employee's own report. Never edits the ledger.
--
-- Idempotent per request key, mirroring m05_record_time_event:
--   { ok: true,  replayed: false, issue }  new report
--   { ok: true,  replayed: true,  issue }  same key, same note/day/event
--   { ok: false, code: 'TIME_REQUEST_CONFLICT' }  same key, different payload
-- The insert-then-compare order is race safe: the unique constraint decides
-- which concurrent request owns the key.
create function public.m05_report_time_issue(
  p_business_id uuid, p_employee_id uuid, p_device_id uuid, p_session_id uuid,
  p_request_id uuid, p_work_date date, p_time_event_id uuid, p_note text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  issue public.employee_time_issues;
  inserted uuid;
  v_note text := btrim(p_note);
begin
  if p_business_id is null or p_employee_id is null or p_device_id is null
     or p_session_id is null or p_request_id is null or p_note is null
     or length(v_note) not between 1 and 1000 then
    raise exception 'Invalid time issue' using errcode = '22023';
  end if;
  perform public.m05_assert_employee_identity(p_business_id, p_employee_id, p_device_id, p_session_id);
  if p_time_event_id is not null and not exists (
    select 1 from public.employee_time_events
      where business_id = p_business_id and employee_id = p_employee_id and id = p_time_event_id
  ) then
    raise exception 'Invalid time issue' using errcode = '22023';
  end if;
  insert into public.employee_time_issues
    (business_id, employee_id, device_id, work_date, time_event_id, note, request_id)
    values (p_business_id, p_employee_id, p_device_id, p_work_date, p_time_event_id, v_note, p_request_id)
    on conflict (business_id, employee_id, request_id) do nothing
    returning id into inserted;
  select * into issue from public.employee_time_issues
    where business_id = p_business_id and employee_id = p_employee_id and request_id = p_request_id;
  if inserted is null and (issue.note is distinct from v_note
     or issue.work_date is distinct from p_work_date
     or issue.time_event_id is distinct from p_time_event_id) then
    return jsonb_build_object('ok', false, 'code', 'TIME_REQUEST_CONFLICT');
  end if;
  return jsonb_build_object('ok', true, 'replayed', inserted is null, 'issue', jsonb_build_object(
    'id', issue.id, 'work_date', issue.work_date, 'time_event_id', issue.time_event_id,
    'note', issue.note, 'status', issue.status, 'created_at', issue.created_at));
end;
$$;
revoke all on function public.m05_report_time_issue(uuid, uuid, uuid, uuid, uuid, date, uuid, text) from public, anon, authenticated;
grant execute on function public.m05_report_time_issue(uuid, uuid, uuid, uuid, uuid, date, uuid, text) to service_role;

commit;
