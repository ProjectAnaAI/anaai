-- AnaAI durable appointment duration snapshot.
--
-- REVIEW ONLY: do not deploy until the acceptance tests in
-- tests/appointment-duration-snapshot.README.md pass.
--
-- Apply AFTER 202609210006. Requires 202609210001 through 202609210006.
--
-- ROOT CAUSE
--
-- appointments stores `service` (text) and `service_id` (uuid) but NO duration.
-- Every interval calculation therefore had to re-derive the duration from the
-- LIVE services catalogue. The service_id foreign key is ON DELETE SET NULL, so
-- deleting a service nulls service_id on its historical appointments while
-- leaving the `service` text behind.
--
-- Once the service row is gone the duration is unknowable, the shared capacity
-- helper correctly fails closed with INVALID_EXISTING_SCHEDULE, and EVERY
-- subsequent booking on that business/date is blocked -- by phone, by dashboard
-- and by AI chat. A real call reproduced exactly this: a deleted "facial"
-- service left active appointments that could no longer be evaluated.
--
-- The appointments were never malformed. A later catalogue edit made them
-- unreadable. Scheduling correctness must not depend on a service row
-- surviving.
--
-- FIX
--
-- appointments.duration_minutes records the scheduling duration that was
-- authoritative WHEN THE APPOINTMENT WAS SCHEDULED. It is written inside the
-- same transaction as the appointment by every authoritative path, and read in
-- preference to the live catalogue for every existing-appointment interval.
--
-- Renaming, deactivating, re-timing or deleting a service therefore no longer
-- changes the interval of an already-scheduled appointment, and no longer makes
-- it impossible to evaluate.
--
-- CANDIDATE vs EXISTING
--
-- The snapshot is authoritative for EXISTING appointments only. A new candidate
-- booking or reschedule still takes its duration from the currently valid,
-- active service row, exactly as before -- so a genuine duration change applies
-- to future bookings while leaving history intact.
--
-- NULLABLE ON PURPOSE
--
-- The column is nullable because it cannot be honestly backfilled for every
-- historical row. Rows whose service was deleted have no recoverable duration
-- anywhere in this schema: appointment_actions records the historical
-- service_id but never a duration, and there is no services history table. For
-- those rows the snapshot stays NULL and the helper keeps failing closed. See
-- tests/appointment-duration-snapshot.README.md for the remediation options.
--
-- Inventing a duration to unblock them would silently corrupt real customers'
-- appointment intervals, so this migration does not do it.
--
-- ONE MIGRATION
--
-- The column, the backfill, the capacity helper and all four authoritative
-- write paths ship together in a single transaction. Splitting them would leave
-- a window in which the column exists but writers do not populate it, producing
-- fresh un-backfillable rows.

begin;

-- ---------------------------------------------------------------------------
-- 1. Schema
-- ---------------------------------------------------------------------------

alter table public.appointments
  add column if not exists duration_minutes integer;

comment on column public.appointments.duration_minutes is
  'Durable snapshot of the scheduling duration authoritative when this appointment was booked or rescheduled. Authoritative for this appointment''s interval; never re-derive it from the live services catalogue. NULL only for legacy rows whose duration could not be honestly recovered.';

alter table public.appointments
  drop constraint if exists appointments_duration_minutes_check;

/*
 * Nullable, but never nonsense. A day-length ceiling keeps a corrupt value from
 * consuming capacity across an entire calendar. Existing rows are NULL at this
 * point, so the constraint validates immediately.
 */
alter table public.appointments
  add constraint appointments_duration_minutes_check
  check (
    duration_minutes is null
    or (duration_minutes > 0 and duration_minutes <= 1440)
  );

-- ---------------------------------------------------------------------------
-- 2. Backfill
-- ---------------------------------------------------------------------------

/*
 * ONLY where the evidence is authoritative: the appointment still links to a
 * service row, in the same business, with a usable duration. That row is the
 * exact value the scheduling code would have used a moment ago, so recording it
 * changes no behaviour -- it only makes the value durable.
 *
 * Deliberately NOT backfilled:
 *
 *   - rows whose service_id is NULL (deleted service). Their duration is not
 *     recoverable from any table in this schema, and guessing would corrupt a
 *     real appointment's interval.
 *   - rows resolvable only by the legacy case-insensitive service-NAME
 *     fallback. That fallback stays a live, ambiguity-safe read in the helper;
 *     freezing a present-day name match into a durable snapshot would promote a
 *     guess about history into authoritative data.
 */
update public.appointments a
set duration_minutes = s.duration_minutes
from public.services s
where a.duration_minutes is null
  and a.service_id is not null
  and s.id = a.service_id
  and s.business_id = a.business_id
  and s.duration_minutes is not null
  and s.duration_minutes > 0
  and s.duration_minutes <= 1440;

-- ---------------------------------------------------------------------------
-- 3. Shared capacity helper: prefer the snapshot
-- ---------------------------------------------------------------------------

/*
 * Resolution order for an EXISTING active appointment:
 *
 *   A. appointments.duration_minutes   -- the durable snapshot, authoritative
 *   C. the still-resolvable linked service row          (legacy rows only)
 *   D. an UNAMBIGUOUS legacy service-name match         (legacy rows only)
 *   E. otherwise NULL -> INVALID_EXISTING_SCHEDULE, fail closed
 *
 * B from the design note (recovery from historical evidence) is intentionally
 * absent: no authoritative historical duration exists to recover.
 *
 * Everything else about this function is unchanged, including half-open
 * [start, end) intervals, the Booked/Confirmed filter, peak concurrency, the
 * reschedule self-exclusion, the single-statement snapshot, the fail-closed
 * behaviour and the return vocabulary.
 */
create or replace function anaai_private.check_appointment_capacity_business(
  p_business_id uuid,
  p_appointment_date date,
  p_appointment_time time without time zone,
  p_duration_minutes integer,
  p_exclude_appointment_id uuid default null
)
returns text
language plpgsql
stable
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_capacity integer;
  v_requested_start timestamp without time zone;
  v_requested_end timestamp without time zone;
  v_malformed bigint;
  v_peak integer;
