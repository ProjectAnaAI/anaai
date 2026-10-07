-- M06 Slice 4: immutable time corrections. Forward migration only.
--
-- History (immutable):
--   employee_time_events               M05 originals (unchanged, append-only)
--   employee_time_corrections          one row per committed correction batch
--   employee_time_correction_entries   INSERT / REPLACE / VOID operations
--
-- Interpretation (ONE definition): m06_time_fold replays the originals in seq
-- order, then every correction entry in (revision, ordinal) order:
--   INSERT  splices a new logical event immediately after an anchor event
--           (or at the start). Its logical id is the entry id.
--   REPLACE replaces occurred_at / break_type of one live logical event; its
--           position (and event type) never changes.
--   VOID    removes one live logical event; its slot remains a valid anchor.
-- Every result must be a valid M05 state machine (m06_time_next_state, also
-- used by m05_record_time_event), non-decreasing in time and never in the
-- future.
--
-- Projection (derived, never history): employee_time_effective_events holds
-- the live result with a dense effective order in `seq`. It is written only by
-- (a) the trigger appending each new M05 original at the end, under the M05
-- employee lock, and (b) a full rebuild from the fold when a correction
-- commits. Readers and m05_record_time_event use the projection, so Time Clock,
-- My Time, Who's Working, Timesheets and new clock actions share one
-- interpretation. For employees without corrections it equals the original
-- ledger exactly (same ids and seq).
begin;

-- ---------------------------------------------------------------------------
-- Shared M05 transition rule
-- ---------------------------------------------------------------------------
create function public.m06_time_next_state(p_state text, p_event_type text, p_break_type text)
returns text language sql immutable set search_path = '' as $$
  select case
    when p_state = 'OFF_CLOCK' and p_event_type = 'CLOCK_IN' and p_break_type is null then 'WORKING'
    when p_state = 'WORKING' and p_event_type = 'BREAK_START' and p_break_type = 'PAID' then 'ON_PAID_BREAK'
    when p_state = 'WORKING' and p_event_type = 'BREAK_START' and p_break_type = 'MEAL' then 'ON_MEAL_BREAK'
    when p_state = 'ON_PAID_BREAK' and p_event_type = 'BREAK_END' and p_break_type = 'PAID' then 'WORKING'
    when p_state = 'ON_MEAL_BREAK' and p_event_type = 'BREAK_END' and p_break_type = 'MEAL' then 'WORKING'
    when p_state = 'WORKING' and p_event_type = 'CLOCK_OUT' and p_break_type is null then 'OFF_CLOCK'
  end
