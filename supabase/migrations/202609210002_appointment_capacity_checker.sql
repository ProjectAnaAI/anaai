-- AnaAI shared appointment-capacity checker.
--
-- REVIEW ONLY: do not deploy until authenticated integration/concurrency tests
-- pass. Callers must hold the business/date advisory lock and must already have
-- validated auth.uid() and business membership. This helper is a calculation,
-- not an authorization boundary and not a mutation.
--
-- Placement: the helper lives in a dedicated NON-PUBLIC schema.
--
--   PostgREST exposes only the `public` (and `graphql_public`) schema, so a
--   function in `anaai_private` has no client-facing RPC surface even though
--   `authenticated` holds EXECUTE on it. EXECUTE is required because the
--   authoritative scheduling RPCs are SECURITY INVOKER: when a member calls
--   them directly they execute as `authenticated`, and a fully revoked helper
--   would make them fail closed with INTERNAL_ERROR.
--
--   The repository's stronger pattern (`public._appointment_lifecycle_action`,
--   fully revoked from `authenticated`) is only available to SECURITY DEFINER
--   callers. Converting the manual scheduling RPCs to SECURITY DEFINER to reuse
--   it would remove the RLS-as-defense-in-depth they rely on today, so it is
--   deliberately not done here.
--
-- Semantics:
--   - Booked and Confirmed consume one unit of capacity each.
--   - Cancelled and Completed consume nothing.
--   - Intervals are half-open [start, end): an appointment ending exactly when
--     another begins does not overlap.
--   - The decision is PEAK simultaneous occupancy inside the requested
--     interval, not a naive count of overlapping appointments.
--   - p_exclude_appointment_id removes the appointment being rescheduled so it
--     cannot consume capacity against itself.
--
-- Return vocabulary is deliberately limited to codes the deployed callers
-- already allowlist (public.schedule_appointment_idempotent_business and
-- app/api/appointments/route.ts). No new client-visible code is introduced:
--   AVAILABLE | SLOT_CONFLICT | INVALID_SCHEDULE
--   | INVALID_EXISTING_SCHEDULE | INTERNAL_ERROR

begin;

create schema if not exists anaai_private;

comment on schema anaai_private is
  'Internal AnaAI helpers. Never add this schema to the PostgREST exposed schema list.';

-- No ambient rights, and no object creation by client roles.
revoke all on schema anaai_private from public;

-- USAGE only. It grants no access to any object that is not separately granted.
grant usage on schema anaai_private to authenticated;
grant usage on schema anaai_private to service_role;

-- An earlier draft of this milestone placed the helper in `public`, where
-- PostgREST would have exposed it as a client-callable RPC. Remove it.
drop function if exists public.check_appointment_capacity_business(
  uuid,
  date,
  time without time zone,
  integer,
  uuid
);

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
      case
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
        else (
          select
            case when count(*) = 1 then min(s.duration_minutes) end
          from public.services s
          where s.business_id = p_business_id
            and lower(s.name) = lower(a.service)
        )
      end as duration_minutes
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

/*
 * No ambient EXECUTE. `anon` is never granted: unauthenticated callers have no
 * scheduling path. `authenticated` gets EXECUTE only so the SECURITY INVOKER
 * scheduling RPCs can call it after their own auth.uid() and membership checks;
 * the non-public schema keeps it off the PostgREST RPC surface.
 */
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

commit;