begin
  if p_business_id is null
     or p_appointment_date is null
     or not isfinite(p_appointment_date)
     or p_appointment_time is null
     or p_duration_minutes is null
     or p_duration_minutes <= 0 then
    return 'INVALID_SCHEDULE';
  end if;

  select b.appointment_capacity
  into v_capacity
  from public.businesses b
  where b.id = p_business_id;

  /*
   * businesses.appointment_capacity is NOT NULL and CHECK (>= 1). Reaching
   * this branch means the row is missing or unreadable in this session, which
   * is an internal inconsistency after the caller's membership check. Fail
   * closed: INTERNAL_ERROR makes the idempotent wrapper roll the whole action
   * back and permits a retry. No upper bound is enforced here; the table
   * constraint owns that so a future limit change cannot break scheduling.
   */
  if not found or v_capacity is null or v_capacity < 1 then
    return 'INTERNAL_ERROR';
  end if;

  v_requested_start := p_appointment_date::timestamp + p_appointment_time;
  v_requested_end :=
    v_requested_start + make_interval(mins => p_duration_minutes);

  /*
   * One statement, therefore one snapshot: validation of existing rows and the
   * occupancy sweep can never disagree about which appointments exist.
   *
   * Duration resolution matches the deployed rule exactly. The service_id
   * lookup deliberately includes inactive services. The case-insensitive name
   * fallback is legacy compatibility and is used ONLY when no service row
   * matches service_id; a matched service with a NULL duration fails closed
   * rather than silently falling back. An ambiguous name also fails closed.
   *
   * Sweep: each existing interval is clipped to the requested interval and
   * contributes +1 at its clipped start and -1 at its clipped end. Events at
   * the same instant are summed BEFORE the running total is taken, which is
   * what preserves half-open [start, end) semantics -- an appointment ending
   * exactly when another begins never raises simultaneous occupancy.
   *
   * The requested appointment itself would add one unit across the whole
   * requested interval, so an existing peak of v_capacity or more means
   * accepting it would exceed capacity.
   */
  with active as (
    select
      a.appointment_time,
      coalesce(
        /*
         * A. The durable snapshot taken when the appointment was scheduled.
         *    It is authoritative and overrides the live catalogue, so renaming,
         *    deactivating, re-timing or DELETING a service never changes an
         *    already-scheduled interval.
         */
        a.duration_minutes,
        /*
         * Legacy rows only, i.e. scheduled before the snapshot column existed
         * and not reachable by the backfill. Unchanged from the deployed rule.
         */
        case
          /* C. the still-resolvable linked service */
          when exists (
            select 1
            from public.services s
            where s.id = a.service_id
              and s.business_id = p_business_id
          )
          then (
            select s.duration_minutes
            from public.services s
            where s.id = a.service_id
              and s.business_id = p_business_id
          )
          /* D. unambiguous legacy name fallback; ambiguity yields NULL */
          else (
            select
              case when count(*) = 1 then min(s.duration_minutes) end
            from public.services s
            where s.business_id = p_business_id
              and lower(s.name) = lower(a.service)
          )
        end
      ) as duration_minutes
    from public.appointments a
    where a.business_id = p_business_id
      and a.appointment_date = p_appointment_date
      and a.status in ('Booked', 'Confirmed')
      and (
        p_exclude_appointment_id is null
        or a.id <> p_exclude_appointment_id
      )
  ),
  usable as (
    select
      appointment_time,
      duration_minutes
    from active
    where appointment_time is not null
      and duration_minutes is not null
      and duration_minutes > 0
  ),
  intervals as (
    select
      p_appointment_date::timestamp + appointment_time as existing_start,
      p_appointment_date::timestamp
        + appointment_time
        + make_interval(mins => duration_minutes) as existing_end
    from usable
  ),
  clipped as (
    select
      greatest(existing_start, v_requested_start) as clipped_start,
      least(existing_end, v_requested_end) as clipped_end
    from intervals
    where existing_start < v_requested_end
      and existing_end > v_requested_start
  ),
  events as (
    select clipped_start as event_time, 1 as delta from clipped
    union all
    select clipped_end as event_time, -1 as delta from clipped
  ),
  grouped as (
    select
      event_time,
      sum(delta) as delta
    from events
    group by event_time
  ),
  running as (
    select
      sum(delta) over (
        order by event_time
        rows between unbounded preceding and current row
      ) as occupancy
    from grouped
  )
  select
    (select count(*) from active) - (select count(*) from usable),
    coalesce((select max(occupancy) from running), 0)::integer
  into v_malformed, v_peak;

  /*
   * A pre-existing active appointment whose interval cannot be determined must
   * never be treated as unoccupied time. Fail closed, exactly as the deployed
   * single-slot check does.
   */
  if v_malformed > 0 then
    return 'INVALID_EXISTING_SCHEDULE';
  end if;

  if v_peak >= v_capacity then
    return 'SLOT_CONFLICT';
  end if;

  return 'AVAILABLE';

exception
  when others then
    raise log 'AnaAI capacity check failed sqlstate=%', SQLSTATE;
    return 'INTERNAL_ERROR';
end;
$function$;

revoke all on function anaai_private.check_appointment_capacity_business(
  uuid,
  date,
  time without time zone,
  integer,
  uuid
) from public, anon;

grant execute on function anaai_private.check_appointment_capacity_business(
  uuid,
  date,
  time without time zone,
  integer,
  uuid
) to authenticated;

grant execute on function anaai_private.check_appointment_capacity_business(
  uuid,
  date,
  time without time zone,
  integer,
  uuid
) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Authoritative write paths
--
-- Every path that creates or re-times an appointment records the snapshot in
-- the SAME statement as the appointment itself, from the service row the
-- database validated. The browser never supplies it.
--
-- Each function below is its deployed definition with only the duration column
-- added; nothing else was rewritten or reordered.
-- ---------------------------------------------------------------------------