$$;
revoke all on function public.m06_time_next_state(text, text, text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Correction history (immutable)
-- ---------------------------------------------------------------------------
create table public.employee_time_corrections (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  employee_id uuid not null,
  revision integer not null check (revision >= 1),
  -- Original-ledger watermark: max employee_time_events.seq the correction was
  -- validated against (0 = no originals).
  base_watermark bigint not null check (base_watermark >= 0),
  request_id uuid not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  reason text not null check (reason = btrim(reason) and length(reason) between 1 and 500),
  created_at timestamptz not null default clock_timestamp(),
  constraint employee_time_corrections_employee_fkey foreign key (business_id, employee_id)
    references public.employees (business_id, id),
  constraint employee_time_corrections_revision_unique unique (business_id, employee_id, revision),
  constraint employee_time_corrections_request_unique unique (business_id, employee_id, request_id),
  constraint employee_time_corrections_scoped_unique unique (business_id, employee_id, id)
);

create table public.employee_time_correction_entries (
  -- For INSERT, this id is the logical id of the inserted effective event.
  id uuid primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  employee_id uuid not null,
  correction_id uuid not null,
  ordinal integer not null check (ordinal between 1 and 20),
  operation text not null check (operation in ('INSERT', 'REPLACE', 'VOID')),
  target_event_id uuid,
  after_event_id uuid,
  at_start boolean not null default false,
  event_type text,
  break_type text,
  occurred_at timestamptz,
  constraint employee_time_correction_entries_correction_fkey foreign key (business_id, employee_id, correction_id)
    references public.employee_time_corrections (business_id, employee_id, id),
  constraint employee_time_correction_entries_ordinal_unique unique (correction_id, ordinal),
  constraint employee_time_correction_entries_shape_check check (
    (operation = 'INSERT' and target_event_id is null and occurred_at is not null
      and at_start = (after_event_id is null)
      and event_type in ('CLOCK_IN', 'BREAK_START', 'BREAK_END', 'CLOCK_OUT')
      and ((event_type in ('BREAK_START', 'BREAK_END') and coalesce(break_type in ('PAID', 'MEAL'), false))
        or (event_type in ('CLOCK_IN', 'CLOCK_OUT') and break_type is null)))
    or (operation = 'REPLACE' and target_event_id is not null and after_event_id is null and not at_start
      and event_type is null and occurred_at is not null and (break_type is null or break_type in ('PAID', 'MEAL')))
    or (operation = 'VOID' and target_event_id is not null and after_event_id is null and not at_start
      and event_type is null and break_type is null and occurred_at is null)
  )
);
create index employee_time_correction_entries_correction_idx
  on public.employee_time_correction_entries (business_id, employee_id, correction_id, ordinal);

alter table public.employee_time_corrections enable row level security;
alter table public.employee_time_correction_entries enable row level security;
revoke all on public.employee_time_corrections from public, anon, authenticated, service_role;
revoke all on public.employee_time_correction_entries from public, anon, authenticated, service_role;
grant select on public.employee_time_corrections to service_role;
grant select on public.employee_time_correction_entries to service_role;

-- Same contract as the M05 ledger and Slice 1 audit: no UPDATE/TRUNCATE, and
-- DELETE only as part of deleting the whole business.
create function public.m06_time_history_immutable() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' and not exists (select 1 from public.businesses where id = old.business_id) then
    return old;
  end if;
  raise exception 'Time correction history is immutable' using errcode = '42501';
end;
$$;
revoke all on function public.m06_time_history_immutable() from public, anon, authenticated, service_role;
create trigger employee_time_corrections_no_update before update on public.employee_time_corrections
  for each row execute function public.m06_time_history_immutable();
create trigger employee_time_corrections_no_delete before delete on public.employee_time_corrections
  for each row execute function public.m06_time_history_immutable();
create trigger employee_time_corrections_no_truncate before truncate on public.employee_time_corrections
  for each statement execute function public.m06_time_history_immutable();
create trigger employee_time_correction_entries_no_update before update on public.employee_time_correction_entries
  for each row execute function public.m06_time_history_immutable();
create trigger employee_time_correction_entries_no_delete before delete on public.employee_time_correction_entries
  for each row execute function public.m06_time_history_immutable();
create trigger employee_time_correction_entries_no_truncate before truncate on public.employee_time_correction_entries
  for each statement execute function public.m06_time_history_immutable();

-- ---------------------------------------------------------------------------
-- Effective projection (derived)
-- ---------------------------------------------------------------------------
create table public.employee_time_effective_events (
  -- Logical id: the original event id, or the INSERT entry id.
  id uuid primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  employee_id uuid not null,
  -- Effective order. Equals the original seq until a correction rebuilds the
  -- employee's projection (then dense 1..n); later originals append above.
  seq bigint not null,
  event_type text not null check (event_type in ('CLOCK_IN', 'BREAK_START', 'BREAK_END', 'CLOCK_OUT')),
  break_type text,
  occurred_at timestamptz not null,
  origin text not null check (origin in ('original', 'inserted')),
  original_event_id uuid,
  replaced boolean not null default false,
  correction_id uuid,
  correction_revision integer,
  constraint employee_time_effective_events_business_employee_fkey foreign key (business_id, employee_id)
    references public.employees (business_id, id),
  constraint employee_time_effective_events_original_fkey foreign key (business_id, employee_id, original_event_id)
    references public.employee_time_events (business_id, employee_id, id),
  constraint employee_time_effective_events_order_unique unique (business_id, employee_id, seq),
  constraint employee_time_effective_events_break_type_check check (
    (event_type in ('BREAK_START', 'BREAK_END') and coalesce(break_type in ('PAID', 'MEAL'), false))
    or (event_type in ('CLOCK_IN', 'CLOCK_OUT') and break_type is null)),
  constraint employee_time_effective_events_provenance_check check (
    (origin = 'original' and original_event_id = id)
    or (origin = 'inserted' and original_event_id is null and correction_id is not null and correction_revision is not null)),
  constraint employee_time_effective_events_correction_check check (
    (correction_id is null) = (correction_revision is null) and (not replaced or correction_id is not null))
);
create index employee_time_effective_events_employee_seq_idx
  on public.employee_time_effective_events (business_id, employee_id, seq desc);
create index employee_time_effective_events_employee_time_idx
  on public.employee_time_effective_events (business_id, employee_id, occurred_at);
create index employee_time_effective_events_business_time_idx
  on public.employee_time_effective_events (business_id, occurred_at);

-- Backfill: with no corrections, the effective ledger IS the original ledger.
insert into public.employee_time_effective_events
  (id, business_id, employee_id, seq, event_type, break_type, occurred_at, origin, original_event_id)
select id, business_id, employee_id, seq, event_type, break_type, occurred_at, 'original', id
from public.employee_time_events;

alter table public.employee_time_effective_events enable row level security;
revoke all on public.employee_time_effective_events from public, anon, authenticated, service_role;
grant select on public.employee_time_effective_events to service_role;

-- Writes are accepted only from the two maintenance paths below, which mark
-- the transaction for one business:employee. Defense in depth behind the
-- privileges above; deleting the business still cascades.
create function public.m06_effective_events_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  writer text := current_setting('zude.m06_effective_writer', true);
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'Effective time is maintained by ZUDE' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    if not exists (select 1 from public.businesses where id = old.business_id)
       or writer = old.business_id::text || ':' || old.employee_id::text then
      return old;
    end if;
  elsif writer = new.business_id::text || ':' || new.employee_id::text
     and (tg_op = 'INSERT' or (new.business_id = old.business_id and new.employee_id = old.employee_id)) then
    return new;
  end if;
  raise exception 'Effective time is maintained by ZUDE' using errcode = '42501';
end;
$$;
revoke all on function public.m06_effective_events_guard() from public, anon, authenticated, service_role;
create trigger employee_time_effective_events_guard before insert or update or delete on public.employee_time_effective_events
  for each row execute function public.m06_effective_events_guard();
create trigger employee_time_effective_events_no_truncate before truncate on public.employee_time_effective_events
  for each statement execute function public.m06_effective_events_guard();

-- Every new M05 original appends to the effective end. It runs inside
-- m05_record_time_event's transaction, under the per-employee lock. Corrections
-- only anchor to existing events, so the fold places later originals last too.
create function public.m06_effective_events_append() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform set_config('zude.m06_effective_writer', new.business_id::text || ':' || new.employee_id::text, true);
  insert into public.employee_time_effective_events
    (id, business_id, employee_id, seq, event_type, break_type, occurred_at, origin, original_event_id)
  values (new.id, new.business_id, new.employee_id,
    greatest(new.seq, coalesce((select max(seq) from public.employee_time_effective_events
      where business_id = new.business_id and employee_id = new.employee_id), 0) + 1),
    new.event_type, new.break_type, new.occurred_at, 'original', new.id);
  perform set_config('zude.m06_effective_writer', '', true);
  return null;
end;
$$;
revoke all on function public.m06_effective_events_append() from public, anon, authenticated, service_role;
create trigger employee_time_events_effective_append after insert on public.employee_time_events
  for each row execute function public.m06_effective_events_append();

-- ---------------------------------------------------------------------------
-- The fold (single interpretation)
-- ---------------------------------------------------------------------------
-- Raises SQLSTATE Z0001 with a fixed reason code (message) and the logical id
-- (detail) when an operation cannot apply. Never includes other data.
create function public.m06_time_fold_apply(
  inout p_ids uuid[], inout p_vals jsonb, inout p_voided uuid[],
  p_entry_id uuid, p_operation text, p_target uuid, p_after uuid, p_at_start boolean,
  p_event_type text, p_break_type text, p_occurred_at timestamptz,
  p_correction_id uuid, p_revision integer)
language plpgsql set search_path = '' as $$
declare
  pos integer;
  existing jsonb;
begin
  if p_operation = 'INSERT' then
    if p_at_start then
      pos := 0;
    else
      pos := array_position(p_ids, p_after);
      if pos is null then
        raise exception 'ANCHOR_NOT_FOUND' using errcode = 'Z0001', detail = coalesce(p_after::text, '');
      end if;
    end if;
    p_ids := p_ids[1:pos] || p_entry_id || p_ids[pos + 1:];
    p_vals := p_vals || jsonb_build_object(p_entry_id::text, jsonb_build_object(
      'event_type', p_event_type, 'break_type', p_break_type, 'occurred_at', p_occurred_at,
      'origin', 'inserted', 'replaced', false, 'correction_id', p_correction_id, 'revision', p_revision));
    return;
  end if;
  existing := p_vals -> p_target::text;
  if existing is null then
    raise exception 'TARGET_NOT_FOUND' using errcode = 'Z0001', detail = p_target::text;
  end if;
  if p_target = any(p_voided) then
    raise exception 'TARGET_VOIDED' using errcode = 'Z0001', detail = p_target::text;
  end if;
  if p_operation = 'VOID' then
    p_voided := p_voided || p_target;
    return;
  end if;
  -- REPLACE: same logical position and event type; new time / break type.
  if (existing ->> 'event_type') in ('BREAK_START', 'BREAK_END') then
    if p_break_type is null then p_break_type := existing ->> 'break_type'; end if;
  elsif p_break_type is not null then
    raise exception 'INVALID_OPERATION' using errcode = 'Z0001', detail = p_target::text;
  end if;
  p_vals := jsonb_set(p_vals, array[p_target::text], existing || jsonb_build_object(
    'occurred_at', p_occurred_at, 'break_type', p_break_type, 'replaced', true,
    'correction_id', p_correction_id, 'revision', p_revision));
end;
$$;
revoke all on function public.m06_time_fold_apply(uuid[], jsonb, uuid[], uuid, text, uuid, uuid, boolean, text, text, timestamptz, uuid, integer) from public, anon, authenticated, service_role;

-- Full logical sequence (including voided slots) from immutable history.
create function public.m06_time_fold(p_business_id uuid, p_employee_id uuid,
  out ids uuid[], out vals jsonb, out voided uuid[])
language plpgsql stable set search_path = '' as $$
declare
  entry record;
begin
  select coalesce(array_agg(e.id order by e.seq), '{}'),
         coalesce(jsonb_object_agg(e.id::text, jsonb_build_object(
           'event_type', e.event_type, 'break_type', e.break_type, 'occurred_at', e.occurred_at,
           'origin', 'original', 'replaced', false, 'correction_id', null, 'revision', null)), '{}')
    into ids, vals
    from public.employee_time_events e
    where e.business_id = p_business_id and e.employee_id = p_employee_id;
  voided := '{}';
  for entry in
    select en.*, c.revision from public.employee_time_correction_entries en
      join public.employee_time_corrections c
        on c.business_id = en.business_id and c.employee_id = en.employee_id and c.id = en.correction_id
      where en.business_id = p_business_id and en.employee_id = p_employee_id
      order by c.revision, en.ordinal
  loop
    select f.p_ids, f.p_vals, f.p_voided into ids, vals, voided
      from public.m06_time_fold_apply(ids, vals, voided, entry.id, entry.operation, entry.target_event_id,
        entry.after_event_id, entry.at_start, entry.event_type, entry.break_type, entry.occurred_at,
        entry.correction_id, entry.revision) f;
  end loop;
end;
$$;
revoke all on function public.m06_time_fold(uuid, uuid) from public, anon, authenticated, service_role;

-- Validates the live sequence with the M05 transition rule; returns the
-- resulting state. Effective time never decreases and is never in the future.
create function public.m06_time_validate(p_ids uuid[], p_vals jsonb, p_voided uuid[], p_now timestamptz)
returns text language plpgsql stable set search_path = '' as $$
declare
  state text := 'OFF_CLOCK';
  previous timestamptz;
  at timestamptz;
  v jsonb;
  logical uuid;
begin
  foreach logical in array p_ids loop
    continue when logical = any(p_voided);
    v := p_vals -> logical::text;
    at := (v ->> 'occurred_at')::timestamptz;
    if at > p_now then
      raise exception 'FUTURE_EVENT' using errcode = 'Z0001', detail = logical::text;
    end if;
    if previous is not null and at < previous then
      raise exception 'OUT_OF_ORDER' using errcode = 'Z0001', detail = logical::text;
    end if;
    state := public.m06_time_next_state(state, v ->> 'event_type', v ->> 'break_type');
    if state is null then
      raise exception 'INVALID_TRANSITION' using errcode = 'Z0001', detail = logical::text;
    end if;
    previous := at;
  end loop;
  return state;
end;
$$;
revoke all on function public.m06_time_validate(uuid[], jsonb, uuid[], timestamptz) from public, anon, authenticated, service_role;

-- Replaces one employee's projection with the fold result.
create function public.m06_time_write_projection(p_business_id uuid, p_employee_id uuid,
  p_ids uuid[], p_vals jsonb, p_voided uuid[])
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform set_config('zude.m06_effective_writer', p_business_id::text || ':' || p_employee_id::text, true);
  delete from public.employee_time_effective_events where business_id = p_business_id and employee_id = p_employee_id;
  insert into public.employee_time_effective_events
    (id, business_id, employee_id, seq, event_type, break_type, occurred_at, origin, original_event_id,
     replaced, correction_id, correction_revision)
  select u.id, p_business_id, p_employee_id, row_number() over (order by u.n),
    v ->> 'event_type', v ->> 'break_type', (v ->> 'occurred_at')::timestamptz, v ->> 'origin',
    case when v ->> 'origin' = 'original' then u.id end,
    (v ->> 'replaced')::boolean, (v ->> 'correction_id')::uuid, (v ->> 'revision')::integer
  from unnest(p_ids) with ordinality as u(id, n)
  cross join lateral (select p_vals -> u.id::text as v) x
  where not (u.id = any(p_voided));
  perform set_config('zude.m06_effective_writer', '', true);
end;
$$;
revoke all on function public.m06_time_write_projection(uuid, uuid, uuid[], jsonb, uuid[]) from public, anon, authenticated, service_role;

-- The Timesheet week window over the projection (same algorithm as
-- server/time-ledger.ts historicalLedger): whole shifts touching [from, to).
create function public.m06_effective_window(p_business_id uuid, p_employee_id uuid, p_from timestamptz, p_to timestamptz)
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
      into events from public.employee_time_effective_events
      where business_id = p_business_id and employee_id = p_employee_id and seq <= last_seq
        and (case when first_seq is null then occurred_at >= p_from else seq >= first_seq end);
  end if;
  return jsonb_build_object('events', events, 'head', jsonb_build_object(
    'id', head.id, 'seq', head.seq, 'event_type', head.event_type, 'break_type', head.break_type, 'occurred_at', head.occurred_at));
end;
$$;
revoke all on function public.m06_effective_window(uuid, uuid, timestamptz, timestamptz) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- M05 clock actions now validate against the effective ledger
-- ---------------------------------------------------------------------------
-- Same signature, grants, identity checks, lock, idempotency and database
-- timestamping as M05. Only two things change: the current state comes from
-- the effective projection (so a correction that closed a shift allows the
-- next real CLOCK_IN), and each event written is checked with the shared
-- m06_time_next_state rule. Real actions still write employee_time_events.
create or replace function public.m05_record_time_event(
  p_business_id uuid, p_employee_id uuid, p_device_id uuid, p_session_id uuid,
  p_action text, p_break_type text, p_request_id uuid
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  latest public.employee_time_effective_events;
  current_state text;
  next_state text;
  replayed text[];
  replayed_break text;
  stamp timestamptz;
  planned text[];
  planned_break text[];
  i integer;
begin
  if p_business_id is null or p_employee_id is null or p_device_id is null
     or p_session_id is null or p_request_id is null
     or p_action is null
     or p_action not in ('CLOCK_IN', 'BREAK_START', 'BREAK_END', 'CLOCK_OUT')
     or (p_action = 'BREAK_START') <> (p_break_type is not null)
     or (p_break_type is not null and p_break_type not in ('PAID', 'MEAL')) then
    raise exception 'Invalid time action' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('zude:m05:time:' || p_business_id::text || ':' || p_employee_id::text, 505)
  );

  perform public.m05_assert_employee_identity(p_business_id, p_employee_id, p_device_id, p_session_id);

  select * into latest from public.employee_time_effective_events
    where business_id = p_business_id and employee_id = p_employee_id
    order by seq desc limit 1;

  current_state := case
    when latest.id is null or latest.event_type = 'CLOCK_OUT' then 'OFF_CLOCK'
    when latest.event_type = 'BREAK_START' and latest.break_type = 'PAID' then 'ON_PAID_BREAK'
    when latest.event_type = 'BREAK_START' then 'ON_MEAL_BREAK'
    else 'WORKING'
  end;

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

  -- Planned events: BREAK_END carries the open break's type; CLOCK_OUT while
  -- on a break ends the break first, at the same instant.
  if p_action = 'BREAK_END' then
    planned := array['BREAK_END']; planned_break := array[latest.break_type];
  elsif p_action = 'CLOCK_OUT' and current_state in ('ON_PAID_BREAK', 'ON_MEAL_BREAK') then
    planned := array['BREAK_END', 'CLOCK_OUT']; planned_break := array[latest.break_type, null];
  else
    planned := array[p_action]; planned_break := array[p_break_type];
  end if;
  next_state := current_state;
  for i in 1 .. array_length(planned, 1) loop
    next_state := public.m06_time_next_state(next_state, planned[i], planned_break[i]);
    if next_state is null then
      return jsonb_build_object('ok', false, 'code', 'TIME_INVALID_TRANSITION', 'state', current_state);
    end if;
  end loop;

  stamp := greatest(clock_timestamp(), latest.occurred_at);
  for i in 1 .. array_length(planned, 1) loop
    insert into public.employee_time_events
      (business_id, employee_id, device_id, event_type, break_type, occurred_at, request_id)
      values (p_business_id, p_employee_id, p_device_id, planned[i], planned_break[i], stamp, p_request_id);
  end loop;
  return jsonb_build_object('ok', true, 'replayed', false, 'state', next_state);
end;
$$;
revoke all on function public.m05_record_time_event(uuid, uuid, uuid, uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.m05_record_time_event(uuid, uuid, uuid, uuid, text, text, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Management audit: time corrections
-- ---------------------------------------------------------------------------
alter table public.employee_management_actions add column reason text, add column correction_id uuid;
alter table public.employee_management_actions drop constraint employee_management_actions_action_check;
alter table public.employee_management_actions add constraint employee_management_actions_action_check check (action in (
  'employee.created', 'employee.updated', 'employee.deactivated', 'employee.reactivated', 'employee.pin_reset', 'time.corrected'));
alter table public.employee_management_actions drop constraint employee_management_actions_snapshot_check;
alter table public.employee_management_actions add constraint employee_management_actions_snapshot_check check (
  (before_value is null or jsonb_typeof(before_value) = 'object') and jsonb_typeof(after_value) = 'object'
  and case when action = 'time.corrected' then
    before_value is not null
    and before_value - array['revision', 'watermark', 'state', 'event_count']::text[] = '{}'::jsonb
    and after_value - array['revision', 'watermark', 'state', 'event_count', 'operation_count']::text[] = '{}'::jsonb
  else
    (before_value is null or before_value - array['display_name', 'role', 'is_active']::text[] = '{}'::jsonb)
    and after_value - array['display_name', 'role', 'is_active']::text[] = '{}'::jsonb
  end);
alter table public.employee_management_actions add constraint employee_management_actions_correction_check check (
  (action = 'time.corrected') = (correction_id is not null)
  and (action = 'time.corrected') = (reason is not null)
  and (reason is null or (reason = btrim(reason) and length(reason) between 1 and 500)));
alter table public.employee_management_actions add constraint employee_management_actions_correction_fkey
  foreign key (business_id, subject_employee_id, correction_id)
  references public.employee_time_corrections (business_id, employee_id, id);

-- ---------------------------------------------------------------------------
-- Preview / commit (the only correction write path)
-- ---------------------------------------------------------------------------
-- Errors: 22023 invalid request; 28000 operational identity unavailable;
-- 42501 management/target authority; Z0001 invalid correction (message =
-- reason code, detail = logical id); Z0003 employee not found.
-- Returns jsonb: { ok, replayed, preview, correction_id, revision, watermark,
-- state, events?, head? } or { ok: false, code: TIME_CORRECTION_STALE |
-- TIME_REQUEST_CONFLICT, revision, watermark }.
create function public.m06_correct_employee_time(
  p_business_id uuid, p_employee_id uuid,
  p_actor_id uuid, p_authority_mode text, p_expected_account_role text,
  p_actor_employee_id uuid, p_actor_device_id uuid, p_actor_session_id uuid,
  p_operations jsonb, p_reason text, p_request_id uuid,
  p_expected_revision integer, p_expected_watermark bigint,
  p_commit boolean, p_window_start timestamptz, p_window_end timestamptz
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  actor_role text;
  actor_name text;
  target_role text;
  reason text := btrim(p_reason);
  request_hash text;
  existing public.employee_time_corrections;
  current_revision integer;
  watermark bigint;
  ids uuid[];
  vals jsonb;
  voided uuid[];
  before_state text;
  before_count integer;
  after_state text;
  after_count integer;
  correction_id uuid := gen_random_uuid();
  next_revision integer;
  op jsonb;
  ordinal bigint;
  kind text;
  entry_id uuid;
  refs jsonb := '{}';
  entries jsonb := '[]';
  target uuid;
  anchor uuid;
  at_start boolean;
  occurred timestamptz;
  event_type text;
  break_type text;
  placement integer;
  pos integer;
  preview jsonb;
  insert_keys constant text[] := array['op', 'type', 'breakType', 'occurredAt', 'after', 'before', 'afterRef', 'atStart', 'ref'];
  replace_keys constant text[] := array['op', 'target', 'occurredAt', 'breakType'];
  void_keys constant text[] := array['op', 'target'];
  instant constant text := '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$';
begin
  if p_business_id is null or p_employee_id is null or p_commit is null
     or p_operations is null or jsonb_typeof(p_operations) <> 'array'
     or jsonb_array_length(p_operations) not between 1 and 20
     or (p_window_start is null) <> (p_window_end is null) or p_window_start >= p_window_end
     or (p_commit and (p_request_id is null or p_expected_revision is null or p_expected_watermark is null
       or reason is null or length(reason) not between 1 and 500)) then
    raise exception 'Invalid correction' using errcode = '22023';
  end if;

  -- The M05 per-employee lock: corrections and real clock actions for this
  -- employee are fully serialized with each other.
  perform pg_advisory_xact_lock(
    hashtextextended('zude:m05:time:' || p_business_id::text || ':' || p_employee_id::text, 505));

  -- Actor (account membership, and in shared-device mode the PIN employee,
  -- device and session) re-verified under row locks held to commit.
  select a.effective_role, a.actor_name into actor_role, actor_name
    from public.m06_assert_management_actor(p_business_id, p_actor_id, p_authority_mode, p_expected_account_role,
      p_actor_employee_id, p_actor_device_id, p_actor_session_id) a;
  select e.role into target_role from public.employees e
    where e.business_id = p_business_id and e.id = p_employee_id for share;
  if target_role is null then
    raise exception 'Employee not found' using errcode = 'Z0003';
  end if;
  -- Locked M06 hierarchy (same as Team): managers correct regular employees
  -- only; owners correct any employee.
  if not (actor_role = 'owner' or (actor_role = 'manager' and target_role = 'employee')) then
    raise exception 'Correction authority unavailable' using errcode = '42501';
  end if;

  if p_commit then
    request_hash := encode(sha256(convert_to(jsonb_build_object('operations', p_operations, 'reason', reason,
      'expected_revision', p_expected_revision, 'expected_watermark', p_expected_watermark)::text, 'UTF8')), 'hex');
    select * into existing from public.employee_time_corrections c
      where c.business_id = p_business_id and c.employee_id = p_employee_id and c.request_id = p_request_id;
    if existing.id is not null then
      if existing.request_hash = request_hash then
        return jsonb_build_object('ok', true, 'replayed', true, 'preview', false, 'correction_id', existing.id,
          'revision', existing.revision, 'watermark', existing.base_watermark);
      end if;
      return jsonb_build_object('ok', false, 'code', 'TIME_REQUEST_CONFLICT');
    end if;
  end if;

  select coalesce(max(c.revision), 0) into current_revision from public.employee_time_corrections c
    where c.business_id = p_business_id and c.employee_id = p_employee_id;
  select coalesce(max(e.seq), 0) into watermark from public.employee_time_events e
    where e.business_id = p_business_id and e.employee_id = p_employee_id;
  if p_commit and (p_expected_revision <> current_revision or p_expected_watermark <> watermark) then
    return jsonb_build_object('ok', false, 'code', 'TIME_CORRECTION_STALE', 'revision', current_revision, 'watermark', watermark);
  end if;

  select f.ids, f.vals, f.voided into ids, vals, voided from public.m06_time_fold(p_business_id, p_employee_id) f;
  before_state := public.m06_time_validate(ids, vals, voided, clock_timestamp());
  before_count := cardinality(ids) - cardinality(voided);
  next_revision := current_revision + 1;

  for op, ordinal in select value, o from jsonb_array_elements(p_operations) with ordinality as t(value, o) loop
    if jsonb_typeof(op) <> 'object' or jsonb_typeof(op -> 'op') <> 'string' then
      raise exception 'Invalid correction' using errcode = '22023';
    end if;
    kind := op ->> 'op';
    entry_id := gen_random_uuid();
    target := null; anchor := null; at_start := false; occurred := null; event_type := null; break_type := null;
    if kind not in ('INSERT', 'REPLACE', 'VOID')
       or op - (case kind when 'INSERT' then insert_keys when 'REPLACE' then replace_keys else void_keys end) <> '{}'::jsonb
       or (op ? 'occurredAt' and (jsonb_typeof(op -> 'occurredAt') <> 'string' or (op ->> 'occurredAt') !~ instant))
       or (op ? 'breakType' and op -> 'breakType' <> 'null'::jsonb and coalesce(op ->> 'breakType', '') not in ('PAID', 'MEAL'))
       or (op ? 'target' and jsonb_typeof(op -> 'target') <> 'string') then
      raise exception 'Invalid correction' using errcode = '22023';
    end if;
    if op ? 'occurredAt' then
      occurred := (op ->> 'occurredAt')::timestamptz;
      if occurred < timestamptz '2000-01-01 00:00:00+00' then
        raise exception 'Invalid correction' using errcode = '22023';
      end if;
    end if;
    break_type := nullif(op ->> 'breakType', '');
    if kind = 'INSERT' then
      event_type := op ->> 'type';
      if event_type is null or event_type not in ('CLOCK_IN', 'BREAK_START', 'BREAK_END', 'CLOCK_OUT') or occurred is null
         or (event_type in ('BREAK_START', 'BREAK_END')) <> (break_type is not null) then
        raise exception 'Invalid correction' using errcode = '22023';
      end if;
      placement := (op ? 'after')::int + (op ? 'before')::int + (op ? 'afterRef')::int + (op ? 'atStart')::int;
      if placement <> 1 or (op ? 'atStart' and op -> 'atStart' <> 'true'::jsonb)
         or (op ? 'after' and jsonb_typeof(op -> 'after') <> 'string')
         or (op ? 'before' and jsonb_typeof(op -> 'before') <> 'string')
         or (op ? 'afterRef' and jsonb_typeof(op -> 'afterRef') <> 'string')
         or (op ? 'ref' and (jsonb_typeof(op -> 'ref') <> 'string' or (op ->> 'ref') !~ '^[A-Za-z0-9_-]{1,40}$' or refs ? (op ->> 'ref'))) then
        raise exception 'Invalid correction' using errcode = '22023';
      end if;
      if op ? 'atStart' then
        at_start := true;
      elsif op ? 'after' then
        anchor := (op ->> 'after')::uuid;
      elsif op ? 'afterRef' then
        anchor := (refs ->> (op ->> 'afterRef'))::uuid;
        if anchor is null then raise exception 'Invalid correction' using errcode = '22023'; end if;
      else
        -- "before X" resolves to "after X's predecessor slot" (voided slots
        -- included), or the start when X is first.
        pos := array_position(ids, (op ->> 'before')::uuid);
        if pos is null then
          raise exception 'ANCHOR_NOT_FOUND' using errcode = 'Z0001', detail = op ->> 'before';
        end if;
        if pos = 1 then at_start := true; else anchor := ids[pos - 1]; end if;
      end if;
      if op ? 'ref' then refs := refs || jsonb_build_object(op ->> 'ref', entry_id); end if;
    else
      target := (op ->> 'target')::uuid;
      if target is null or (kind = 'REPLACE' and occurred is null) or (kind = 'VOID' and break_type is not null) then
        raise exception 'Invalid correction' using errcode = '22023';
      end if;
    end if;
    select f.p_ids, f.p_vals, f.p_voided into ids, vals, voided
      from public.m06_time_fold_apply(ids, vals, voided, entry_id, kind, target, anchor, at_start,
        event_type, break_type, occurred, correction_id, next_revision) f;
    -- Store the resolved values: REPLACE keeps the effective break type.
    if kind = 'REPLACE' then break_type := vals -> target::text ->> 'break_type'; end if;
    entries := entries || jsonb_build_array(jsonb_build_object('id', entry_id, 'ordinal', ordinal, 'operation', kind,
      'target', target, 'after', anchor, 'at_start', at_start, 'event_type', event_type, 'break_type', break_type,
      'occurred_at', occurred));
  end loop;

  after_state := public.m06_time_validate(ids, vals, voided, clock_timestamp());
  after_count := cardinality(ids) - cardinality(voided);

  if not p_commit then
    -- Preview: apply to the projection inside a subtransaction, read the
    -- window, then roll the subtransaction back. Nothing persists.
    begin
      perform public.m06_time_write_projection(p_business_id, p_employee_id, ids, vals, voided);
      if p_window_start is not null then
        preview := public.m06_effective_window(p_business_id, p_employee_id, p_window_start, p_window_end);
      end if;
      raise exception 'preview rollback' using errcode = 'Z0000';
    exception when sqlstate 'Z0000' then
      null;
    end;
    return jsonb_build_object('ok', true, 'replayed', false, 'preview', true, 'revision', current_revision,
      'watermark', watermark, 'state', after_state, 'events', preview -> 'events', 'head', preview -> 'head');
  end if;

  insert into public.employee_time_corrections (id, business_id, employee_id, revision, base_watermark, request_id, request_hash, reason)
    values (correction_id, p_business_id, p_employee_id, next_revision, watermark, p_request_id, request_hash, reason);
  insert into public.employee_time_correction_entries
    (id, business_id, employee_id, correction_id, ordinal, operation, target_event_id, after_event_id, at_start, event_type, break_type, occurred_at)
  select (e ->> 'id')::uuid, p_business_id, p_employee_id, correction_id, (e ->> 'ordinal')::integer, e ->> 'operation',
    (e ->> 'target')::uuid, (e ->> 'after')::uuid, (e ->> 'at_start')::boolean, e ->> 'event_type', e ->> 'break_type',
    (e ->> 'occurred_at')::timestamptz
  from jsonb_array_elements(entries) e;
  perform public.m06_time_write_projection(p_business_id, p_employee_id, ids, vals, voided);
  insert into public.employee_management_actions (
    business_id, subject_employee_id, actor_user_id, authority_mode, actor_employee_id, actor_device_id, actor_session_id,
    actor_name_snapshot, account_role, effective_role, action, pin_reset, before_value, after_value, reason, correction_id)
  values (p_business_id, p_employee_id, p_actor_id, p_authority_mode, p_actor_employee_id, p_actor_device_id, p_actor_session_id,
    actor_name, p_expected_account_role, actor_role, 'time.corrected', false,
    jsonb_build_object('revision', current_revision, 'watermark', watermark, 'state', before_state, 'event_count', before_count),
    jsonb_build_object('revision', next_revision, 'watermark', watermark, 'state', after_state, 'event_count', after_count,
      'operation_count', jsonb_array_length(p_operations)),
    reason, correction_id);
  return jsonb_build_object('ok', true, 'replayed', false, 'preview', false, 'correction_id', correction_id,
    'revision', next_revision, 'watermark', watermark, 'state', after_state);
end;
$$;
revoke all on function public.m06_correct_employee_time(uuid, uuid, uuid, text, text, uuid, uuid, uuid, jsonb, text, uuid, integer, bigint, boolean, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.m06_correct_employee_time(uuid, uuid, uuid, text, text, uuid, uuid, uuid, jsonb, text, uuid, integer, bigint, boolean, timestamptz, timestamptz) to service_role;

commit;