create or replace function public.create_appointment_atomic_business(
  p_business_id uuid,
  p_customer_id uuid,
  p_service_id uuid,
  p_appointment_date date,
  p_appointment_time time,
  p_notes text default null
) returns jsonb
language plpgsql volatile security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_user_id uuid := auth.uid();
  v_customer public.customers%rowtype;
  v_service public.services%rowtype;
  v_appointment public.appointments%rowtype;
  v_hours_text text;
  v_hours jsonb;
  v_day jsonb;
  v_open time;
  v_close time;
  v_start timestamp;
  v_end timestamp;
  v_capacity_result text;
begin
  if v_user_id is null then
    return jsonb_build_object(
      'success', false,
      'code', 'UNAUTHORIZED'
    );
  end if;

  if p_business_id is null
     or not coalesce(public.is_business_member(p_business_id), false) then
    return jsonb_build_object(
      'success', false,
      'code', 'FORBIDDEN'
    );
  end if;

  if current_setting('transaction_isolation') <> 'read committed' then
    return jsonb_build_object(
      'success', false,
      'code', 'UNSUPPORTED_ISOLATION'
    );
  end if;

  if p_appointment_date is null
     or not isfinite(p_appointment_date)
     or p_appointment_time is null then
    return jsonb_build_object(
      'success', false,
      'code', 'INVALID_SCHEDULE'
    );
  end if;

  /*
   * All authoritative writers for a business/date use this same lock.
   * Therefore two concurrent booking attempts cannot both make their capacity
   * decision against the same stale appointment set.
   */
  perform pg_advisory_xact_lock(
    hashtext(
      p_business_id::text
      || ':'
      || p_appointment_date::text
    )
  );

  select *
  into v_customer
  from public.customers
  where id = p_customer_id
    and business_id = p_business_id;

  if not found then
    return jsonb_build_object(
      'success', false,
      'code', 'INVALID_CUSTOMER'
    );
  end if;

  select *
  into v_service
  from public.services
  where id = p_service_id
    and business_id = p_business_id
    and is_active = true;

  if not found then
    return jsonb_build_object(
      'success', false,
      'code', 'INVALID_SERVICE'
    );
  end if;

  if v_service.duration_minutes is null
     or v_service.duration_minutes <= 0 then
    return jsonb_build_object(
      'success', false,
      'code', 'INVALID_DURATION'
    );
  end if;

  begin
    /*
     * Select the latest TEXT value before parsing. Historical rows must never
     * be cast while the SELECT is finding/sorting candidates.
     */
    select business_hours
    into v_hours_text
    from public.business_profiles
    where business_id = p_business_id
    order by created_at desc
    limit 1;

    if not found or v_hours_text is null then
      return jsonb_build_object(
        'success', false,
        'code', 'INVALID_HOURS'
      );
    end if;

    v_hours := v_hours_text::jsonb;

    v_day :=
      v_hours
      -> (
        array[
          'sunday',
          'monday',
          'tuesday',
          'wednesday',
          'thursday',
          'friday',
          'saturday'
        ]
      )[extract(dow from p_appointment_date)::integer + 1];

    if v_day is null
       or jsonb_typeof(v_day -> 'closed') is distinct from 'boolean' then
      return jsonb_build_object(
        'success', false,
        'code', 'INVALID_HOURS'
      );
    end if;

    if (v_day ->> 'closed')::boolean then
      return jsonb_build_object(
        'success', false,
        'code', 'CLOSED'
      );
    end if;

    v_open := (v_day ->> 'open')::time;
    v_close := (v_day ->> 'close')::time;

    if v_open is null
       or v_close is null
       or v_close <= v_open then
      return jsonb_build_object(
        'success', false,
        'code', 'INVALID_HOURS'
      );
    end if;

  exception
    when others then
      return jsonb_build_object(
        'success', false,
        'code', 'INVALID_HOURS'
      );
  end;

  v_start :=
    p_appointment_date::timestamp
    + p_appointment_time;

  v_end :=
    v_start
    + make_interval(mins => v_service.duration_minutes);

  if v_start < p_appointment_date::timestamp + v_open
     or v_end > p_appointment_date::timestamp + v_close then
    return jsonb_build_object(
      'success', false,
      'code', 'OUTSIDE_HOURS'
    );
  end if;

  /*
   * Fresh statement after the advisory lock, so a competitor that committed
   * while this transaction waited is visible. No row locks on other
   * appointments. Capacity is checked only after membership, customer, service
   * and business-hours validation have all passed.
   */
  v_capacity_result :=
    anaai_private.check_appointment_capacity_business(
      p_business_id,
      p_appointment_date,
      p_appointment_time,
      v_service.duration_minutes,
      null
    );

  if v_capacity_result <> 'AVAILABLE' then
    return jsonb_build_object(
      'success', false,
      'code', v_capacity_result
    );
  end if;

  insert into public.appointments (
    business_id,
    user_id,
    customer_id,
    service_id,
    customer_name,
    customer_phone,
    customer_email,
    service,
    duration_minutes,
    appointment_date,
    appointment_time,
    notes,
    status
  )
  values (
    p_business_id,
    v_user_id,
    v_customer.id,
    v_service.id,
    v_customer.full_name,
    v_customer.phone,
    v_customer.email,
    v_service.name,
    v_service.duration_minutes,
    p_appointment_date,
    p_appointment_time,
    nullif(btrim(p_notes), ''),
    'Booked'
  )
  returning *
  into v_appointment;

  return jsonb_build_object(
    'success', true,
    'appointment', jsonb_build_object(
      'id', v_appointment.id,
      'customer_id', v_appointment.customer_id,
      'service_id', v_appointment.service_id,
      'customer_name', v_appointment.customer_name,
      'customer_phone', v_appointment.customer_phone,
      'customer_email', v_appointment.customer_email,
      'service', v_appointment.service,
      'appointment_date', v_appointment.appointment_date,
      'appointment_time', v_appointment.appointment_time,
      'status', v_appointment.status,
      'notes', v_appointment.notes
    )
  );

exception
  when others then
    /*
     * Entering this handler rolls back database changes within this block's
     * implicit subtransaction, not unrelated work in the caller transaction.
     */
    raise log
      'AnaAI atomic scheduling failed sqlstate=%',
      SQLSTATE;

    return jsonb_build_object(
      'success', false,
      'code', 'INTERNAL_ERROR'
    );
end;
$function$;

revoke all on function public.create_appointment_atomic_business(
  uuid,
  uuid,
  uuid,
  date,
  time,
  text
) from public, anon;

grant execute on function public.create_appointment_atomic_business(
  uuid,
  uuid,
  uuid,
  date,
  time,
  text
) to authenticated;

create or replace function public.reschedule_appointment_atomic_business(
  p_business_id uuid,
  p_appointment_id uuid,
  p_customer_id uuid,
  p_service_id uuid,
  p_appointment_date date,
  p_appointment_time time,
  p_notes text default null
) returns jsonb
language plpgsql volatile security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_user_id uuid := auth.uid();
  v_customer public.customers%rowtype;
  v_service public.services%rowtype;
  v_appointment public.appointments%rowtype;
  v_hours_text text;
  v_hours jsonb;
  v_day jsonb;
  v_open time;
  v_close time;
  v_start timestamp;
  v_end timestamp;
  v_source_date date;
  v_scheduling_date date;
  v_capacity_result text;
begin
  if v_user_id is null then
    return jsonb_build_object(
      'success', false,
      'code', 'UNAUTHORIZED'
    );
  end if;

  if p_business_id is null
     or not coalesce(public.is_business_member(p_business_id), false) then
    return jsonb_build_object(
      'success', false,
      'code', 'FORBIDDEN'
    );
  end if;

  if current_setting('transaction_isolation') <> 'read committed' then
    return jsonb_build_object(
      'success', false,
      'code', 'UNSUPPORTED_ISOLATION'
    );
  end if;

  if p_appointment_date is null
     or not isfinite(p_appointment_date)
     or p_appointment_time is null then
    return jsonb_build_object(
      'success', false,
      'code', 'INVALID_SCHEDULE'
    );
  end if;

  /*
   * Discovery only. This value is not authoritative until the appointment is
   * reread after both affected business/date advisory locks are held.
   */
  select appointment_date
  into v_source_date
  from public.appointments
  where id = p_appointment_id
    and business_id = p_business_id;

  if not found then
    return jsonb_build_object(
      'success', false,
      'code', 'APPOINTMENT_NOT_FOUND'
    );
  end if;

  if v_source_date is null
     or not isfinite(v_source_date) then
    return jsonb_build_object(
      'success', false,
      'code', 'INVALID_EXISTING_SCHEDULE'
    );
  end if;

  /*
   * Lock both affected dates in chronological order. DISTINCT makes a
   * same-date reschedule acquire only one advisory lock.
   */
  for v_scheduling_date in
    select distinct d.scheduling_date
    from (
      values
        (v_source_date),
        (p_appointment_date)
    ) as d(scheduling_date)
    order by d.scheduling_date
  loop
    perform pg_advisory_xact_lock(
      hashtext(
        p_business_id::text
        || ':'
        || v_scheduling_date::text
      )
    );
  end loop;

  select *
  into v_appointment
  from public.appointments
  where id = p_appointment_id
    and business_id = p_business_id
  for update;

  if not found then
    return jsonb_build_object(
      'success', false,
      'code', 'APPOINTMENT_NOT_FOUND'
    );
  end if;

  /*
   * A competing move can commit while this transaction waits. Never mutate
   * under a stale/incomplete advisory-lock set; force a fresh retry instead.
   */
  if v_appointment.appointment_date
       is distinct from v_source_date then
    return jsonb_build_object(
      'success', false,
      'code', 'SOURCE_DATE_CHANGED'
    );
  end if;

  if v_appointment.status is null
     or v_appointment.status not in ('Booked', 'Confirmed') then
    return jsonb_build_object(
      'success', false,
      'code', 'TERMINAL_APPOINTMENT'
    );
  end if;

  select *
  into v_customer
  from public.customers
  where id = p_customer_id
    and business_id = p_business_id;

  if not found then
    return jsonb_build_object(
      'success', false,
      'code', 'INVALID_CUSTOMER'
    );
  end if;

  select *
  into v_service
  from public.services
  where id = p_service_id
    and business_id = p_business_id
    and is_active = true;

  if not found then
    return jsonb_build_object(
      'success', false,
      'code', 'INVALID_SERVICE'
    );
  end if;

  if v_service.duration_minutes is null
     or v_service.duration_minutes <= 0 then
    return jsonb_build_object(
      'success', false,
      'code', 'INVALID_DURATION'
    );
  end if;

  begin
    select business_hours
    into v_hours_text
    from public.business_profiles
    where business_id = p_business_id
    order by created_at desc
    limit 1;

    if not found or v_hours_text is null then
      return jsonb_build_object(
        'success', false,
        'code', 'INVALID_HOURS'
      );
    end if;

    v_hours := v_hours_text::jsonb;

    v_day :=
      v_hours
      -> (
        array[
          'sunday',
          'monday',
          'tuesday',
          'wednesday',
          'thursday',
          'friday',
          'saturday'
        ]
      )[extract(dow from p_appointment_date)::integer + 1];

    if v_day is null
       or jsonb_typeof(v_day -> 'closed') is distinct from 'boolean' then
      return jsonb_build_object(
        'success', false,
        'code', 'INVALID_HOURS'
      );
    end if;

    if (v_day ->> 'closed')::boolean then
      return jsonb_build_object(
        'success', false,
        'code', 'CLOSED'
      );
    end if;

    v_open := (v_day ->> 'open')::time;
    v_close := (v_day ->> 'close')::time;

    if v_open is null
       or v_close is null
       or v_close <= v_open then
      return jsonb_build_object(
        'success', false,
        'code', 'INVALID_HOURS'
      );
    end if;

  exception
    when others then
      return jsonb_build_object(
        'success', false,
        'code', 'INVALID_HOURS'
      );
  end;

  v_start :=
    p_appointment_date::timestamp
    + p_appointment_time;

  v_end :=
    v_start
    + make_interval(mins => v_service.duration_minutes);

  if v_start < p_appointment_date::timestamp + v_open
     or v_end > p_appointment_date::timestamp + v_close then
    return jsonb_build_object(
      'success', false,
      'code', 'OUTSIDE_HOURS'
    );
  end if;

  /*
   * Fresh statement after both date advisory locks and the appointment row
   * lock. The appointment being moved is excluded from occupancy so it cannot
   * consume capacity against itself.
   */
  v_capacity_result :=
    anaai_private.check_appointment_capacity_business(
      p_business_id,
      p_appointment_date,
      p_appointment_time,
      v_service.duration_minutes,
      p_appointment_id
    );

  if v_capacity_result <> 'AVAILABLE' then
    return jsonb_build_object(
      'success', false,
      'code', v_capacity_result
    );
  end if;

  update public.appointments
  set
    customer_id = v_customer.id,
    service_id = v_service.id,
    customer_name = v_customer.full_name,
    customer_phone = v_customer.phone,
    customer_email = v_customer.email,
    service = v_service.name,
    duration_minutes = v_service.duration_minutes,
    appointment_date = p_appointment_date,
    appointment_time = p_appointment_time,
    notes = nullif(btrim(p_notes), '')
    -- user_id and existing Booked/Confirmed status intentionally preserved.
  where id = p_appointment_id
    and business_id = p_business_id
  returning *
  into v_appointment;

  if not found then
    return jsonb_build_object(
      'success', false,
      'code', 'APPOINTMENT_NOT_FOUND'
    );
  end if;

  return jsonb_build_object(
    'success', true,
    'appointment', jsonb_build_object(
      'id', v_appointment.id,
      'customer_id', v_appointment.customer_id,
      'service_id', v_appointment.service_id,
      'customer_name', v_appointment.customer_name,
      'customer_phone', v_appointment.customer_phone,
      'customer_email', v_appointment.customer_email,
      'service', v_appointment.service,
      'appointment_date', v_appointment.appointment_date,
      'appointment_time', v_appointment.appointment_time,
      'status', v_appointment.status,
      'notes', v_appointment.notes
    )
  );

exception
  when others then
    raise log
      'AnaAI atomic scheduling failed sqlstate=%',
      SQLSTATE;

    return jsonb_build_object(
      'success', false,
      'code', 'INTERNAL_ERROR'
    );
end;
$function$;

revoke all on function public.reschedule_appointment_atomic_business(
  uuid,
  uuid,
  uuid,
  uuid,
  date,
  time,
  text
) from public, anon;

grant execute on function public.reschedule_appointment_atomic_business(
  uuid,
  uuid,
  uuid,
  uuid,
  date,
  time,
  text
) to authenticated;

create or replace function public.voice_book_appointment_business(
  p_business_id uuid,
  p_idempotency_key uuid,
  p_request_fingerprint text,
  p_customer_name text,
  p_customer_phone text,
  p_customer_email text,
  p_service_id uuid,
  p_appointment_date date,
  p_appointment_time time without time zone,
  p_notes text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_action public.appointment_actions%rowtype;
  v_service_name text;
  v_duration_minutes integer;
  v_business_hours_text text;
  v_business_hours jsonb;
  v_day_key text;
  v_day_hours jsonb;
  v_open_time time without time zone;
  v_close_time time without time zone;
  v_requested_start timestamp without time zone;
  v_requested_end timestamp without time zone;
  v_capacity text;
  v_customer_id uuid;
  v_appointment_id uuid;
  v_appointment public.appointments%rowtype;
  v_request jsonb;
  v_receipt jsonb;
  v_email text;
  v_notes text;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    return jsonb_build_object(
      'success', false,
      'code', 'UNSUPPORTED_ISOLATION',
      'replayed', false
    );
  end if;

  if p_business_id is null
     or p_idempotency_key is null
     or p_request_fingerprint is null
     or length(btrim(p_request_fingerprint)) not between 1 and 512
     or nullif(btrim(p_customer_name), '') is null
     or nullif(btrim(p_customer_phone), '') is null
     or p_service_id is null
     or p_appointment_date is null
     or not isfinite(p_appointment_date)
     or p_appointment_time is null then
    return jsonb_build_object(
      'success', false,
      'code', 'INVALID_REQUEST',
      'replayed', false
    );
  end if;

  if not exists (
    select 1
    from public.businesses b
    where b.id = p_business_id
  ) then
    return jsonb_build_object(
      'success', false,
      'code', 'BUSINESS_NOT_FOUND',
      'replayed', false
    );
  end if;

  v_email := nullif(btrim(coalesce(p_customer_email, '')), '');
  v_notes := coalesce(
    nullif(btrim(coalesce(p_notes, '')), ''),
    'Booked by AnaAI phone receptionist'
  );

  v_request := jsonb_build_object(
    'operation', 'voice_book',
    'customer_name', btrim(p_customer_name),
    'customer_phone', btrim(p_customer_phone),
    'customer_email', v_email,
    'service_id', p_service_id,
    'date', p_appointment_date,
    'time', p_appointment_time,
    'notes', v_notes
  );

  /*
   * Claim the durable action before mutation.
   *
   * actor_user_id is deliberately NULL. A phone-system action must not be
   * falsely attributed to a business owner or staff member.
   */
  insert into public.appointment_actions (
    business_id,
    actor_user_id,
    idempotency_key,
    action_type,
    request_fingerprint,
    request_payload
  )
  values (
    p_business_id,
    null,
    p_idempotency_key,
    'book',
    p_request_fingerprint,
    v_request
  )
  on conflict (business_id, idempotency_key) do nothing
  returning * into v_action;

  if not found then
    select *
    into v_action
    from public.appointment_actions
    where business_id = p_business_id
      and idempotency_key = p_idempotency_key
    for update;

    if not found then
      raise exception 'missing voice action';
    end if;

    if v_action.action_type is distinct from 'book'
       or v_action.request_fingerprint is distinct from p_request_fingerprint
       or v_action.request_payload is distinct from v_request then
      return jsonb_build_object(
        'success', false,
        'code', 'IDEMPOTENCY_CONFLICT',
        'replayed', false
      );
    end if;

    if v_action.completed_at is null then
      return jsonb_build_object(
        'success', false,
        'code', 'ACTION_INCOMPLETE',
        'replayed', false
      );
    end if;

    return v_action.result || jsonb_build_object('replayed', true);
  end if;

  /*
   * Serialize booking attempts for this business and date.
   *
   * This is the SAME lock expression the manual scheduling RPCs use, so a
   * phone booking and a dashboard booking for one business/date can never
   * evaluate capacity against the same stale appointment set.
   */
  perform pg_advisory_xact_lock(
    hashtext(p_business_id::text || ':' || p_appointment_date::text)
  );

  select
    s.name,
    s.duration_minutes
  into
    v_service_name,
    v_duration_minutes
  from public.services s
  where s.id = p_service_id
    and s.business_id = p_business_id
    and s.is_active = true
  limit 1;

  if v_service_name is null then
    v_receipt := jsonb_build_object(
      'success', false,
      'changed', false,
      'code', 'INVALID_SERVICE'
    );
  elsif v_duration_minutes is null or v_duration_minutes <= 0 then
    v_receipt := jsonb_build_object(
      'success', false,
      'changed', false,
      'code', 'INVALID_DURATION'
    );
  else
    select bp.business_hours
    into v_business_hours_text
    from public.business_profiles bp
    where bp.business_id = p_business_id
    order by bp.created_at desc
    limit 1;

    if v_business_hours_text is null then
      v_receipt := jsonb_build_object(
        'success', false,
        'changed', false,
        'code', 'INVALID_HOURS'
      );
    else
      begin
        v_business_hours := v_business_hours_text::jsonb;
      exception
        when others then
          v_receipt := jsonb_build_object(
            'success', false,
            'changed', false,
            'code', 'INVALID_HOURS'
          );
      end;

      if v_receipt is null then
        v_day_key :=
          case extract(dow from p_appointment_date)::integer
            when 0 then 'sunday'
            when 1 then 'monday'
            when 2 then 'tuesday'
            when 3 then 'wednesday'
            when 4 then 'thursday'
            when 5 then 'friday'
            when 6 then 'saturday'
          end;

        v_day_hours := v_business_hours -> v_day_key;

        if v_day_hours is null then
          v_receipt := jsonb_build_object(
            'success', false,
            'changed', false,
            'code', 'INVALID_HOURS'
          );
        elsif coalesce((v_day_hours ->> 'closed')::boolean, false) then
          v_receipt := jsonb_build_object(
            'success', false,
            'changed', false,
            'code', 'CLOSED'
          );
        else
          begin
            v_open_time := (v_day_hours ->> 'open')::time;
            v_close_time := (v_day_hours ->> 'close')::time;
          exception
            when others then
              v_receipt := jsonb_build_object(
                'success', false,
                'changed', false,
                'code', 'INVALID_HOURS'
              );
          end;
        end if;
      end if;
    end if;
  end if;

  if v_receipt is null then
    v_requested_start :=
      p_appointment_date::timestamp + p_appointment_time;

    v_requested_end :=
      v_requested_start + make_interval(mins => v_duration_minutes);

    if p_appointment_time < v_open_time
       or v_requested_end >
          (p_appointment_date::timestamp + v_close_time) then
      v_receipt := jsonb_build_object(
        'success', false,
        'changed', false,
        'code', 'OUTSIDE_HOURS'
      );
    end if;
  end if;

  if v_receipt is null then
    /*
     * Peak simultaneous occupancy against businesses.appointment_capacity,
     * evaluated while the business/date advisory lock is held and before any
     * customer or appointment mutation.
     *
     * Booked and Confirmed consume capacity; Cancelled and Completed do not.
     * Intervals are half-open [start, end). Nothing is excluded: this is
     * always a new appointment. At capacity 1 this is identical to the loop it
     * replaces.
     */
    v_capacity :=
      anaai_private.check_appointment_capacity_business(
        p_business_id,
        p_appointment_date,
        p_appointment_time,
        v_duration_minutes,
        null
      );

    if v_capacity = 'SLOT_CONFLICT' then
      v_receipt := jsonb_build_object(
        'success', false,
        'changed', false,
        'code', 'SLOT_CONFLICT'
      );
    elsif v_capacity = 'INVALID_EXISTING_SCHEDULE' then
      v_receipt := jsonb_build_object(
        'success', false,
        'changed', false,
        'code', 'INVALID_EXISTING_SCHEDULE'
      );
    elsif v_capacity is distinct from 'AVAILABLE' then
      /*
       * An indeterminate capacity result must never be persisted as a terminal
       * rejection receipt. Raise so the whole invocation rolls back, including
       * the action claim, and the caller may retry with the same key.
       */
      raise exception 'voice capacity check unavailable';
    end if;
  end if;

  if v_receipt is null then
    /*
     * Customer identity is business-scoped and historically persistent.
     *
     * Match the same way the original voice booking boundary did: exact stored
     * phone text within this business. Archived customers remain eligible for
     * identity resolution so a returning caller keeps the same customer id.
     *
     * A successful new booking is a new customer interaction, so reusing an
     * archived record also reactivates it.
     */
    select c.id
    into v_customer_id
    from public.customers c
    where c.business_id = p_business_id
      and c.phone = btrim(p_customer_phone)
    order by
      c.is_active desc,
      c.created_at asc
    limit 1;

    if v_customer_id is null then
      insert into public.customers (
        business_id,
        user_id,
        full_name,
        phone,
        email,
        notes,
        is_active
      )
      values (
        p_business_id,
        null,
        btrim(p_customer_name),
        btrim(p_customer_phone),
        v_email,
        'Created by AnaAI phone booking',
        true
      )
      returning id into v_customer_id;
    else
      update public.customers
      set
        full_name = btrim(p_customer_name),
        email = v_email,
        is_active = true
      where id = v_customer_id
        and business_id = p_business_id;
    end if;

    insert into public.appointments (
      business_id,
      user_id,
      customer_id,
      service_id,
      customer_name,
      customer_phone,
      customer_email,
      service,
      duration_minutes,
      appointment_date,
      appointment_time,
      status,
      notes
    )
    values (
      p_business_id,
      null,
      v_customer_id,
      p_service_id,
      btrim(p_customer_name),
      btrim(p_customer_phone),
      v_email,
      v_service_name,
      v_duration_minutes,
      p_appointment_date,
      p_appointment_time,
      'Booked',
      v_notes
    )
    returning * into v_appointment;

    v_appointment_id := v_appointment.id;

    if v_appointment.business_id is distinct from p_business_id
       or v_appointment.service_id is distinct from p_service_id
       or v_appointment.appointment_date is distinct from p_appointment_date
       or v_appointment.appointment_time is distinct from p_appointment_time
       or v_appointment.status is distinct from 'Booked'
       or v_appointment.customer_id is distinct from v_customer_id then
      raise exception 'invalid voice booking receipt';
    end if;

    v_receipt := jsonb_build_object(
      'success', true,
      'changed', true,
      'code', 'APPLIED',
      'appointment_id', v_appointment.id,
      'customer_id', v_customer_id,
      'business_id', p_business_id,
      'service_id', v_appointment.service_id,
      'service', v_appointment.service,
      'date', v_appointment.appointment_date,
      'time', v_appointment.appointment_time,
      'status', v_appointment.status,
      'appointment', to_jsonb(v_appointment)
    );

    insert into public.appointment_notifications (
      business_id,
      appointment_action_id,
      appointment_id,
      channel,
      notification_kind,
      payload
    )
    values (
      p_business_id,
      v_action.id,
      v_appointment.id,
      'sms',
      'confirmation',
      jsonb_build_object(
        'action', 'book',
        'phone', v_appointment.customer_phone,
        'date', v_appointment.appointment_date,
        'time', v_appointment.appointment_time
      )
    );
  end if;

  v_receipt :=
    v_receipt || jsonb_build_object(
      'action_id', v_action.id,
      'action_type', 'book',
      'business_id', p_business_id,
      'receipt_scope', 'action_outcome',
      'replayed', false,
      'completed_at', clock_timestamp()
    );

  update public.appointment_actions
  set
    success = (v_receipt ->> 'success')::boolean,
    changed = (v_receipt ->> 'changed')::boolean,
    appointment_id = v_appointment_id,
    result = v_receipt,
    completed_at = (v_receipt ->> 'completed_at')::timestamptz
  where id = v_action.id
    and business_id = p_business_id;

  if not found then
    raise exception 'missing voice action receipt';
  end if;

  return v_receipt;

exception
  when others then
    raise log 'AnaAI voice booking failed sqlstate=%', SQLSTATE;

    return jsonb_build_object(
      'success', false,
      'code', 'INTERNAL_ERROR',
      'replayed', false
    );
end;
$function$;

revoke all on function public.voice_book_appointment_business(
  uuid, uuid, text, text, text, text, uuid, date, time without time zone, text
) from public, anon, authenticated;

grant execute on function public.voice_book_appointment_business(
  uuid, uuid, text, text, text, text, uuid, date, time without time zone, text
) to service_role;


/*
 * Legacy AI-chat booking. Privileges are deliberately NOT restated: CREATE OR
 * REPLACE preserves the existing ACL, and the deployed grants are a separate
 * legacy contract, exactly as in 202609210006.
 */
create or replace function public.book_appointment_atomic_business(
  p_business_id uuid,
  p_customer_name text,
  p_customer_phone text,
  p_customer_email text,
  p_service_id uuid,
  p_appointment_date date,
  p_appointment_time time without time zone,
  p_notes text default null::text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path to 'public'
as $function$
declare
  v_user_id uuid;

  v_service_name text;
  v_duration_minutes integer;

  v_business_hours_text text;
  v_business_hours jsonb;
  v_day_key text;
  v_day_hours jsonb;

  v_open_time time without time zone;
  v_close_time time without time zone;

  v_requested_start timestamp without time zone;
  v_requested_end timestamp without time zone;

  v_capacity text;

  v_customer_id uuid;
  v_appointment_id uuid;
begin
  /*
   * The person calling this RPC must be authenticated.
   */
  v_user_id := auth.uid();

  if v_user_id is null then
    return jsonb_build_object(
      'success', false,
      'reason', 'Authentication is required.'
    );
  end if;

  /*
   * A business must be explicitly supplied.
   */
  if p_business_id is null then
    return jsonb_build_object(
      'success', false,
      'reason', 'Business context is required.'
    );
  end if;

  /*
   * The authenticated user must belong to this business.
   */
  if not public.is_business_member(p_business_id) then
    return jsonb_build_object(
      'success', false,
      'reason', 'You do not have access to this business.'
    );
  end if;

  if nullif(trim(p_customer_name), '') is null then
    return jsonb_build_object(
      'success', false,
      'reason', 'Customer name is required.'
    );
  end if;

  if nullif(trim(p_customer_phone), '') is null then
    return jsonb_build_object(
      'success', false,
      'reason', 'Customer phone number is required.'
    );
  end if;

  if p_service_id is null then
    return jsonb_build_object(
      'success', false,
      'reason', 'Service is required.'
    );
  end if;

  if p_appointment_date is null then
    return jsonb_build_object(
      'success', false,
      'reason', 'Appointment date is required.'
    );
  end if;

  if p_appointment_time is null then
    return jsonb_build_object(
      'success', false,
      'reason', 'Appointment time is required.'
    );
  end if;

  perform pg_advisory_xact_lock(
    hashtext(
      p_business_id::text ||
      ':' ||
      p_appointment_date::text
    )
  );

  select
    s.name,
    s.duration_minutes
  into
    v_service_name,
    v_duration_minutes
  from public.services s
  where s.id = p_service_id
    and s.business_id = p_business_id
    and s.is_active = true
  limit 1;

  if v_service_name is null then
    return jsonb_build_object(
      'success', false,
      'reason', 'The selected service could not be found.'
    );
  end if;

  if v_duration_minutes is null or v_duration_minutes <= 0 then
    return jsonb_build_object(
      'success', false,
      'reason', 'The selected service does not have a valid duration.'
    );
  end if;

  select bp.business_hours
  into v_business_hours_text
  from public.business_profiles bp
  where bp.business_id = p_business_id
  order by bp.created_at desc
  limit 1;

  if v_business_hours_text is null then
    return jsonb_build_object(
      'success', false,
      'reason', 'Business hours have not been configured.'
    );
  end if;

  begin
    v_business_hours := v_business_hours_text::jsonb;
  exception
    when others then
      return jsonb_build_object(
        'success', false,
        'reason', 'Business hours are not stored in a valid format.'
      );
  end;

  v_day_key :=
    case extract(dow from p_appointment_date)::integer
      when 0 then 'sunday'
      when 1 then 'monday'
      when 2 then 'tuesday'
      when 3 then 'wednesday'
      when 4 then 'thursday'
      when 5 then 'friday'
      when 6 then 'saturday'
    end;

  v_day_hours := v_business_hours -> v_day_key;

  if v_day_hours is null then
    return jsonb_build_object(
      'success', false,
      'reason', 'Business hours are not configured for that day.'
    );
  end if;

  if coalesce((v_day_hours ->> 'closed')::boolean, false) then
    return jsonb_build_object(
      'success', false,
      'reason', 'The business is closed on that day.'
    );
  end if;

  begin
    v_open_time := (v_day_hours ->> 'open')::time;
    v_close_time := (v_day_hours ->> 'close')::time;
  exception
    when others then
      return jsonb_build_object(
        'success', false,
        'reason', 'Business hours for that day are invalid.'
      );
  end;

  v_requested_start :=
    p_appointment_date::timestamp +
    p_appointment_time;

  v_requested_end :=
    v_requested_start +
    make_interval(mins => v_duration_minutes);

  if p_appointment_time < v_open_time then
    return jsonb_build_object(
      'success', false,
      'reason', 'The requested appointment starts before opening time.'
    );
  end if;

  if v_requested_end >
     (p_appointment_date::timestamp + v_close_time) then
    return jsonb_build_object(
      'success', false,
      'reason', 'The requested appointment would finish after closing time.'
    );
  end if;

  /*
   * CAPACITY
   *
   * This replaces the per-appointment overlap loop that stood here.
   *
   * Peak simultaneous occupancy against businesses.appointment_capacity, using
   * the same shared helper as manual scheduling and Voice. Booked and
   * Confirmed consume capacity; Cancelled and Completed do not. Intervals use
   * the real service duration and are half-open [start, end), so an
   * appointment ending exactly when another begins does not conflict. Nothing
   * is excluded: this path only ever creates a new appointment.
   *
   * At capacity 1 this is identical to the loop it replaces.
   *
   * It runs while the business/date advisory lock above is held, so a
   * competitor that committed while this transaction waited is visible, and it
   * runs BEFORE any customer lookup, creation or update, so a capacity
   * rejection never mutates customer state.
   *
   * Schema-qualified because search_path is 'public'.
   */
  v_capacity :=
    anaai_private.check_appointment_capacity_business(
      p_business_id,
      p_appointment_date,
      p_appointment_time,
      v_duration_minutes,
      null
    );

  if v_capacity = 'SLOT_CONFLICT' then
    return jsonb_build_object(
      'success', false,
      'reason', 'That time overlaps an existing appointment.'
    );
  end if;

  if v_capacity = 'INVALID_EXISTING_SCHEDULE' then
    return jsonb_build_object(
      'success', false,
      'reason', 'An existing appointment does not have a valid service duration, so availability cannot be checked safely.'
    );
  end if;

  if v_capacity is distinct from 'AVAILABLE' then
    /*
     * Indeterminate. There is no allowlisted legacy reason for this, and a
     * slot whose occupancy could not be computed must never be booked. This
     * function has no exception handler, so the raise reaches the caller's
     * handler and rolls the whole invocation back, writing nothing.
     */
    raise exception 'legacy capacity check unavailable';
  end if;

  select c.id
  into v_customer_id
  from public.customers c
  where c.business_id = p_business_id
    and c.phone = trim(p_customer_phone)
  order by c.created_at asc
  limit 1;

  if v_customer_id is null then
    insert into public.customers (
      business_id,
      user_id,
      full_name,
      phone,
      email,
      notes
    )
    values (
      p_business_id,
      v_user_id,
      trim(p_customer_name),
      trim(p_customer_phone),
      nullif(
        trim(
          coalesce(
            p_customer_email,
            ''
          )
        ),
        ''
      ),
      'Created by AnaAI booking'
    )
    returning id into v_customer_id;
  else
    update public.customers
    set
      full_name = trim(p_customer_name),
      email = nullif(
        trim(
          coalesce(
            p_customer_email,
            ''
          )
        ),
        ''
      )
    where id = v_customer_id
      and business_id = p_business_id;
  end if;

  insert into public.appointments (
    business_id,
    user_id,
    customer_id,
    service_id,
    customer_name,
    customer_phone,
    customer_email,
    service,
    duration_minutes,
    appointment_date,
    appointment_time,
    status,
    notes
  )
  values (
    p_business_id,
    v_user_id,
    v_customer_id,
    p_service_id,
    trim(p_customer_name),
    trim(p_customer_phone),
    nullif(
      trim(
        coalesce(
          p_customer_email,
          ''
        )
      ),
      ''
    ),
    v_service_name,
    v_duration_minutes,
    p_appointment_date,
    p_appointment_time,
    'Booked',
    coalesce(
      nullif(
        trim(
          coalesce(
            p_notes,
            ''
          )
        ),
        ''
      ),
      'Booked by AnaAI'
    )
  )
  returning id into v_appointment_id;

  return jsonb_build_object(
    'success', true,
    'appointment_id', v_appointment_id,
    'customer_id', v_customer_id,
    'customer_name', trim(p_customer_name),
    'customer_phone', trim(p_customer_phone),
    'service', v_service_name,
    'service_id', p_service_id,
    'business_id', p_business_id,
    'date', p_appointment_date,
    'time', p_appointment_time,
    'status', 'Booked'
  );
end;
$function$;

commit;
