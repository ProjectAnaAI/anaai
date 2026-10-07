--
-- PostgreSQL database dump
--

\restrict 2oHa3YZPmuhDfI0rgLOGqoHSFgQ0z2VsvOnDUQ9r8EMAHORkymxWO1DYPgEq0sU

-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.11 (Debian 17.11-1.pgdg13+2)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: anaai_private; Type: SCHEMA; Schema: -; Owner: postgres
--

CREATE SCHEMA anaai_private;


ALTER SCHEMA anaai_private OWNER TO postgres;

--
-- Name: SCHEMA anaai_private; Type: COMMENT; Schema: -; Owner: postgres
--

COMMENT ON SCHEMA anaai_private IS 'Internal AnaAI helpers. Never add this schema to the PostgREST exposed schema list.';


--
-- Name: public; Type: SCHEMA; Schema: -; Owner: pg_database_owner
--

CREATE SCHEMA public;


ALTER SCHEMA public OWNER TO pg_database_owner;

--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: pg_database_owner
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: appointment_lifecycle_core(uuid, uuid, uuid, text, text, uuid); Type: FUNCTION; Schema: anaai_private; Owner: postgres
--

CREATE FUNCTION anaai_private.appointment_lifecycle_core(p_business_id uuid, p_appointment_id uuid, p_idempotency_key uuid, p_request_fingerprint text, p_action_type text, p_preclaimed_action uuid DEFAULT NULL::uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  v_user_id uuid := auth.uid();
  v_action public.appointment_actions%rowtype;
  v_appointment public.appointments%rowtype;
  v_source_date date;
  v_previous_status text;
  v_target_status text;
  v_code text;
  v_success boolean := false;
  v_changed boolean := false;
  v_receipt jsonb;
begin
  if auth.role() is distinct from 'service_role' then
  if v_user_id is null then
    return jsonb_build_object(
      'success', false,
      'code', 'UNAUTHORIZED',
      'replayed', false
    );
  end if;

  if p_business_id is null
     or not coalesce(
       public.is_business_member(p_business_id),
       false
     ) then
    return jsonb_build_object(
      'success', false,
      'code', 'FORBIDDEN',
      'replayed', false
    );
  end if;

  end if;
  if current_setting('transaction_isolation') <> 'read committed' then
    return jsonb_build_object(
      'success', false,
      'code', 'UNSUPPORTED_ISOLATION',
      'replayed', false
    );
  end if;

  if p_appointment_id is null
     or p_idempotency_key is null
     or p_request_fingerprint is null
     or length(btrim(p_request_fingerprint)) not between 1 and 512
     or p_action_type is null
     or p_action_type not in (
       'confirm',
       'cancel',
       'complete'
     ) then
    return jsonb_build_object(
      'success', false,
      'code', 'INVALID_REQUEST',
      'replayed', false
    );
  end if;

  if p_preclaimed_action is null then
  insert into public.appointment_actions (
    business_id,
    actor_user_id,
    idempotency_key,
    action_type,
    request_fingerprint,
    appointment_id
  )
  values (
    p_business_id,
    v_user_id,
    p_idempotency_key,
    p_action_type,
    p_request_fingerprint,
    p_appointment_id
  )
  on conflict (business_id, idempotency_key)
  do nothing
  returning *
  into v_action;

  if not found then
    select *
    into v_action
    from public.appointment_actions
    where business_id = p_business_id
      and idempotency_key = p_idempotency_key
    for update;

    if not found then
      raise exception 'missing action';
    end if;

    if v_action.action_type is distinct from p_action_type
       or v_action.request_fingerprint is distinct from p_request_fingerprint
       or v_action.appointment_id is distinct from p_appointment_id then
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

    return v_action.result
      || jsonb_build_object(
        'replayed', true
      );
  end if;

  else
    -- Only the fully revoked core accepts an already-locked Voice ledger claim.
    select * into v_action from public.appointment_actions
      where id=p_preclaimed_action and business_id=p_business_id
        and appointment_id=p_appointment_id and idempotency_key=p_idempotency_key
        and action_type=p_action_type and request_fingerprint=p_request_fingerprint
        and completed_at is null for update;
    if not found then raise exception 'invalid claim'; end if;
  end if;

  select appointment_date
  into v_source_date
  from public.appointments
  where id = p_appointment_id
    and business_id = p_business_id;

  if not found then
    v_code := 'APPOINTMENT_NOT_FOUND';
  else
    if v_source_date is not null then
      perform pg_advisory_xact_lock(
        hashtext(
          p_business_id::text
          || ':'
          || v_source_date::text
        )
      );
    end if;

    select *
    into v_appointment
    from public.appointments
    where id = p_appointment_id
      and business_id = p_business_id
    for update;

    if not found then
      v_code := 'APPOINTMENT_NOT_FOUND';

    elsif v_appointment.appointment_date
      is distinct from v_source_date then
      v_code := 'SOURCE_DATE_CHANGED';

    else
      v_previous_status := v_appointment.status;

      v_target_status :=
        case p_action_type
          when 'confirm' then 'Confirmed'
          when 'cancel' then 'Cancelled'
          when 'complete' then 'Completed'
        end;

      if v_previous_status = v_target_status then
        v_success := true;
        v_code := 'ALREADY_IN_TARGET_STATE';

      elsif (
        p_action_type = 'confirm'
        and v_previous_status = 'Booked'
      ) or (
        p_action_type = 'cancel'
        and v_previous_status in (
          'Booked',
          'Confirmed'
        )
      ) or (
        p_action_type = 'complete'
        and v_previous_status = 'Confirmed'
      ) then
        update public.appointments
        set status = v_target_status
        where id = p_appointment_id
          and business_id = p_business_id
        returning *
        into v_appointment;

        if not found then
          raise exception 'missing updated appointment';
        end if;

        if v_appointment.status
          is distinct from v_target_status then
          raise exception 'unexpected transition';
        end if;

        v_success := true;
        v_changed := true;
        v_code := 'APPLIED';

      else
        v_code := 'INVALID_TRANSITION';
      end if;
    end if;
  end if;

  v_receipt := jsonb_build_object(
    'success', v_success,
    'changed', v_changed,
    'code', v_code,
    'replayed', false,
    'action_id', v_action.id,
    'action_type', p_action_type,
    'business_id', p_business_id,
    'appointment_id', p_appointment_id,
    'previous_status', v_previous_status,
    'status',
      case
        when v_success then v_target_status
        else v_previous_status
      end,
    'appointment',
      case
        when v_success then to_jsonb(v_appointment)
        else null
      end,
    'receipt_scope', 'action_outcome',
    'completed_at', clock_timestamp()
  );

  /*
   * Confirmation and cancellation keep their existing SMS
   * behavior. Completion intentionally creates no notification.
   */
  if v_changed
     and p_action_type in (
       'confirm',
       'cancel'
     ) then
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
      p_appointment_id,
      'sms',
      case
        when p_action_type = 'confirm'
          then 'confirmation'
        else 'cancellation'
      end,
      jsonb_build_object(
        'action', p_action_type,
        'phone', v_appointment.customer_phone,
        'date', v_appointment.appointment_date,
        'time', v_appointment.appointment_time
      )
    );

    if not found then
      raise exception 'missing notification';
    end if;
  end if;

  update public.appointment_actions
  set
    success = v_success,
    changed = v_changed,
    result = v_receipt,
    completed_at =
      (v_receipt ->> 'completed_at')::timestamptz
  where id = v_action.id
    and business_id = p_business_id;

  if not found then
    raise exception 'missing receipt';
  end if;

  return v_receipt;

exception
  when others then
    raise log
      'AnaAI lifecycle action failed sqlstate=%',
      SQLSTATE;

    return jsonb_build_object(
      'success', false,
      'code', 'INTERNAL_ERROR',
      'replayed', false
    );
end;
$$;


ALTER FUNCTION anaai_private.appointment_lifecycle_core(p_business_id uuid, p_appointment_id uuid, p_idempotency_key uuid, p_request_fingerprint text, p_action_type text, p_preclaimed_action uuid) OWNER TO postgres;

--
-- Name: check_appointment_capacity_business(uuid, date, time without time zone, integer, uuid); Type: FUNCTION; Schema: anaai_private; Owner: postgres
--

CREATE FUNCTION anaai_private.check_appointment_capacity_business(p_business_id uuid, p_appointment_date date, p_appointment_time time without time zone, p_duration_minutes integer, p_exclude_appointment_id uuid DEFAULT NULL::uuid) RETURNS text
    LANGUAGE plpgsql STABLE
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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
$$;


ALTER FUNCTION anaai_private.check_appointment_capacity_business(p_business_id uuid, p_appointment_date date, p_appointment_time time without time zone, p_duration_minutes integer, p_exclude_appointment_id uuid) OWNER TO postgres;

--
-- Name: reschedule_appointment_core(uuid, uuid, uuid, uuid, date, time without time zone, text, boolean); Type: FUNCTION; Schema: anaai_private; Owner: postgres
--

CREATE FUNCTION anaai_private.reschedule_appointment_core(p_business_id uuid, p_appointment_id uuid, p_customer_id uuid, p_service_id uuid, p_appointment_date date, p_appointment_time time without time zone, p_notes text DEFAULT NULL::text, p_check_only boolean DEFAULT false) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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
  -- Only trusted service requests bypass member authentication. RLS remains
  -- in force for authenticated invokers; this schema is not exposed by PostgREST.
  if auth.role() is distinct from 'service_role' then
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

  if v_capacity_result is distinct from 'AVAILABLE' then
    return jsonb_build_object(
      'success', false,
      'code', v_capacity_result
    );
  end if;

  if p_check_only then
    return jsonb_build_object('success', true, 'code', 'AVAILABLE',
      'duration_minutes', v_service.duration_minutes);
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
$$;


ALTER FUNCTION anaai_private.reschedule_appointment_core(p_business_id uuid, p_appointment_id uuid, p_customer_id uuid, p_service_id uuid, p_appointment_date date, p_appointment_time time without time zone, p_notes text, p_check_only boolean) OWNER TO postgres;

--
-- Name: voice_customer(uuid, text); Type: FUNCTION; Schema: anaai_private; Owner: postgres
--

CREATE FUNCTION anaai_private.voice_customer(p_business_id uuid, p_caller_phone text) RETURNS uuid
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
  select case when count(*) = 1 then (array_agg(c.id))[1] end
  from public.customers c
  where c.business_id = p_business_id and c.phone = p_caller_phone
    and p_caller_phone ~ '^\+[1-9][0-9]{7,14}$';
$_$;


ALTER FUNCTION anaai_private.voice_customer(p_business_id uuid, p_caller_phone text) OWNER TO postgres;

--
-- Name: _appointment_lifecycle_action(uuid, uuid, uuid, text, text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public._appointment_lifecycle_action(p_business_id uuid, p_appointment_id uuid, p_idempotency_key uuid, p_request_fingerprint text, p_action_type text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    return jsonb_build_object(
      'success', false,
      'code', 'UNAUTHORIZED',
      'replayed', false
    );
  end if;

  if p_business_id is null
     or not coalesce(
       public.is_business_member(p_business_id),
       false
     ) then
    return jsonb_build_object(
      'success', false,
      'code', 'FORBIDDEN',
      'replayed', false
    );
  end if;

  return anaai_private.appointment_lifecycle_core(p_business_id,
    p_appointment_id, p_idempotency_key, p_request_fingerprint, p_action_type);
end;
$$;


ALTER FUNCTION public._appointment_lifecycle_action(p_business_id uuid, p_appointment_id uuid, p_idempotency_key uuid, p_request_fingerprint text, p_action_type text) OWNER TO postgres;

--
-- Name: book_appointment_atomic(text, text, text, uuid, date, time without time zone, text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.book_appointment_atomic(p_customer_name text, p_customer_phone text, p_customer_email text, p_service_id uuid, p_appointment_date date, p_appointment_time time without time zone, p_notes text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
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

  v_existing record;
  v_existing_duration integer;
  v_existing_start timestamp without time zone;
  v_existing_end timestamp without time zone;

  v_customer_id uuid;
  v_appointment_id uuid;
begin
  v_user_id := auth.uid();

  if v_user_id is null then
    return jsonb_build_object(
      'success', false,
      'reason', 'Authentication is required.'
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

  /*
   * Serialize booking attempts for this business + date.
   * This prevents two concurrent requests from both seeing
   * the same time as free before either one inserts.
   */
  perform pg_advisory_xact_lock(
    hashtext(v_user_id::text || ':' || p_appointment_date::text)
  );

  select
    name,
    duration_minutes
  into
    v_service_name,
    v_duration_minutes
  from public.services
  where id = p_service_id
    and user_id = v_user_id
    and is_active = true
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

  select business_hours
  into v_business_hours_text
  from public.business_profiles
  where user_id = v_user_id
  order by created_at desc
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
    p_appointment_date::timestamp + p_appointment_time;

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
   * Check every Booked or Confirmed appointment on the same day.
   */
  for v_existing in
    select
      a.id,
      a.appointment_time,
      a.service_id,
      a.service
    from public.appointments a
    where a.user_id = v_user_id
      and a.appointment_date = p_appointment_date
      and a.status in ('Booked', 'Confirmed')
  loop
    v_existing_duration := null;

    if v_existing.service_id is not null then
      select duration_minutes
      into v_existing_duration
      from public.services
      where id = v_existing.service_id
        and user_id = v_user_id
      limit 1;
    end if;

    if v_existing_duration is null and v_existing.service is not null then
      select duration_minutes
      into v_existing_duration
      from public.services
      where user_id = v_user_id
        and lower(name) = lower(v_existing.service)
      limit 1;
    end if;

    if v_existing_duration is null or v_existing_duration <= 0 then
      return jsonb_build_object(
        'success', false,
        'reason',
        'An existing appointment does not have a valid service duration, so availability cannot be checked safely.'
      );
    end if;

    v_existing_start :=
      p_appointment_date::timestamp +
      v_existing.appointment_time;

    v_existing_end :=
      v_existing_start +
      make_interval(mins => v_existing_duration);

    if
      v_requested_start < v_existing_end
      and v_requested_end > v_existing_start
    then
      return jsonb_build_object(
        'success', false,
        'reason', 'That time overlaps an existing appointment.'
      );
    end if;
  end loop;

  /*
   * Reuse an existing customer with the same phone number.
   */
  select id
  into v_customer_id
  from public.customers
  where user_id = v_user_id
    and phone = trim(p_customer_phone)
  order by created_at asc
  limit 1;

  if v_customer_id is null then
    insert into public.customers (
      user_id,
      full_name,
      phone,
      email,
      notes
    )
    values (
      v_user_id,
      trim(p_customer_name),
      trim(p_customer_phone),
      nullif(trim(coalesce(p_customer_email, '')), ''),
      'Created by AnaAI booking'
    )
    returning id into v_customer_id;
  else
    update public.customers
    set
      full_name = trim(p_customer_name),
      email = nullif(trim(coalesce(p_customer_email, '')), '')
    where id = v_customer_id
      and user_id = v_user_id;
  end if;

  insert into public.appointments (
    user_id,
    customer_id,
    service_id,
    customer_name,
    customer_phone,
    customer_email,
    service,
    appointment_date,
    appointment_time,
    status,
    notes
  )
  values (
    v_user_id,
    v_customer_id,
    p_service_id,
    trim(p_customer_name),
    trim(p_customer_phone),
    nullif(trim(coalesce(p_customer_email, '')), ''),
    v_service_name,
    p_appointment_date,
    p_appointment_time,
    'Booked',
    coalesce(
      nullif(trim(coalesce(p_notes, '')), ''),
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
    'date', p_appointment_date,
    'time', p_appointment_time,
    'status', 'Booked'
  );
end;
$$;


ALTER FUNCTION public.book_appointment_atomic(p_customer_name text, p_customer_phone text, p_customer_email text, p_service_id uuid, p_appointment_date date, p_appointment_time time without time zone, p_notes text) OWNER TO postgres;

--
-- Name: book_appointment_atomic_business(uuid, text, text, text, uuid, date, time without time zone, text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.book_appointment_atomic_business(p_business_id uuid, p_customer_name text, p_customer_phone text, p_customer_email text, p_service_id uuid, p_appointment_date date, p_appointment_time time without time zone, p_notes text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
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
$$;


ALTER FUNCTION public.book_appointment_atomic_business(p_business_id uuid, p_customer_name text, p_customer_phone text, p_customer_email text, p_service_id uuid, p_appointment_date date, p_appointment_time time without time zone, p_notes text) OWNER TO postgres;

--
-- Name: cancel_appointment_atomic_business(uuid, uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.cancel_appointment_atomic_business(p_business_id uuid, p_appointment_id uuid, p_idempotency_key uuid, p_request_fingerprint text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  if auth.uid() is null then return jsonb_build_object('success',false,'code','UNAUTHORIZED'); end if;
  if p_business_id is null or not coalesce(public.is_business_member(p_business_id),false) then
    return jsonb_build_object('success',false,'code','FORBIDDEN'); end if;
  return public._appointment_lifecycle_action(p_business_id,p_appointment_id,p_idempotency_key,p_request_fingerprint,'cancel');
end;
$$;


ALTER FUNCTION public.cancel_appointment_atomic_business(p_business_id uuid, p_appointment_id uuid, p_idempotency_key uuid, p_request_fingerprint text) OWNER TO postgres;

--
-- Name: check_reschedule_appointment_business(uuid, uuid, uuid, uuid, date, time without time zone); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.check_reschedule_appointment_business(p_business_id uuid, p_appointment_id uuid, p_customer_id uuid, p_service_id uuid, p_appointment_date date, p_appointment_time time without time zone) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  if auth.uid() is null then
    return jsonb_build_object('success', false, 'code', 'UNAUTHORIZED');
  end if;
  if p_business_id is null
     or not coalesce(public.is_business_member(p_business_id), false) then
    return jsonb_build_object('success', false, 'code', 'FORBIDDEN');
  end if;

  -- The existing core verifies the scoped appointment/customer/active service,
  -- locks and rereads the source, checks hours/duration/capacity, and excludes
  -- ONLY p_appointment_id. Its check-only branch returns BEFORE any writes.
  -- No phone lookup, service-role bypass, new algorithm, or caller-controlled
  -- check_only flag. RLS and the core's READ COMMITTED requirement still apply.
  return anaai_private.reschedule_appointment_core(
    p_business_id, p_appointment_id, p_customer_id, p_service_id,
    p_appointment_date, p_appointment_time, null, true
  );
end;
$$;


ALTER FUNCTION public.check_reschedule_appointment_business(p_business_id uuid, p_appointment_id uuid, p_customer_id uuid, p_service_id uuid, p_appointment_date date, p_appointment_time time without time zone) OWNER TO postgres;

--
-- Name: claim_appointment_notification(uuid, uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.claim_appointment_notification(p_business_id uuid, p_action_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare v_row public.appointment_notifications%rowtype;
begin
  if auth.uid() is null or not coalesce(public.is_business_member(p_business_id),false) then
    return jsonb_build_object('claimed',false); end if;
  update public.appointment_notifications set status='uncertain',claim_token=gen_random_uuid(),updated_at=clock_timestamp()
    where business_id=p_business_id and appointment_action_id=p_action_id and status='pending'
    returning * into v_row;
  if not found then return jsonb_build_object('claimed',false); end if;
  return jsonb_build_object('claimed',true,'id',v_row.id,'token',v_row.claim_token,'kind',v_row.notification_kind,'payload',v_row.payload);
end;
$$;


ALTER FUNCTION public.claim_appointment_notification(p_business_id uuid, p_action_id uuid) OWNER TO postgres;

--
-- Name: complete_appointment_atomic_business(uuid, uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.complete_appointment_atomic_business(p_business_id uuid, p_appointment_id uuid, p_idempotency_key uuid, p_request_fingerprint text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  if auth.uid() is null then
    return jsonb_build_object(
      'success', false,
      'code', 'UNAUTHORIZED'
    );
  end if;

  if p_business_id is null
     or not coalesce(
       public.is_business_member(p_business_id),
       false
     ) then
    return jsonb_build_object(
      'success', false,
      'code', 'FORBIDDEN'
    );
  end if;

  return public._appointment_lifecycle_action(
    p_business_id,
    p_appointment_id,
    p_idempotency_key,
    p_request_fingerprint,
    'complete'
  );
end;
$$;


ALTER FUNCTION public.complete_appointment_atomic_business(p_business_id uuid, p_appointment_id uuid, p_idempotency_key uuid, p_request_fingerprint text) OWNER TO postgres;

--
-- Name: confirm_appointment_atomic_business(uuid, uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.confirm_appointment_atomic_business(p_business_id uuid, p_appointment_id uuid, p_idempotency_key uuid, p_request_fingerprint text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  if auth.uid() is null then return jsonb_build_object('success',false,'code','UNAUTHORIZED'); end if;
  if p_business_id is null or not coalesce(public.is_business_member(p_business_id),false) then
    return jsonb_build_object('success',false,'code','FORBIDDEN'); end if;
  return public._appointment_lifecycle_action(p_business_id,p_appointment_id,p_idempotency_key,p_request_fingerprint,'confirm');
end;
$$;


ALTER FUNCTION public.confirm_appointment_atomic_business(p_business_id uuid, p_appointment_id uuid, p_idempotency_key uuid, p_request_fingerprint text) OWNER TO postgres;

--
-- Name: create_appointment_atomic_business(uuid, uuid, uuid, date, time without time zone, text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.create_appointment_atomic_business(p_business_id uuid, p_customer_id uuid, p_service_id uuid, p_appointment_date date, p_appointment_time time without time zone, p_notes text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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
$$;


ALTER FUNCTION public.create_appointment_atomic_business(p_business_id uuid, p_customer_id uuid, p_service_id uuid, p_appointment_date date, p_appointment_time time without time zone, p_notes text) OWNER TO postgres;

--
-- Name: create_business_for_current_user(jsonb); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.create_business_for_current_user(p_setup jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
declare
  v_user uuid := auth.uid();
  v_business uuid;
  v_inserted boolean;
  v_day text;
  v_hours jsonb;
  v_service jsonb;
  v_field text;
  v_timezone text;
  v_capacity numeric;
begin
  if v_user is null then
    return jsonb_build_object(
      'success', false,
      'code', 'UNAUTHORIZED'
    );
  end if;

  -- Membership must be read from a fresh statement snapshot after waiting.
  if current_setting('transaction_isolation') <> 'read committed' then
    return jsonb_build_object(
      'success', false,
      'code', 'UNSUPPORTED_ISOLATION'
    );
  end if;

  -- Serialize onboarding for this authenticated login.
  perform pg_advisory_xact_lock(
    hashtextextended(
      'anaai:onboarding:' || v_user::text,
      0
    )
  );

  -- MVP rule: one business/login.
  if exists (
    select 1
    from public.business_members
    where user_id = v_user
  ) then
    return jsonb_build_object(
      'success', false,
      'code', 'ALREADY_PROVISIONED'
    );
  end if;

  -- Validate the complete setup before performing any writes.
  begin
    if jsonb_typeof(p_setup) is distinct from 'object' then
      raise exception 'invalid';
    end if;

    -- Require a JSON number, not a string, null, or an omitted field.
    if jsonb_typeof(p_setup -> 'appointment_capacity') is distinct from 'number' then
      raise exception 'invalid';
    end if;

    -- Validate before the integer cast: PostgreSQL integer casts can round fractions.
    v_capacity := (p_setup ->> 'appointment_capacity')::numeric;
    if v_capacity <> trunc(v_capacity) or v_capacity not between 1 and 100 then
      raise exception 'invalid';
    end if;

    foreach v_field in array array[
      'name',
      'phone',
      'email',
      'address',
      'timezone',
      'receptionist',
      'greeting'
    ]
    loop
      if jsonb_typeof(p_setup -> v_field) is distinct from 'string'
         or length(p_setup ->> v_field) > 2000 then
        raise exception 'invalid';
      end if;
    end loop;

    -- Core business details are mandatory.
    if btrim(p_setup ->> 'name') = ''
       or length(p_setup ->> 'name') > 200
       or btrim(p_setup ->> 'phone') = ''
       or btrim(p_setup ->> 'email') = ''
       or btrim(p_setup ->> 'address') = ''
       or btrim(p_setup ->> 'timezone') = ''
       or length(p_setup ->> 'timezone') > 200
       or btrim(p_setup ->> 'receptionist') = ''
       or btrim(p_setup ->> 'greeting') = '' then
      raise exception 'invalid';
    end if;

    if (p_setup ->> 'email')
       !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
      raise exception 'invalid';
    end if;

    if (p_setup ->> 'phone')
       !~ '^[+0-9[:space:]().-]{7,30}$' then
      raise exception 'invalid';
    end if;

    v_timezone := btrim(p_setup ->> 'timezone');

    if not exists (
      select 1
      from pg_catalog.pg_timezone_names
      where name = v_timezone
    ) then
      raise exception 'invalid';
    end if;

    foreach v_day in array array[
      'monday',
      'tuesday',
      'wednesday',
      'thursday',
      'friday',
      'saturday',
      'sunday'
    ]
    loop
      v_hours := p_setup -> 'hours' -> v_day;

      if jsonb_typeof(v_hours) is distinct from 'object'
         or jsonb_typeof(v_hours -> 'closed')
            is distinct from 'boolean' then
        raise exception 'invalid';
      end if;

      if not (v_hours ->> 'closed')::boolean then
        if jsonb_typeof(v_hours -> 'open') is distinct from 'string'
           or jsonb_typeof(v_hours -> 'close') is distinct from 'string'
           or (v_hours ->> 'open')
              !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
           or (v_hours ->> 'close')
              !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
           or (v_hours ->> 'close')::time
              <= (v_hours ->> 'open')::time then
          raise exception 'invalid';
        end if;
      end if;
    end loop;

    if jsonb_typeof(p_setup -> 'services')
       is distinct from 'array' then
      raise exception 'invalid';
    end if;

    if jsonb_array_length(p_setup -> 'services')
       not between 1 and 50 then
      raise exception 'invalid';
    end if;

    for v_service in
      select value
      from jsonb_array_elements(p_setup -> 'services')
    loop
      foreach v_field in array array[
        'name',
        'duration',
        'price',
        'description'
      ]
      loop
        if jsonb_typeof(v_service -> v_field)
           is distinct from 'string' then
          raise exception 'invalid';
        end if;
      end loop;

      if btrim(v_service ->> 'name') = ''
         or length(v_service ->> 'name') > 200
         or length(v_service ->> 'description') > 2000
         or (v_service ->> 'duration') !~ '^[0-9]+$'
         or (v_service ->> 'duration')::integer
            not between 1 and 1440 then
        raise exception 'invalid';
      end if;

      if (v_service ->> 'price') <> ''
         and (v_service ->> 'price')
             !~ '^[0-9]+(\.[0-9]{1,2})?$' then
        raise exception 'invalid';
      end if;
    end loop;

  exception
    when others then
      return jsonb_build_object(
        'success', false,
        'code', 'INVALID_SETUP'
      );
  end;

  insert into public.businesses (
    name,
    timezone,
    appointment_capacity
  )
  values (
    btrim(p_setup ->> 'name'),
    v_timezone,
    v_capacity::integer
  )
  returning id into v_business;

  if not found then
    raise exception 'provisioning write failed';
  end if;

  insert into public.business_members (
    business_id,
    user_id,
    role
  )
  values (
    v_business,
    v_user,
    'owner'
  )
  returning true into v_inserted;

  if not found then
    raise exception 'provisioning write failed';
  end if;

  insert into public.business_profiles (
    business_id,
    user_id,
    business_name,
    owner_name,
    phone,
    email,
    address,
    business_hours,
    timezone
  )
  values (
    v_business,
    v_user,
    btrim(p_setup ->> 'name'),
    '',
    btrim(p_setup ->> 'phone'),
    btrim(p_setup ->> 'email'),
    btrim(p_setup ->> 'address'),
    (p_setup -> 'hours')::text,
    v_timezone
  )
  returning true into v_inserted;

  if not found then
    raise exception 'provisioning write failed';
  end if;

  for v_service in
    select value
    from jsonb_array_elements(p_setup -> 'services')
  loop
    insert into public.services (
      business_id,
      user_id,
      name,
      duration_minutes,
      price,
      description,
      is_active
    )
    values (
      v_business,
      v_user,
      btrim(v_service ->> 'name'),
      (v_service ->> 'duration')::integer,
      nullif(v_service ->> 'price', '')::numeric,
      nullif(btrim(v_service ->> 'description'), ''),
      true
    )
    returning true into v_inserted;

    if not found then
      raise exception 'provisioning write failed';
    end if;
  end loop;

  insert into public.ai_settings (
    business_id,
    user_id,
    receptionist_name,
    greeting
  )
  values (
    v_business,
    v_user,
    btrim(p_setup ->> 'receptionist'),
    btrim(p_setup ->> 'greeting')
  )
  returning true into v_inserted;

  if not found then
    raise exception 'provisioning write failed';
  end if;

  return jsonb_build_object(
    'success', true
  );

exception
  when others then
    -- The exception handler rolls back writes in this function's protected block.
    -- Never expose submitted values or PostgreSQL error details.
    raise log 'AnaAI provisioning failed SQLSTATE=%', SQLSTATE;

    return jsonb_build_object(
      'success', false,
      'code', 'INTERNAL_ERROR'
    );
end;
$_$;


ALTER FUNCTION public.create_business_for_current_user(p_setup jsonb) OWNER TO postgres;

--
-- Name: finish_appointment_notification(uuid, uuid, uuid, text, text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.finish_appointment_notification(p_business_id uuid, p_notification_id uuid, p_claim_token uuid, p_status text, p_provider_id text DEFAULT NULL::text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
begin
  if auth.uid() is null or not coalesce(public.is_business_member(p_business_id),false)
     or p_status is null or p_status not in ('accepted','failed','uncertain') then return false; end if;
  if p_status='accepted' and (p_provider_id is null or p_provider_id !~ '^SM[0-9a-fA-F]{32}$') then return false; end if;
  update public.appointment_notifications set status=p_status,
    provider_message_id=case when p_status='accepted' then p_provider_id else null end,
    last_error_code=case when p_status='accepted' then null when p_status='failed' then 'NOT_SENT' else 'PROVIDER_OUTCOME_UNKNOWN' end,
    accepted_at=case when p_status='accepted' then clock_timestamp() else null end,
    claim_token=null,updated_at=clock_timestamp()
    where id=p_notification_id and business_id=p_business_id and claim_token=p_claim_token and status='uncertain';
  return found;
end;
$_$;


ALTER FUNCTION public.finish_appointment_notification(p_business_id uuid, p_notification_id uuid, p_claim_token uuid, p_status text, p_provider_id text) OWNER TO postgres;

--
-- Name: is_business_admin(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.is_business_admin(p_business_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select exists (
    select 1
    from public.business_members bm
    where bm.business_id = p_business_id
      and bm.user_id = auth.uid()
      and bm.role in ('owner', 'manager')
  );
$$;


ALTER FUNCTION public.is_business_admin(p_business_id uuid) OWNER TO postgres;

--
-- Name: is_business_member(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.is_business_member(p_business_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select exists (
    select 1
    from public.business_members bm
    where bm.business_id = p_business_id
      and bm.user_id = auth.uid()
  );
$$;


ALTER FUNCTION public.is_business_member(p_business_id uuid) OWNER TO postgres;

--
-- Name: is_business_owner(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.is_business_owner(p_business_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select exists (
    select 1
    from public.business_members bm
    where bm.business_id = p_business_id
      and bm.user_id = auth.uid()
      and bm.role = 'owner'
  );
$$;


ALTER FUNCTION public.is_business_owner(p_business_id uuid) OWNER TO postgres;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: employees; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.employees (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    display_name text NOT NULL,
    role text DEFAULT 'employee'::text NOT NULL,
    pin_hash text NOT NULL,
    pin_salt text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT employees_display_name_not_blank CHECK ((length(btrim(display_name)) > 0)),
    CONSTRAINT employees_pin_hash_not_blank CHECK ((length(btrim(pin_hash)) > 0)),
    CONSTRAINT employees_pin_salt_not_blank CHECK ((length(btrim(pin_salt)) > 0)),
    CONSTRAINT employees_role_check CHECK ((role = ANY (ARRAY['employee'::text, 'manager'::text, 'owner'::text])))
);


ALTER TABLE public.employees OWNER TO postgres;

--
-- Name: m04_write_employee(uuid, uuid, uuid, timestamp with time zone, jsonb, jsonb); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.m04_write_employee(p_business_id uuid, p_actor_id uuid, p_employee_id uuid, p_expected_updated_at timestamp with time zone, p_pin_snapshot jsonb, p_values jsonb) RETURNS SETOF public.employees
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
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


ALTER FUNCTION public.m04_write_employee(p_business_id uuid, p_actor_id uuid, p_employee_id uuid, p_expected_updated_at timestamp with time zone, p_pin_snapshot jsonb, p_values jsonb) OWNER TO postgres;

--
-- Name: m05_assert_employee_identity(uuid, uuid, uuid, uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.m05_assert_employee_identity(p_business_id uuid, p_employee_id uuid, p_device_id uuid, p_session_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


ALTER FUNCTION public.m05_assert_employee_identity(p_business_id uuid, p_employee_id uuid, p_device_id uuid, p_session_id uuid) OWNER TO postgres;

--
-- Name: m05_record_time_event(uuid, uuid, uuid, uuid, text, text, uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.m05_record_time_event(p_business_id uuid, p_employee_id uuid, p_device_id uuid, p_session_id uuid, p_action text, p_break_type text, p_request_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


ALTER FUNCTION public.m05_record_time_event(p_business_id uuid, p_employee_id uuid, p_device_id uuid, p_session_id uuid, p_action text, p_break_type text, p_request_id uuid) OWNER TO postgres;

--
-- Name: m05_report_time_issue(uuid, uuid, uuid, uuid, uuid, date, uuid, text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.m05_report_time_issue(p_business_id uuid, p_employee_id uuid, p_device_id uuid, p_session_id uuid, p_request_id uuid, p_work_date date, p_time_event_id uuid, p_note text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


ALTER FUNCTION public.m05_report_time_issue(p_business_id uuid, p_employee_id uuid, p_device_id uuid, p_session_id uuid, p_request_id uuid, p_work_date date, p_time_event_id uuid, p_note text) OWNER TO postgres;

--
-- Name: m05_time_events_delete_guard(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.m05_time_events_delete_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if exists (select 1 from public.businesses where id = old.business_id) then
    raise exception 'employee_time_events is append-only' using errcode = '42501';
  end if;
  return old;
end;
$$;


ALTER FUNCTION public.m05_time_events_delete_guard() OWNER TO postgres;

--
-- Name: m05_time_events_immutable(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.m05_time_events_immutable() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  raise exception 'employee_time_events is append-only' using errcode = '42501';
end;
$$;


ALTER FUNCTION public.m05_time_events_immutable() OWNER TO postgres;

--
-- Name: reschedule_appointment_atomic_business(uuid, uuid, uuid, uuid, date, time without time zone, text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.reschedule_appointment_atomic_business(p_business_id uuid, p_appointment_id uuid, p_customer_id uuid, p_service_id uuid, p_appointment_date date, p_appointment_time time without time zone, p_notes text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  v_user_id uuid := auth.uid();
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

  return anaai_private.reschedule_appointment_core(p_business_id,
    p_appointment_id, p_customer_id, p_service_id, p_appointment_date,
    p_appointment_time, p_notes, false);
end;
$$;


ALTER FUNCTION public.reschedule_appointment_atomic_business(p_business_id uuid, p_appointment_id uuid, p_customer_id uuid, p_service_id uuid, p_appointment_date date, p_appointment_time time without time zone, p_notes text) OWNER TO postgres;

--
-- Name: schedule_appointment_idempotent_business(uuid, uuid, text, text, jsonb); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.schedule_appointment_idempotent_business(p_business_id uuid, p_idempotency_key uuid, p_request_fingerprint text, p_operation text, p_request jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  v_user uuid := auth.uid();
  v_action public.appointment_actions%rowtype;
  v_row public.appointments%rowtype;
  v_old public.appointments%rowtype;
  v_result jsonb;
  v_receipt jsonb;
  v_request jsonb;
  v_type text;
  v_target uuid;
  v_source date;
  v_date date;
  v_lock_date date;
  v_time time;
  v_customer uuid;
  v_service uuid;
  v_notes text;
  v_changed boolean := true;
  v_notify boolean := false;
  v_id uuid;
  v_rejection_code text;
begin
  if v_user is null then return jsonb_build_object('success',false,'code','UNAUTHORIZED'); end if;
  if p_business_id is null or not coalesce(public.is_business_member(p_business_id),false) then
    return jsonb_build_object('success',false,'code','FORBIDDEN');
  end if;
  if current_setting('transaction_isolation') <> 'read committed' then
    return jsonb_build_object('success',false,'code','UNSUPPORTED_ISOLATION');
  end if;
  if p_idempotency_key is null or p_request_fingerprint is null
     or length(btrim(p_request_fingerprint)) not between 1 and 512
     or p_operation is null or p_operation not in ('manual_book','ai_book','reschedule')
     or jsonb_typeof(p_request) is distinct from 'object' then
    return jsonb_build_object('success',false,'code','INVALID_REQUEST');
  end if;
  begin
    v_date := (p_request ->> 'date')::date;
    v_time := (p_request ->> 'time')::time;
    v_service := (p_request ->> 'service_id')::uuid;
    v_customer := (p_request ->> 'customer_id')::uuid;
    v_target := (p_request ->> 'appointment_id')::uuid;
    v_notes := nullif(btrim(p_request ->> 'notes'),'');
    if v_date is null or not isfinite(v_date) or v_time is null or v_service is null
       or (p_operation <> 'ai_book' and v_customer is null)
       or (p_operation = 'reschedule' and v_target is null)
       or (p_operation <> 'reschedule' and v_target is not null)
       or (p_operation = 'ai_book' and (nullif(btrim(p_request ->> 'customer_name'),'') is null
           or nullif(btrim(p_request ->> 'customer_phone'),'') is null)) then
      return jsonb_build_object('success',false,'code','INVALID_REQUEST');
    end if;
  exception when others then return jsonb_build_object('success',false,'code','INVALID_REQUEST'); end;
  v_type := case when p_operation = 'reschedule' then 'reschedule' else 'book' end;
  -- Preserve all supplied fields, including origin binding, but canonicalize typed values.
  v_request := p_request || jsonb_build_object('operation',p_operation,'date',v_date,
    'time',v_time,'service_id',v_service,'customer_id',v_customer,'appointment_id',v_target,'notes',v_notes);
  insert into public.appointment_actions
    (business_id,actor_user_id,idempotency_key,action_type,request_fingerprint,request_payload,appointment_id)
    values (p_business_id,v_user,p_idempotency_key,v_type,p_request_fingerprint,v_request,v_target)
    on conflict (business_id,idempotency_key) do nothing returning * into v_action;
  if not found then
    select * into v_action from public.appointment_actions
      where business_id=p_business_id and idempotency_key=p_idempotency_key for update;
    if not found then raise exception 'missing action'; end if;
    if v_action.action_type is distinct from v_type
       or v_action.request_fingerprint is distinct from p_request_fingerprint
       or v_action.request_payload is distinct from v_request then
      return jsonb_build_object('success',false,'code','IDEMPOTENCY_CONFLICT');
    end if;
    if v_action.completed_at is null then return jsonb_build_object('success',false,'code','ACTION_INCOMPLETE'); end if;
    return v_action.result || jsonb_build_object('replayed',true);
  end if;

  if p_operation = 'reschedule' then
    -- Hold the same ordered scheduling locks as the proven reschedule RPC before
    -- reading the authoritative old state (for no-op and notification decisions).
    select appointment_date into v_source from public.appointments
      where id=v_target and business_id=p_business_id;
    if not found then v_result := jsonb_build_object('success',false,'code','APPOINTMENT_NOT_FOUND');
    elsif v_source is null or not isfinite(v_source) then v_result := jsonb_build_object('success',false,'code','INVALID_EXISTING_SCHEDULE');
    else
      for v_lock_date in select distinct d from (values(v_source),(v_date)) dates(d) order by d loop
        perform pg_advisory_xact_lock(hashtext(p_business_id::text || ':' || v_lock_date::text));
      end loop;
      select * into v_old from public.appointments where id=v_target and business_id=p_business_id for update;
      if not found then v_result := jsonb_build_object('success',false,'code','APPOINTMENT_NOT_FOUND');
      elsif v_old.appointment_date is distinct from v_source then v_result := jsonb_build_object('success',false,'code','SOURCE_DATE_CHANGED');
      elsif v_old.status is null or v_old.status not in ('Booked','Confirmed') then v_result := jsonb_build_object('success',false,'code','TERMINAL_APPOINTMENT');
      elsif v_old.customer_id = v_customer and v_old.service_id = v_service
        and v_old.appointment_date = v_date and v_old.appointment_time = v_time
        and nullif(btrim(v_old.notes),'') is not distinct from v_notes then
        if not exists(select 1 from public.customers where id=v_customer and business_id=p_business_id) then
          v_result := jsonb_build_object('success',false,'code','INVALID_CUSTOMER');
        elsif not exists(select 1 from public.services where id=v_service and business_id=p_business_id and is_active=true and duration_minutes>0) then
          v_result := jsonb_build_object('success',false,'code','INVALID_SERVICE');
        else
          v_changed := false;
          v_result := jsonb_build_object('success',true,'appointment',to_jsonb(v_old));
        end if;
      else
        v_result := public.reschedule_appointment_atomic_business(p_business_id,v_target,v_customer,v_service,v_date,v_time,v_notes);
        v_notify := v_old.appointment_date is distinct from v_date or v_old.appointment_time is distinct from v_time or v_old.service_id is distinct from v_service;
      end if;
    end if;
  elsif p_operation = 'manual_book' then
    v_result := public.create_appointment_atomic_business(p_business_id,v_customer,v_service,v_date,v_time,v_notes);
  else
    v_result := public.book_appointment_atomic_business(p_business_id,
      btrim(p_request ->> 'customer_name'), btrim(p_request ->> 'customer_phone'),
      nullif(btrim(p_request ->> 'customer_email'),''),v_service,v_date,v_time,v_notes);
    v_notify := true;
  end if;

  if v_result -> 'success' = 'true'::jsonb then
    v_id := coalesce(v_result ->> 'appointment_id',v_result -> 'appointment' ->> 'id')::uuid;
    select * into v_row from public.appointments where id=v_id and business_id=p_business_id;
    if not found then raise exception 'missing authoritative appointment'; end if;
    if v_row.service_id is distinct from v_service or v_row.appointment_date is distinct from v_date
       or v_row.appointment_time is distinct from v_time
       or (p_operation <> 'ai_book' and v_row.customer_id is distinct from v_customer)
       or (p_operation = 'reschedule' and (v_row.id is distinct from v_target or v_row.status is distinct from v_old.status))
       or (p_operation <> 'reschedule' and v_row.status is distinct from 'Booked') then raise exception 'invalid receipt'; end if;
    if not exists(select 1 from public.customers where id=v_row.customer_id and business_id=p_business_id)
       or not exists(select 1 from public.services where id=v_row.service_id and business_id=p_business_id) then raise exception 'invalid references'; end if;
    v_receipt := jsonb_build_object('success',true,'changed',v_changed,'code',case when v_changed then 'APPLIED' else 'ALREADY_IN_TARGET_STATE' end,
      'appointment_id',v_row.id,'customer_id',v_row.customer_id,'business_id',p_business_id,
      'service_id',v_row.service_id,'service',v_row.service,'date',v_row.appointment_date,'time',v_row.appointment_time,
      'status',v_row.status,'appointment',to_jsonb(v_row));
  else
    -- Unknown/legacy reason strings never escape. Unexpected failures roll back
    -- the entire wrapper, including a possible inner function partial mutation.
    if v_result -> 'success' is distinct from 'false'::jsonb or coalesce(v_result ->> 'code','') in ('INTERNAL_ERROR','UNSUPPORTED_ISOLATION') then raise exception 'scheduling failure'; end if;
    -- Verified deployed legacy contract: these exact rejections precede all
    -- customer writes and appointment insertion. Persist only recognized outcomes.
    -- Do not trim/fuzzy-match text or allow an unexpected response shape.
    if p_operation = 'ai_book' then
      if jsonb_typeof(v_result) is distinct from 'object'
         or jsonb_typeof(v_result -> 'reason') is distinct from 'string'
         or (v_result - 'success' - 'reason') <> '{}'::jsonb then
        raise exception 'malformed legacy rejection';
      end if;
      v_rejection_code := case v_result ->> 'reason'
        when 'Authentication is required.' then 'UNAUTHORIZED'
        when 'Business context is required.' then 'INVALID_REQUEST'
        when 'You do not have access to this business.' then 'FORBIDDEN'
        when 'Customer name is required.' then 'INVALID_CUSTOMER'
        when 'Customer phone number is required.' then 'INVALID_CUSTOMER'
        when 'Service is required.' then 'INVALID_SERVICE'
        when 'Appointment date is required.' then 'INVALID_SCHEDULE'
        when 'Appointment time is required.' then 'INVALID_SCHEDULE'
        when 'The selected service could not be found.' then 'INVALID_SERVICE'
        when 'The selected service does not have a valid duration.' then 'INVALID_DURATION'
        when 'Business hours have not been configured.' then 'INVALID_HOURS'
        when 'Business hours are not stored in a valid format.' then 'INVALID_HOURS'
        when 'Business hours are not configured for that day.' then 'INVALID_HOURS'
        when 'The business is closed on that day.' then 'CLOSED'
        when 'Business hours for that day are invalid.' then 'INVALID_HOURS'
        when 'The requested appointment starts before opening time.' then 'OUTSIDE_HOURS'
        when 'The requested appointment would finish after closing time.' then 'OUTSIDE_HOURS'
        when 'An existing appointment does not have a valid service duration, so availability cannot be checked safely.' then 'INVALID_EXISTING_SCHEDULE'
        when 'That time overlaps an existing appointment.' then 'SLOT_CONFLICT'
        else null
      end;
      if v_rejection_code is null then raise exception 'unknown legacy rejection'; end if;
    end if;
    v_changed := false;
    v_receipt := jsonb_build_object('success',false,'changed',false,'code',
      case when p_operation = 'ai_book' then v_rejection_code
        when v_result ->> 'code' in ('UNAUTHORIZED','FORBIDDEN','INVALID_CUSTOMER','INVALID_SERVICE','INVALID_DURATION','INVALID_SCHEDULE','INVALID_HOURS','CLOSED','OUTSIDE_HOURS','SOURCE_DATE_CHANGED','SLOT_CONFLICT','INVALID_EXISTING_SCHEDULE','APPOINTMENT_NOT_FOUND','TERMINAL_APPOINTMENT')
        then v_result ->> 'code' else 'SCHEDULING_REJECTED' end);
  end if;
  v_receipt := v_receipt || jsonb_build_object('action_id',v_action.id,'action_type',v_type,
    'business_id',p_business_id,'receipt_scope','action_outcome','replayed',false,'completed_at',clock_timestamp());
  if v_changed and v_notify then
    insert into public.appointment_notifications(business_id,appointment_action_id,appointment_id,channel,notification_kind,payload)
      values(p_business_id,v_action.id,v_row.id,'sms',case when p_operation='reschedule' then 'reschedule' else 'confirmation' end,
        jsonb_build_object('action',v_type,'phone',v_row.customer_phone,'date',v_row.appointment_date,'time',v_row.appointment_time));
    if not found then raise exception 'missing notification'; end if;
  end if;
  update public.appointment_actions set success=(v_receipt ->> 'success')::boolean,changed=v_changed,
    appointment_id=coalesce(v_row.id,v_target),result=v_receipt,completed_at=(v_receipt ->> 'completed_at')::timestamptz
    where id=v_action.id and business_id=p_business_id;
  if not found then raise exception 'missing action'; end if;
  return v_receipt;
exception when others then
  raise log 'AnaAI scheduling action failed sqlstate=%',SQLSTATE;
  return jsonb_build_object('success',false,'code','INTERNAL_ERROR');
end;
$$;


ALTER FUNCTION public.schedule_appointment_idempotent_business(p_business_id uuid, p_idempotency_key uuid, p_request_fingerprint text, p_operation text, p_request jsonb) OWNER TO postgres;

--
-- Name: voice_book_appointment_business(uuid, uuid, text, text, text, text, uuid, date, time without time zone, text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.voice_book_appointment_business(p_business_id uuid, p_idempotency_key uuid, p_request_fingerprint text, p_customer_name text, p_customer_phone text, p_customer_email text, p_service_id uuid, p_appointment_date date, p_appointment_time time without time zone, p_notes text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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
$$;


ALTER FUNCTION public.voice_book_appointment_business(p_business_id uuid, p_idempotency_key uuid, p_request_fingerprint text, p_customer_name text, p_customer_phone text, p_customer_email text, p_service_id uuid, p_appointment_date date, p_appointment_time time without time zone, p_notes text) OWNER TO postgres;

--
-- Name: voice_check_appointment_availability(uuid, uuid, date, time without time zone); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.voice_check_appointment_availability(p_business_id uuid, p_service_id uuid, p_appointment_date date, p_appointment_time time without time zone) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  v_service_name text;
  v_duration_minutes integer;
  v_business_hours_text text;
  v_business_hours jsonb;
  v_day_key text;
  v_day_hours jsonb;
  v_open_time time without time zone;
  v_close_time time without time zone;
  v_requested_end timestamp without time zone;
  v_capacity text;
begin
  if p_business_id is null
     or p_service_id is null
     or p_appointment_date is null
     or not isfinite(p_appointment_date)
     or p_appointment_time is null then
    return jsonb_build_object(
      'available', false,
      'code', 'INVALID_REQUEST'
    );
  end if;

  if not exists (
    select 1
    from public.businesses b
    where b.id = p_business_id
  ) then
    return jsonb_build_object(
      'available', false,
      'code', 'BUSINESS_NOT_FOUND'
    );
  end if;

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
      'available', false,
      'code', 'INVALID_SERVICE'
    );
  end if;

  if v_duration_minutes is null
     or v_duration_minutes <= 0 then
    return jsonb_build_object(
      'available', false,
      'code', 'INVALID_DURATION'
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
      'available', false,
      'code', 'INVALID_HOURS'
    );
  end if;

  begin
    v_business_hours := v_business_hours_text::jsonb;
  exception
    when others then
      return jsonb_build_object(
        'available', false,
        'code', 'INVALID_HOURS'
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
      'available', false,
      'code', 'INVALID_HOURS'
    );
  end if;

  begin
    if coalesce(
      (v_day_hours ->> 'closed')::boolean,
      false
    ) then
      return jsonb_build_object(
        'available', false,
        'code', 'CLOSED',
        'service_id', p_service_id,
        'service', v_service_name,
        'date', p_appointment_date,
        'time', p_appointment_time,
        'duration_minutes', v_duration_minutes
      );
    end if;
  exception
    when others then
      return jsonb_build_object(
        'available', false,
        'code', 'INVALID_HOURS'
      );
  end;

  begin
    v_open_time := (v_day_hours ->> 'open')::time;
    v_close_time := (v_day_hours ->> 'close')::time;
  exception
    when others then
      return jsonb_build_object(
        'available', false,
        'code', 'INVALID_HOURS'
      );
  end;

  if v_open_time is null
     or v_close_time is null then
    return jsonb_build_object(
      'available', false,
      'code', 'INVALID_HOURS'
    );
  end if;

  v_requested_end :=
    p_appointment_date::timestamp
    + p_appointment_time
    + make_interval(mins => v_duration_minutes);

  if p_appointment_time < v_open_time
     or v_requested_end >
        (p_appointment_date::timestamp + v_close_time) then
    return jsonb_build_object(
      'available', false,
      'code', 'OUTSIDE_HOURS',
      'service_id', p_service_id,
      'service', v_service_name,
      'date', p_appointment_date,
      'time', p_appointment_time,
      'duration_minutes', v_duration_minutes
    );
  end if;

  /*
   * Peak simultaneous occupancy against businesses.appointment_capacity.
   *
   * Booked and Confirmed consume capacity; Cancelled and Completed do not.
   * Intervals are half-open [start, end), so an appointment ending exactly
   * when another begins does not conflict. No appointment is excluded: Voice
   * availability is always for a NEW appointment.
   *
   * At capacity 1 this is identical to the loop it replaces.
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
      'available', false,
      'code', 'SLOT_CONFLICT',
      'service_id', p_service_id,
      'service', v_service_name,
      'date', p_appointment_date,
      'time', p_appointment_time,
      'duration_minutes', v_duration_minutes
    );
  end if;

  if v_capacity = 'INVALID_EXISTING_SCHEDULE' then
    return jsonb_build_object(
      'available', false,
      'code', 'INVALID_EXISTING_SCHEDULE'
    );
  end if;

  /*
   * Anything other than an explicit AVAILABLE is unverified. Never report a
   * slot as free because the capacity calculation could not be completed.
   */
  if v_capacity is distinct from 'AVAILABLE' then
    return jsonb_build_object(
      'available', false,
      'code', 'INTERNAL_ERROR'
    );
  end if;

  return jsonb_build_object(
    'available', true,
    'code', 'AVAILABLE',
    'service_id', p_service_id,
    'service', v_service_name,
    'date', p_appointment_date,
    'time', p_appointment_time,
    'duration_minutes', v_duration_minutes
  );

exception
  when others then
    raise log
      'AnaAI voice availability check failed sqlstate=%',
      SQLSTATE;

    return jsonb_build_object(
      'available', false,
      'code', 'INTERNAL_ERROR'
    );
end;
$$;


ALTER FUNCTION public.voice_check_appointment_availability(p_business_id uuid, p_service_id uuid, p_appointment_date date, p_appointment_time time without time zone) OWNER TO postgres;

--
-- Name: voice_claim_appointment_notification(uuid, uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.voice_claim_appointment_notification(p_business_id uuid, p_action_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  v_row public.appointment_notifications%rowtype;
begin
  if p_business_id is null or p_action_id is null then
    return jsonb_build_object('claimed', false);
  end if;

  update public.appointment_notifications
  set
    status = 'uncertain',
    claim_token = gen_random_uuid(),
    updated_at = clock_timestamp()
  where business_id = p_business_id
    and appointment_action_id = p_action_id
    and status = 'pending'
  returning * into v_row;

  if not found then
    return jsonb_build_object('claimed', false);
  end if;

  return jsonb_build_object(
    'claimed', true,
    'id', v_row.id,
    'token', v_row.claim_token,
    'kind', v_row.notification_kind,
    'payload', v_row.payload
  );
end;
$$;


ALTER FUNCTION public.voice_claim_appointment_notification(p_business_id uuid, p_action_id uuid) OWNER TO postgres;

--
-- Name: voice_find_appointments_business(uuid, text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.voice_find_appointments_business(p_business_id uuid, p_caller_phone text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  v_customer uuid;
  v_now timestamp;
  v_items jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    return jsonb_build_object('success',false,'code','FORBIDDEN');
  end if;
  v_customer := anaai_private.voice_customer(p_business_id,p_caller_phone);
  select now() at time zone b.timezone
    into v_now from public.businesses b where b.id=p_business_id;
  if v_customer is null or v_now is null then
    return jsonb_build_object('success',false,'code','IDENTITY_UNVERIFIED');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',a.id,'businessId',a.business_id,'customerId',a.customer_id,
    'serviceId',a.service_id,'serviceName',a.service,
    'date',a.appointment_date,'time',to_char(a.appointment_time,'HH24:MI'),
    'status',a.status) order by a.appointment_date,a.appointment_time,a.id),'[]'::jsonb)
  into v_items from (
    select * from public.appointments a
    where a.business_id=p_business_id and a.customer_id=v_customer
      and a.status in ('Booked','Confirmed')
      and isfinite(a.appointment_date)
      and extract(second from a.appointment_time)=0
      and a.appointment_date + a.appointment_time > v_now
    order by a.appointment_date,a.appointment_time,a.id limit 21
  ) a;
  -- Never treat a truncated list as the entire candidate set.
  if jsonb_array_length(v_items)>20 then
    return jsonb_build_object('success',false,'code','TOO_MANY_MATCHES');
  end if;
  return jsonb_build_object('success',true,'business_id',p_business_id,
    'customer_id',v_customer,'appointments',v_items);
exception when others then
  return jsonb_build_object('success',false,'code','LOOKUP_UNAVAILABLE');
end;
$$;


ALTER FUNCTION public.voice_find_appointments_business(p_business_id uuid, p_caller_phone text) OWNER TO postgres;

--
-- Name: voice_finish_appointment_notification(uuid, uuid, uuid, text, text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.voice_finish_appointment_notification(p_business_id uuid, p_notification_id uuid, p_claim_token uuid, p_status text, p_provider_id text DEFAULT NULL::text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
begin
  if p_business_id is null
     or p_notification_id is null
     or p_claim_token is null
     or p_status is null
     or p_status not in ('accepted', 'failed', 'uncertain') then
    return false;
  end if;

  if p_status = 'accepted'
     and (
       p_provider_id is null
       or p_provider_id !~ '^SM[0-9a-fA-F]{32}$'
     ) then
    return false;
  end if;

  update public.appointment_notifications
  set
    status = p_status,
    provider_message_id =
      case
        when p_status = 'accepted' then p_provider_id
        else null
      end,
    last_error_code =
      case
        when p_status = 'accepted' then null
        when p_status = 'failed' then 'NOT_SENT'
        else 'PROVIDER_OUTCOME_UNKNOWN'
      end,
    accepted_at =
      case
        when p_status = 'accepted' then clock_timestamp()
        else null
      end,
    claim_token = null,
    updated_at = clock_timestamp()
  where id = p_notification_id
    and business_id = p_business_id
    and claim_token = p_claim_token
    and status = 'uncertain';

  return found;
end;
$_$;


ALTER FUNCTION public.voice_finish_appointment_notification(p_business_id uuid, p_notification_id uuid, p_claim_token uuid, p_status text, p_provider_id text) OWNER TO postgres;

--
-- Name: voice_manage_appointment_business(uuid, text, uuid, text, uuid, text, jsonb, date, time without time zone, boolean); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.voice_manage_appointment_business(p_business_id uuid, p_caller_phone text, p_appointment_id uuid, p_action_type text, p_idempotency_key uuid, p_request_fingerprint text, p_expected jsonb, p_date date DEFAULT NULL::date, p_time time without time zone DEFAULT NULL::time without time zone, p_check_only boolean DEFAULT false) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
declare
  v_customer uuid;
  v_action public.appointment_actions%rowtype;
  v_old public.appointments%rowtype;
  v_row public.appointments%rowtype;
  v_source date;
  v_day date;
  v_now timestamp;
  v_request jsonb;
  v_result jsonb;
  v_receipt jsonb;
  v_success boolean;
  v_changed boolean;
  v_code text;
begin
  if auth.role() is distinct from 'service_role' then
    return jsonb_build_object('success',false,'code','FORBIDDEN');
  end if;
  if current_setting('transaction_isolation') <> 'read committed' then
    return jsonb_build_object('success',false,'code','UNSUPPORTED_ISOLATION');
  end if;
  if p_business_id is null or p_appointment_id is null
    or p_action_type is null or p_action_type not in ('cancel','reschedule')
    or p_check_only is null or (p_check_only and p_action_type <> 'reschedule')
    or p_idempotency_key is null or p_request_fingerprint is null
    or p_request_fingerprint !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(p_expected) is distinct from 'object'
    or (p_action_type='reschedule' and (p_date is null or not isfinite(p_date) or p_time is null))
    or (p_action_type='cancel' and (p_date is not null or p_time is not null)) then
    return jsonb_build_object('success',false,'code','INVALID_REQUEST');
  end if;
  v_customer := anaai_private.voice_customer(p_business_id,p_caller_phone);
  if v_customer is null then
    return jsonb_build_object('success',false,'code','IDENTITY_UNVERIFIED');
  end if;
  -- Structured binding independently protects against a reused fingerprint.
  -- No phone or transcript is retained in the request payload.
  v_request := jsonb_build_object('origin','voice_management','customer_id',v_customer,
    'appointment_id',p_appointment_id,'action',p_action_type,
    'expected',p_expected,'date',p_date,'time',p_time);
  if not p_check_only then
    insert into public.appointment_actions(business_id,actor_user_id,idempotency_key,
      action_type,request_fingerprint,request_payload,appointment_id)
    values(p_business_id,null,p_idempotency_key,p_action_type,p_request_fingerprint,v_request,p_appointment_id)
    on conflict(business_id,idempotency_key) do nothing returning * into v_action;
    if not found then
      select * into v_action from public.appointment_actions
      where business_id=p_business_id and idempotency_key=p_idempotency_key for update;
      if not found then raise exception 'missing action'; end if;
      if v_action.action_type is distinct from p_action_type
        or v_action.appointment_id is distinct from p_appointment_id
        or v_action.request_fingerprint is distinct from p_request_fingerprint
        or v_action.request_payload is distinct from v_request then
        return jsonb_build_object('success',false,'code','IDEMPOTENCY_CONFLICT');
      end if;
      if v_action.completed_at is null then
        return jsonb_build_object('success',false,'code','ACTION_INCOMPLETE');
      end if;
      return v_action.result || jsonb_build_object('replayed',true);
    end if;
  end if;
  select appointment_date into v_source from public.appointments
    where id=p_appointment_id and business_id=p_business_id and customer_id=v_customer;
  if not found or v_source is null or not isfinite(v_source) then
    raise exception 'target unavailable';
  end if;
  for v_day in select distinct d from (values(v_source),(coalesce(p_date,v_source))) dates(d) order by d loop
    perform pg_advisory_xact_lock(hashtext(p_business_id::text || ':' || v_day::text));
  end loop;
  select * into v_old from public.appointments
    where id=p_appointment_id and business_id=p_business_id and customer_id=v_customer for update;
  if not found then raise exception 'target unavailable'; end if;
  -- Lock identity rows too: a concurrent phone reassignment cannot cross commit.
  perform 1 from public.customers where id=v_customer and business_id=p_business_id
    and phone=p_caller_phone for share;
  if not found or anaai_private.voice_customer(p_business_id,p_caller_phone) is distinct from v_customer then
    raise exception 'identity changed';
  end if;
  select now() at time zone b.timezone into v_now from public.businesses b where b.id=p_business_id;
  if v_now is null or v_old.appointment_date is distinct from v_source
    or v_old.appointment_date + v_old.appointment_time <= v_now
    or v_old.appointment_time is null or extract(second from v_old.appointment_time)<>0
    or v_old.status not in ('Booked','Confirmed') or v_old.status is null
    or p_expected is distinct from jsonb_build_object('customerId',v_old.customer_id,
      'serviceId',v_old.service_id,'serviceName',v_old.service,'date',v_old.appointment_date,
      'time',to_char(v_old.appointment_time,'HH24:MI'),'status',v_old.status) then
    v_result := jsonb_build_object('success',false,'code','TARGET_CHANGED');
  elsif p_action_type='reschedule' then
    if p_date + p_time <= v_now then
      v_result := jsonb_build_object('success',false,'code','INVALID_SCHEDULE');
    else
      v_result := anaai_private.reschedule_appointment_core(p_business_id,p_appointment_id,
        v_old.customer_id,v_old.service_id,p_date,p_time,v_old.notes,p_check_only);
    end if;
  else
    v_result := anaai_private.appointment_lifecycle_core(p_business_id,p_appointment_id,
      p_idempotency_key,p_request_fingerprint,'cancel',v_action.id);
  end if;
  if v_result->>'code' in ('INTERNAL_ERROR','UNSUPPORTED_ISOLATION')
    or jsonb_typeof(v_result->'success') is distinct from 'boolean' then
    raise exception 'execution unavailable';
  end if;
  if p_check_only then
    return jsonb_build_object('available',v_result->'success'='true'::jsonb,
      'code',v_result->>'code','business_id',p_business_id,'appointment_id',p_appointment_id,
      'customer_id',v_customer,'service_id',v_old.service_id,'date',p_date,'time',p_time);
  end if;
  v_success := (v_result->>'success')::boolean;
  v_code := v_result->>'code';
  if v_success then
    if p_action_type='cancel' then
      -- Preserve the lifecycle executor's explicit success/changed/code contract.
      -- ALREADY_IN_TARGET_STATE is currently unreachable for a fresh Voice cancel:
      -- the locked target precondition above requires Booked/Confirmed. Replays
      -- return the original outcome before that precondition, not a new no-op.
      if jsonb_typeof(v_result->'changed') is distinct from 'boolean' then
        raise exception 'invalid lifecycle outcome';
      end if;
      v_changed := (v_result->>'changed')::boolean;
      if v_code is distinct from
        (case when v_changed then 'APPLIED' else 'ALREADY_IN_TARGET_STATE' end) then
        raise exception 'invalid lifecycle outcome';
      end if;
    else
      -- The deployed reschedule core has no no-op branch or changed/code fields:
      -- successful commit means its UPDATE ran (including snapshot refresh).
      -- Check-only already returned above and never enters this mapping.
      v_changed := true;
      v_code := 'APPLIED';
    end if;
  else
    -- Controlled rejection: keep the authoritative code and complete the claim.
    -- No post-operation row has been read, so do not attach schedule fields.
    v_changed := false;
    if nullif(v_code,'') is null or v_code in ('APPLIED','ALREADY_IN_TARGET_STATE','AVAILABLE')
      or (v_result ? 'changed' and v_result->'changed' is distinct from 'false'::jsonb) then
      raise exception 'invalid rejection outcome';
    end if;
  end if;
  v_receipt := jsonb_build_object('success',v_success,'changed',v_changed,'code',v_code,
    'action_id',v_action.id,'action_type',p_action_type,'business_id',p_business_id,
    'appointment_id',p_appointment_id,'customer_id',v_customer,'service_id',v_old.service_id,
    'replayed',false,'receipt_scope','action_outcome');
  if v_success then
    select * into v_row from public.appointments where id=p_appointment_id and business_id=p_business_id;
    if not found or v_row.id is distinct from p_appointment_id
      or v_row.business_id is distinct from p_business_id
      or v_row.customer_id is distinct from v_old.customer_id
      or v_row.service_id is distinct from v_old.service_id
      or (p_action_type='cancel' and (v_row.status is distinct from 'Cancelled'
        or v_row.appointment_date is distinct from v_old.appointment_date
        or v_row.appointment_time is distinct from v_old.appointment_time))
      or (p_action_type='reschedule' and (v_row.status is null
        or v_row.status not in ('Booked','Confirmed')
        or v_row.status is distinct from v_old.status
        or v_row.appointment_date is distinct from p_date or v_row.appointment_time is distinct from p_time
        or v_row.duration_minutes is null or v_row.duration_minutes<=0)) then
      raise exception 'invalid receipt';
    end if;
    -- Only the verified authoritative reread may supply resulting state.
    v_receipt := v_receipt || jsonb_build_object(
      'date',v_row.appointment_date,'time',v_row.appointment_time,'status',v_row.status,
      'duration_minutes',v_row.duration_minutes);
  end if;
  if v_changed and p_action_type='reschedule' then
    insert into public.appointment_notifications(business_id,appointment_action_id,
      appointment_id,channel,notification_kind,payload)
    values(p_business_id,v_action.id,p_appointment_id,'sms','reschedule',
      jsonb_build_object('action','reschedule','phone',v_row.customer_phone,
        'date',v_row.appointment_date,'time',v_row.appointment_time));
  end if;
  update public.appointment_actions set success=v_success,changed=v_changed,
    result=v_receipt,completed_at=clock_timestamp()
    where id=v_action.id and business_id=p_business_id;
  if not found then raise exception 'missing receipt'; end if;
  return v_receipt;
exception when others then
  -- This protected block rolls back the claim, mutation and outbox together.
  raise log 'AnaAI voice management failed sqlstate=%',SQLSTATE;
  return jsonb_build_object('success',false,'code','INTERNAL_ERROR');
end;
$_$;


ALTER FUNCTION public.voice_manage_appointment_business(p_business_id uuid, p_caller_phone text, p_appointment_id uuid, p_action_type text, p_idempotency_key uuid, p_request_fingerprint text, p_expected jsonb, p_date date, p_time time without time zone, p_check_only boolean) OWNER TO postgres;

--
-- Name: ai_settings; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.ai_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    receptionist_name text DEFAULT 'Ana'::text NOT NULL,
    greeting text DEFAULT 'Thanks for calling! How can I help you today?'::text NOT NULL,
    tone text DEFAULT 'Friendly and professional'::text NOT NULL,
    custom_instructions text,
    transfer_instructions text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    business_id uuid NOT NULL
);


ALTER TABLE public.ai_settings OWNER TO postgres;

--
-- Name: appointment_actions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.appointment_actions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    actor_user_id uuid,
    idempotency_key uuid NOT NULL,
    action_type text NOT NULL,
    request_payload jsonb,
    request_fingerprint text NOT NULL,
    appointment_id uuid,
    success boolean DEFAULT false NOT NULL,
    changed boolean DEFAULT false NOT NULL,
    result jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT appointment_actions_action_type_check CHECK ((action_type = ANY (ARRAY['book'::text, 'reschedule'::text, 'confirm'::text, 'cancel'::text, 'complete'::text]))),
    CONSTRAINT appointment_actions_check CHECK (((NOT changed) OR success)),
    CONSTRAINT appointment_actions_completion_check CHECK ((((completed_at IS NULL) AND (NOT success) AND (NOT changed) AND (result IS NULL)) OR ((completed_at IS NOT NULL) AND (result IS NOT NULL) AND (jsonb_typeof(result) = 'object'::text) AND (result <> '{}'::jsonb)))),
    CONSTRAINT appointment_actions_request_fingerprint_check CHECK (((length(btrim(request_fingerprint)) >= 1) AND (length(btrim(request_fingerprint)) <= 512)))
);


ALTER TABLE public.appointment_actions OWNER TO postgres;

--
-- Name: appointment_notifications; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.appointment_notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    appointment_action_id uuid NOT NULL,
    appointment_id uuid NOT NULL,
    channel text NOT NULL,
    notification_kind text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    payload jsonb NOT NULL,
    claim_token uuid,
    provider_message_id text,
    last_error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    accepted_at timestamp with time zone,
    CONSTRAINT appointment_notifications_channel_check CHECK ((channel = 'sms'::text)),
    CONSTRAINT appointment_notifications_notification_kind_check CHECK ((notification_kind = ANY (ARRAY['confirmation'::text, 'cancellation'::text, 'reschedule'::text]))),
    CONSTRAINT appointment_notifications_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'failed'::text, 'uncertain'::text])))
);


ALTER TABLE public.appointment_notifications OWNER TO postgres;

--
-- Name: appointments; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.appointments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    customer_name text NOT NULL,
    customer_phone text,
    customer_email text,
    service text,
    appointment_date date,
    appointment_time time without time zone,
    status text DEFAULT 'Booked'::text,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    customer_id uuid,
    service_id uuid,
    business_id uuid NOT NULL,
    duration_minutes integer,
    CONSTRAINT appointments_duration_minutes_check CHECK (((duration_minutes IS NULL) OR ((duration_minutes > 0) AND (duration_minutes <= 1440))))
);


ALTER TABLE public.appointments OWNER TO postgres;

--
-- Name: COLUMN appointments.duration_minutes; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.appointments.duration_minutes IS 'Durable snapshot of the scheduling duration authoritative when this appointment was booked or rescheduled. Authoritative for this appointment''s interval; never re-derive it from the live services catalogue. NULL only for legacy rows whose duration could not be honestly recovered.';


--
-- Name: business_knowledge; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.business_knowledge (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    category text DEFAULT 'General'::text NOT NULL,
    question text NOT NULL,
    answer text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    business_id uuid NOT NULL
);


ALTER TABLE public.business_knowledge OWNER TO postgres;

--
-- Name: business_members; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.business_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text DEFAULT 'owner'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT business_members_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'manager'::text, 'staff'::text])))
);


ALTER TABLE public.business_members OWNER TO postgres;

--
-- Name: business_phone_numbers; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.business_phone_numbers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    phone_number text NOT NULL,
    provider text DEFAULT 'twilio'::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.business_phone_numbers OWNER TO postgres;

--
-- Name: business_profiles; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.business_profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    business_name text,
    owner_name text,
    phone text,
    email text,
    address text,
    business_hours text,
    created_at timestamp with time zone DEFAULT now(),
    timezone text DEFAULT 'America/Los_Angeles'::text NOT NULL,
    business_id uuid NOT NULL
);


ALTER TABLE public.business_profiles OWNER TO postgres;

--
-- Name: businesses; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.businesses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    timezone text DEFAULT 'America/Los_Angeles'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    appointment_capacity integer DEFAULT 1 NOT NULL,
    CONSTRAINT businesses_appointment_capacity_check CHECK (((appointment_capacity >= 1) AND (appointment_capacity <= 100)))
);


ALTER TABLE public.businesses OWNER TO postgres;

--
-- Name: customers; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.customers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    full_name text NOT NULL,
    phone text,
    email text,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    business_id uuid NOT NULL,
    is_active boolean DEFAULT true NOT NULL
);


ALTER TABLE public.customers OWNER TO postgres;

--
-- Name: employee_sessions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.employee_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    device_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    token_hash text NOT NULL,
    token_salt text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT employee_sessions_expiry_after_creation CHECK ((expires_at > created_at)),
    CONSTRAINT employee_sessions_token_hash_not_blank CHECK ((length(btrim(token_hash)) > 0)),
    CONSTRAINT employee_sessions_token_salt_not_blank CHECK ((length(btrim(token_salt)) > 0))
);


ALTER TABLE public.employee_sessions OWNER TO postgres;

--
-- Name: employee_time_events; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.employee_time_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    seq bigint NOT NULL,
    business_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    device_id uuid,
    event_type text NOT NULL,
    break_type text,
    occurred_at timestamp with time zone NOT NULL,
    request_id uuid NOT NULL,
    source text DEFAULT 'device_pin'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT employee_time_events_break_type_check CHECK ((((event_type = ANY (ARRAY['BREAK_START'::text, 'BREAK_END'::text])) AND COALESCE((break_type = ANY (ARRAY['PAID'::text, 'MEAL'::text])), false)) OR ((event_type = ANY (ARRAY['CLOCK_IN'::text, 'CLOCK_OUT'::text])) AND (break_type IS NULL)))),
    CONSTRAINT employee_time_events_event_type_check CHECK ((event_type = ANY (ARRAY['CLOCK_IN'::text, 'BREAK_START'::text, 'BREAK_END'::text, 'CLOCK_OUT'::text]))),
    CONSTRAINT employee_time_events_source_check CHECK (((source = 'device_pin'::text) AND (device_id IS NOT NULL)))
);


ALTER TABLE public.employee_time_events OWNER TO postgres;

--
-- Name: employee_time_events_seq_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

ALTER TABLE public.employee_time_events ALTER COLUMN seq ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.employee_time_events_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: employee_time_issues; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.employee_time_issues (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    device_id uuid NOT NULL,
    work_date date,
    time_event_id uuid,
    note text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    request_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    resolved_by_user_id uuid,
    resolution_note text,
    CONSTRAINT employee_time_issues_note_check CHECK (((length(btrim(note)) >= 1) AND (length(btrim(note)) <= 1000))),
    CONSTRAINT employee_time_issues_status_check CHECK ((((status = 'open'::text) AND (resolved_at IS NULL) AND (resolved_by_user_id IS NULL) AND (resolution_note IS NULL)) OR ((status = 'resolved'::text) AND (resolved_at IS NOT NULL))))
);


ALTER TABLE public.employee_time_issues OWNER TO postgres;

--
-- Name: services; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.services (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    name text NOT NULL,
    duration_minutes integer,
    price numeric(10,2),
    description text,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    business_id uuid NOT NULL
);


ALTER TABLE public.services OWNER TO postgres;

--
-- Name: voice_handoff_settings; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.voice_handoff_settings (
    business_id uuid NOT NULL,
    human_transfer_phone text,
    is_enabled boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT voice_handoff_enabled_requires_phone CHECK (((NOT is_enabled) OR (human_transfer_phone IS NOT NULL))),
    CONSTRAINT voice_handoff_phone_format CHECK (((human_transfer_phone IS NULL) OR (human_transfer_phone ~ '^\+[1-9][0-9]{7,14}$'::text)))
);


ALTER TABLE public.voice_handoff_settings OWNER TO postgres;

--
-- Name: zude_devices; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.zude_devices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    name text NOT NULL,
    credential_hash text NOT NULL,
    credential_salt text NOT NULL,
    registered_by_user_id uuid,
    registered_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone,
    failed_pin_attempts integer DEFAULT 0 NOT NULL,
    last_failed_pin_at timestamp with time zone,
    pin_locked_until timestamp with time zone,
    revoked_at timestamp with time zone,
    revoked_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT zude_devices_credential_hash_not_blank CHECK ((length(btrim(credential_hash)) > 0)),
    CONSTRAINT zude_devices_credential_salt_not_blank CHECK ((length(btrim(credential_salt)) > 0)),
    CONSTRAINT zude_devices_failed_pin_attempts_nonnegative CHECK ((failed_pin_attempts >= 0)),
    CONSTRAINT zude_devices_name_not_blank CHECK ((length(btrim(name)) > 0)),
    CONSTRAINT zude_devices_revocation_consistency CHECK ((((revoked_at IS NULL) AND (revoked_by_user_id IS NULL)) OR (revoked_at IS NOT NULL)))
);


ALTER TABLE public.zude_devices OWNER TO postgres;

--
-- Name: ai_settings ai_settings_business_id_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ai_settings
    ADD CONSTRAINT ai_settings_business_id_unique UNIQUE (business_id);


--
-- Name: ai_settings ai_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ai_settings
    ADD CONSTRAINT ai_settings_pkey PRIMARY KEY (id);


--
-- Name: appointment_actions appointment_actions_business_id_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.appointment_actions
    ADD CONSTRAINT appointment_actions_business_id_idempotency_key_key UNIQUE (business_id, idempotency_key);


--
-- Name: appointment_actions appointment_actions_id_business_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.appointment_actions
    ADD CONSTRAINT appointment_actions_id_business_id_key UNIQUE (id, business_id);


--
-- Name: appointment_actions appointment_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.appointment_actions
    ADD CONSTRAINT appointment_actions_pkey PRIMARY KEY (id);


--
-- Name: appointment_notifications appointment_notifications_appointment_action_id_channel_not_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.appointment_notifications
    ADD CONSTRAINT appointment_notifications_appointment_action_id_channel_not_key UNIQUE (appointment_action_id, channel, notification_kind);


--
-- Name: appointment_notifications appointment_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.appointment_notifications
    ADD CONSTRAINT appointment_notifications_pkey PRIMARY KEY (id);


--
-- Name: appointments appointments_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.appointments
    ADD CONSTRAINT appointments_pkey PRIMARY KEY (id);


--
-- Name: business_knowledge business_knowledge_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.business_knowledge
    ADD CONSTRAINT business_knowledge_pkey PRIMARY KEY (id);


--
-- Name: business_members business_members_business_user_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.business_members
    ADD CONSTRAINT business_members_business_user_unique UNIQUE (business_id, user_id);


--
-- Name: business_members business_members_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.business_members
    ADD CONSTRAINT business_members_pkey PRIMARY KEY (id);


--
-- Name: business_phone_numbers business_phone_numbers_phone_number_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.business_phone_numbers
    ADD CONSTRAINT business_phone_numbers_phone_number_unique UNIQUE (phone_number);


--
-- Name: business_phone_numbers business_phone_numbers_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.business_phone_numbers
    ADD CONSTRAINT business_phone_numbers_pkey PRIMARY KEY (id);


--
-- Name: business_profiles business_profiles_business_id_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.business_profiles
    ADD CONSTRAINT business_profiles_business_id_unique UNIQUE (business_id);


--
-- Name: business_profiles business_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.business_profiles
    ADD CONSTRAINT business_profiles_pkey PRIMARY KEY (id);


--
-- Name: businesses businesses_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.businesses
    ADD CONSTRAINT businesses_pkey PRIMARY KEY (id);


--
-- Name: customers customers_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);


--
-- Name: employee_sessions employee_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.employee_sessions
    ADD CONSTRAINT employee_sessions_pkey PRIMARY KEY (id);


--
-- Name: employee_time_events employee_time_events_business_employee_id_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.employee_time_events
    ADD CONSTRAINT employee_time_events_business_employee_id_unique UNIQUE (business_id, employee_id, id);


--
-- Name: employee_time_events employee_time_events_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.employee_time_events
    ADD CONSTRAINT employee_time_events_pkey PRIMARY KEY (id);


--
-- Name: employee_time_events employee_time_events_request_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.employee_time_events
    ADD CONSTRAINT employee_time_events_request_unique UNIQUE (business_id, employee_id, request_id, event_type);


--
-- Name: employee_time_issues employee_time_issues_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.employee_time_issues
    ADD CONSTRAINT employee_time_issues_pkey PRIMARY KEY (id);


--
-- Name: employee_time_issues employee_time_issues_request_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.employee_time_issues
    ADD CONSTRAINT employee_time_issues_request_unique UNIQUE (business_id, employee_id, request_id);


--
-- Name: employees employees_business_id_id_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_business_id_id_unique UNIQUE (business_id, id);


--
-- Name: employees employees_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_pkey PRIMARY KEY (id);


--
-- Name: services services_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.services
    ADD CONSTRAINT services_pkey PRIMARY KEY (id);


--
-- Name: voice_handoff_settings voice_handoff_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.voice_handoff_settings
    ADD CONSTRAINT voice_handoff_settings_pkey PRIMARY KEY (business_id);


--
-- Name: zude_devices zude_devices_business_id_id_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.zude_devices
    ADD CONSTRAINT zude_devices_business_id_id_unique UNIQUE (business_id, id);


--
-- Name: zude_devices zude_devices_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.zude_devices
    ADD CONSTRAINT zude_devices_pkey PRIMARY KEY (id);


--
-- Name: ai_settings_business_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX ai_settings_business_id_idx ON public.ai_settings USING btree (business_id);


--
-- Name: appointment_notifications_business_status_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX appointment_notifications_business_status_idx ON public.appointment_notifications USING btree (business_id, status);


--
-- Name: appointments_business_date_blocking_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX appointments_business_date_blocking_idx ON public.appointments USING btree (business_id, appointment_date) WHERE (status = ANY (ARRAY['Booked'::text, 'Confirmed'::text]));


--
-- Name: appointments_business_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX appointments_business_id_idx ON public.appointments USING btree (business_id);


--
-- Name: business_knowledge_business_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX business_knowledge_business_id_idx ON public.business_knowledge USING btree (business_id);


--
-- Name: business_members_business_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX business_members_business_id_idx ON public.business_members USING btree (business_id);


--
-- Name: business_members_user_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX business_members_user_id_idx ON public.business_members USING btree (user_id);


--
-- Name: business_phone_numbers_business_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX business_phone_numbers_business_id_idx ON public.business_phone_numbers USING btree (business_id);


--
-- Name: business_phone_numbers_provider_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX business_phone_numbers_provider_idx ON public.business_phone_numbers USING btree (provider);


--
-- Name: business_profiles_business_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX business_profiles_business_id_idx ON public.business_profiles USING btree (business_id);


--
-- Name: customers_business_active_created_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX customers_business_active_created_idx ON public.customers USING btree (business_id, is_active, created_at DESC);


--
-- Name: customers_business_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX customers_business_id_idx ON public.customers USING btree (business_id);


--
-- Name: employee_sessions_active_expiry_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX employee_sessions_active_expiry_idx ON public.employee_sessions USING btree (expires_at) WHERE (revoked_at IS NULL);


--
-- Name: employee_sessions_business_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX employee_sessions_business_id_idx ON public.employee_sessions USING btree (business_id);


--
-- Name: employee_sessions_device_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX employee_sessions_device_id_idx ON public.employee_sessions USING btree (device_id);


--
-- Name: employee_sessions_employee_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX employee_sessions_employee_id_idx ON public.employee_sessions USING btree (employee_id);


--
-- Name: employee_time_events_business_time_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX employee_time_events_business_time_idx ON public.employee_time_events USING btree (business_id, occurred_at);


--
-- Name: employee_time_events_device_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX employee_time_events_device_idx ON public.employee_time_events USING btree (business_id, device_id);


--
-- Name: employee_time_events_employee_seq_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX employee_time_events_employee_seq_idx ON public.employee_time_events USING btree (business_id, employee_id, seq DESC);


--
-- Name: employee_time_events_employee_time_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX employee_time_events_employee_time_idx ON public.employee_time_events USING btree (business_id, employee_id, occurred_at);


--
-- Name: employee_time_issues_device_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX employee_time_issues_device_idx ON public.employee_time_issues USING btree (business_id, device_id);


--
-- Name: employee_time_issues_employee_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX employee_time_issues_employee_idx ON public.employee_time_issues USING btree (business_id, employee_id, created_at);


--
-- Name: employee_time_issues_open_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX employee_time_issues_open_idx ON public.employee_time_issues USING btree (business_id, created_at) WHERE (status = 'open'::text);


--
-- Name: employees_business_active_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX employees_business_active_idx ON public.employees USING btree (business_id, is_active);


--
-- Name: employees_business_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX employees_business_id_idx ON public.employees USING btree (business_id);


--
-- Name: employees_created_by_user_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX employees_created_by_user_id_idx ON public.employees USING btree (created_by_user_id);


--
-- Name: services_business_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX services_business_id_idx ON public.services USING btree (business_id);


--
-- Name: zude_devices_business_active_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX zude_devices_business_active_idx ON public.zude_devices USING btree (business_id, revoked_at);


--
-- Name: zude_devices_business_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX zude_devices_business_id_idx ON public.zude_devices USING btree (business_id);


--
-- Name: zude_devices_pin_lock_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX zude_devices_pin_lock_idx ON public.zude_devices USING btree (pin_locked_until) WHERE (revoked_at IS NULL);


--
-- Name: employee_time_events employee_time_events_no_delete; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER employee_time_events_no_delete BEFORE DELETE ON public.employee_time_events FOR EACH ROW EXECUTE FUNCTION public.m05_time_events_delete_guard();


--
-- Name: employee_time_events employee_time_events_no_truncate; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER employee_time_events_no_truncate BEFORE TRUNCATE ON public.employee_time_events FOR EACH STATEMENT EXECUTE FUNCTION public.m05_time_events_immutable();


--
-- Name: employee_time_events employee_time_events_no_update; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER employee_time_events_no_update BEFORE UPDATE ON public.employee_time_events FOR EACH ROW EXECUTE FUNCTION public.m05_time_events_immutable();


--
-- Name: ai_settings ai_settings_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ai_settings
    ADD CONSTRAINT ai_settings_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: ai_settings ai_settings_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ai_settings
    ADD CONSTRAINT ai_settings_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: appointment_actions appointment_actions_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.appointment_actions
    ADD CONSTRAINT appointment_actions_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: appointment_actions appointment_actions_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.appointment_actions
    ADD CONSTRAINT appointment_actions_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: appointment_notifications appointment_notifications_appointment_action_id_business_i_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.appointment_notifications
    ADD CONSTRAINT appointment_notifications_appointment_action_id_business_i_fkey FOREIGN KEY (appointment_action_id, business_id) REFERENCES public.appointment_actions(id, business_id);


--
-- Name: appointment_notifications appointment_notifications_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.appointment_notifications
    ADD CONSTRAINT appointment_notifications_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: appointments appointments_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.appointments
    ADD CONSTRAINT appointments_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: appointments appointments_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.appointments
    ADD CONSTRAINT appointments_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;


--
-- Name: appointments appointments_service_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.appointments
    ADD CONSTRAINT appointments_service_id_fkey FOREIGN KEY (service_id) REFERENCES public.services(id) ON DELETE SET NULL;


--
-- Name: appointments appointments_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.appointments
    ADD CONSTRAINT appointments_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: business_knowledge business_knowledge_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.business_knowledge
    ADD CONSTRAINT business_knowledge_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: business_knowledge business_knowledge_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.business_knowledge
    ADD CONSTRAINT business_knowledge_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: business_members business_members_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.business_members
    ADD CONSTRAINT business_members_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: business_members business_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.business_members
    ADD CONSTRAINT business_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: business_phone_numbers business_phone_numbers_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.business_phone_numbers
    ADD CONSTRAINT business_phone_numbers_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: business_profiles business_profiles_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.business_profiles
    ADD CONSTRAINT business_profiles_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: business_profiles business_profiles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.business_profiles
    ADD CONSTRAINT business_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: customers customers_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: customers customers_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: employee_sessions employee_sessions_business_device_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.employee_sessions
    ADD CONSTRAINT employee_sessions_business_device_fkey FOREIGN KEY (business_id, device_id) REFERENCES public.zude_devices(business_id, id) ON DELETE CASCADE;


--
-- Name: employee_sessions employee_sessions_business_employee_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.employee_sessions
    ADD CONSTRAINT employee_sessions_business_employee_fkey FOREIGN KEY (business_id, employee_id) REFERENCES public.employees(business_id, id) ON DELETE CASCADE;


--
-- Name: employee_sessions employee_sessions_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.employee_sessions
    ADD CONSTRAINT employee_sessions_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: employee_time_events employee_time_events_business_device_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.employee_time_events
    ADD CONSTRAINT employee_time_events_business_device_fkey FOREIGN KEY (business_id, device_id) REFERENCES public.zude_devices(business_id, id);


--
-- Name: employee_time_events employee_time_events_business_employee_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.employee_time_events
    ADD CONSTRAINT employee_time_events_business_employee_fkey FOREIGN KEY (business_id, employee_id) REFERENCES public.employees(business_id, id);


--
-- Name: employee_time_events employee_time_events_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.employee_time_events
    ADD CONSTRAINT employee_time_events_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: employee_time_issues employee_time_issues_business_device_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.employee_time_issues
    ADD CONSTRAINT employee_time_issues_business_device_fkey FOREIGN KEY (business_id, device_id) REFERENCES public.zude_devices(business_id, id);


--
-- Name: employee_time_issues employee_time_issues_business_employee_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.employee_time_issues
    ADD CONSTRAINT employee_time_issues_business_employee_fkey FOREIGN KEY (business_id, employee_id) REFERENCES public.employees(business_id, id);


--
-- Name: employee_time_issues employee_time_issues_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.employee_time_issues
    ADD CONSTRAINT employee_time_issues_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: employee_time_issues employee_time_issues_event_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.employee_time_issues
    ADD CONSTRAINT employee_time_issues_event_fkey FOREIGN KEY (business_id, employee_id, time_event_id) REFERENCES public.employee_time_events(business_id, employee_id, id);


--
-- Name: employee_time_issues employee_time_issues_resolved_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.employee_time_issues
    ADD CONSTRAINT employee_time_issues_resolved_by_user_id_fkey FOREIGN KEY (resolved_by_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: employees employees_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: employees employees_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: employees employees_updated_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_updated_by_user_id_fkey FOREIGN KEY (updated_by_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: services services_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.services
    ADD CONSTRAINT services_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: services services_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.services
    ADD CONSTRAINT services_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: voice_handoff_settings voice_handoff_settings_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.voice_handoff_settings
    ADD CONSTRAINT voice_handoff_settings_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: zude_devices zude_devices_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.zude_devices
    ADD CONSTRAINT zude_devices_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: zude_devices zude_devices_registered_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.zude_devices
    ADD CONSTRAINT zude_devices_registered_by_user_id_fkey FOREIGN KEY (registered_by_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: zude_devices zude_devices_revoked_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.zude_devices
    ADD CONSTRAINT zude_devices_revoked_by_user_id_fkey FOREIGN KEY (revoked_by_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: business_phone_numbers Business admins can add phone numbers; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Business admins can add phone numbers" ON public.business_phone_numbers FOR INSERT TO authenticated WITH CHECK (public.is_business_admin(business_id));


--
-- Name: ai_settings Business admins can delete AI settings; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Business admins can delete AI settings" ON public.ai_settings FOR DELETE TO authenticated USING (public.is_business_admin(business_id));


--
-- Name: business_knowledge Business admins can delete business knowledge; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Business admins can delete business knowledge" ON public.business_knowledge FOR DELETE TO authenticated USING (public.is_business_admin(business_id));


--
-- Name: business_profiles Business admins can delete business profiles; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Business admins can delete business profiles" ON public.business_profiles FOR DELETE TO authenticated USING (public.is_business_admin(business_id));


--
-- Name: business_phone_numbers Business admins can delete phone numbers; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Business admins can delete phone numbers" ON public.business_phone_numbers FOR DELETE TO authenticated USING (public.is_business_admin(business_id));


--
-- Name: services Business admins can delete services; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Business admins can delete services" ON public.services FOR DELETE TO authenticated USING (public.is_business_admin(business_id));


--
-- Name: ai_settings Business admins can insert AI settings; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Business admins can insert AI settings" ON public.ai_settings FOR INSERT TO authenticated WITH CHECK (public.is_business_admin(business_id));


--
-- Name: business_knowledge Business admins can insert business knowledge; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Business admins can insert business knowledge" ON public.business_knowledge FOR INSERT TO authenticated WITH CHECK (public.is_business_admin(business_id));


--
-- Name: business_profiles Business admins can insert business profiles; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Business admins can insert business profiles" ON public.business_profiles FOR INSERT TO authenticated WITH CHECK (public.is_business_admin(business_id));


--
-- Name: services Business admins can insert services; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Business admins can insert services" ON public.services FOR INSERT TO authenticated WITH CHECK (public.is_business_admin(business_id));


--
-- Name: ai_settings Business admins can update AI settings; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Business admins can update AI settings" ON public.ai_settings FOR UPDATE TO authenticated USING (public.is_business_admin(business_id)) WITH CHECK (public.is_business_admin(business_id));


--
-- Name: business_knowledge Business admins can update business knowledge; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Business admins can update business knowledge" ON public.business_knowledge FOR UPDATE TO authenticated USING (public.is_business_admin(business_id)) WITH CHECK (public.is_business_admin(business_id));


--
-- Name: business_profiles Business admins can update business profiles; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Business admins can update business profiles" ON public.business_profiles FOR UPDATE TO authenticated USING (public.is_business_admin(business_id)) WITH CHECK (public.is_business_admin(business_id));


--
-- Name: business_phone_numbers Business admins can update phone numbers; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Business admins can update phone numbers" ON public.business_phone_numbers FOR UPDATE TO authenticated USING (public.is_business_admin(business_id)) WITH CHECK (public.is_business_admin(business_id));


--
-- Name: services Business admins can update services; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Business admins can update services" ON public.services FOR UPDATE TO authenticated USING (public.is_business_admin(business_id)) WITH CHECK (public.is_business_admin(business_id));


--
-- Name: appointments Business members can delete appointments; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Business members can delete appointments" ON public.appointments FOR DELETE TO authenticated USING (public.is_business_member(business_id));


--
-- Name: customers Business members can delete customers; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Business members can delete customers" ON public.customers FOR DELETE TO authenticated USING (public.is_business_member(business_id));


--
-- Name: appointments Business members can insert appointments; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Business members can insert appointments" ON public.appointments FOR INSERT TO authenticated WITH CHECK (public.is_business_member(business_id));


--
-- Name: customers Business members can insert customers; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Business members can insert customers" ON public.customers FOR INSERT TO authenticated WITH CHECK (public.is_business_member(business_id));


--
-- Name: appointments Business members can update appointments; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Business members can update appointments" ON public.appointments FOR UPDATE TO authenticated USING (public.is_business_member(business_id)) WITH CHECK (public.is_business_member(business_id));


--
-- Name: customers Business members can update customers; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Business members can update customers" ON public.customers FOR UPDATE TO authenticated USING (public.is_business_member(business_id)) WITH CHECK (public.is_business_member(business_id));


--
-- Name: ai_settings Business members can view AI settings; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Business members can view AI settings" ON public.ai_settings FOR SELECT TO authenticated USING (public.is_business_member(business_id));


--
-- Name: appointments Business members can view appointments; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Business members can view appointments" ON public.appointments FOR SELECT TO authenticated USING (public.is_business_member(business_id));


--
-- Name: business_knowledge Business members can view business knowledge; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Business members can view business knowledge" ON public.business_knowledge FOR SELECT TO authenticated USING (public.is_business_member(business_id));


--
-- Name: business_profiles Business members can view business profiles; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Business members can view business profiles" ON public.business_profiles FOR SELECT TO authenticated USING (public.is_business_member(business_id));


--
-- Name: businesses Business members can view businesses; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Business members can view businesses" ON public.businesses FOR SELECT TO authenticated USING (public.is_business_member(id));


--
-- Name: customers Business members can view customers; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Business members can view customers" ON public.customers FOR SELECT TO authenticated USING (public.is_business_member(business_id));


--
-- Name: business_phone_numbers Business members can view phone numbers; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Business members can view phone numbers" ON public.business_phone_numbers FOR SELECT TO authenticated USING (public.is_business_member(business_id));


--
-- Name: services Business members can view services; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Business members can view services" ON public.services FOR SELECT TO authenticated USING (public.is_business_member(business_id));


--
-- Name: business_members Business owners can manage memberships; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Business owners can manage memberships" ON public.business_members TO authenticated USING (public.is_business_owner(business_id)) WITH CHECK (public.is_business_owner(business_id));


--
-- Name: businesses Business owners can update businesses; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Business owners can update businesses" ON public.businesses FOR UPDATE TO authenticated USING (public.is_business_owner(id)) WITH CHECK (public.is_business_owner(id));


--
-- Name: business_members Users can view memberships in their businesses; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Users can view memberships in their businesses" ON public.business_members FOR SELECT TO authenticated USING (public.is_business_member(business_id));


--
-- Name: ai_settings; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.ai_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: appointment_actions; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.appointment_actions ENABLE ROW LEVEL SECURITY;

--
-- Name: appointment_actions appointment_actions_member_read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY appointment_actions_member_read ON public.appointment_actions FOR SELECT TO authenticated USING (public.is_business_member(business_id));


--
-- Name: appointment_notifications; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.appointment_notifications ENABLE ROW LEVEL SECURITY;

--
-- Name: appointment_notifications appointment_notifications_member_read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY appointment_notifications_member_read ON public.appointment_notifications FOR SELECT TO authenticated USING (public.is_business_member(business_id));


--
-- Name: appointments; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.appointments ENABLE ROW LEVEL SECURITY;

--
-- Name: business_knowledge; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.business_knowledge ENABLE ROW LEVEL SECURITY;

--
-- Name: business_members; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.business_members ENABLE ROW LEVEL SECURITY;

--
-- Name: business_phone_numbers; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.business_phone_numbers ENABLE ROW LEVEL SECURITY;

--
-- Name: business_profiles; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.business_profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: businesses; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;

--
-- Name: customers; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;

--
-- Name: employee_sessions; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.employee_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: employee_time_events; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.employee_time_events ENABLE ROW LEVEL SECURITY;

--
-- Name: employee_time_issues; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.employee_time_issues ENABLE ROW LEVEL SECURITY;

--
-- Name: employees; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;

--
-- Name: services; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.services ENABLE ROW LEVEL SECURITY;

--
-- Name: voice_handoff_settings; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.voice_handoff_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: zude_devices; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.zude_devices ENABLE ROW LEVEL SECURITY;

--
-- Name: SCHEMA anaai_private; Type: ACL; Schema: -; Owner: postgres
--

GRANT USAGE ON SCHEMA anaai_private TO authenticated;
GRANT USAGE ON SCHEMA anaai_private TO service_role;


--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: pg_database_owner
--

GRANT USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;


--
-- Name: FUNCTION appointment_lifecycle_core(p_business_id uuid, p_appointment_id uuid, p_idempotency_key uuid, p_request_fingerprint text, p_action_type text, p_preclaimed_action uuid); Type: ACL; Schema: anaai_private; Owner: postgres
--

REVOKE ALL ON FUNCTION anaai_private.appointment_lifecycle_core(p_business_id uuid, p_appointment_id uuid, p_idempotency_key uuid, p_request_fingerprint text, p_action_type text, p_preclaimed_action uuid) FROM PUBLIC;


--
-- Name: FUNCTION check_appointment_capacity_business(p_business_id uuid, p_appointment_date date, p_appointment_time time without time zone, p_duration_minutes integer, p_exclude_appointment_id uuid); Type: ACL; Schema: anaai_private; Owner: postgres
--

REVOKE ALL ON FUNCTION anaai_private.check_appointment_capacity_business(p_business_id uuid, p_appointment_date date, p_appointment_time time without time zone, p_duration_minutes integer, p_exclude_appointment_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION anaai_private.check_appointment_capacity_business(p_business_id uuid, p_appointment_date date, p_appointment_time time without time zone, p_duration_minutes integer, p_exclude_appointment_id uuid) TO authenticated;
GRANT ALL ON FUNCTION anaai_private.check_appointment_capacity_business(p_business_id uuid, p_appointment_date date, p_appointment_time time without time zone, p_duration_minutes integer, p_exclude_appointment_id uuid) TO service_role;


--
-- Name: FUNCTION reschedule_appointment_core(p_business_id uuid, p_appointment_id uuid, p_customer_id uuid, p_service_id uuid, p_appointment_date date, p_appointment_time time without time zone, p_notes text, p_check_only boolean); Type: ACL; Schema: anaai_private; Owner: postgres
--

REVOKE ALL ON FUNCTION anaai_private.reschedule_appointment_core(p_business_id uuid, p_appointment_id uuid, p_customer_id uuid, p_service_id uuid, p_appointment_date date, p_appointment_time time without time zone, p_notes text, p_check_only boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION anaai_private.reschedule_appointment_core(p_business_id uuid, p_appointment_id uuid, p_customer_id uuid, p_service_id uuid, p_appointment_date date, p_appointment_time time without time zone, p_notes text, p_check_only boolean) TO authenticated;
GRANT ALL ON FUNCTION anaai_private.reschedule_appointment_core(p_business_id uuid, p_appointment_id uuid, p_customer_id uuid, p_service_id uuid, p_appointment_date date, p_appointment_time time without time zone, p_notes text, p_check_only boolean) TO service_role;


--
-- Name: FUNCTION voice_customer(p_business_id uuid, p_caller_phone text); Type: ACL; Schema: anaai_private; Owner: postgres
--

REVOKE ALL ON FUNCTION anaai_private.voice_customer(p_business_id uuid, p_caller_phone text) FROM PUBLIC;


--
-- Name: FUNCTION _appointment_lifecycle_action(p_business_id uuid, p_appointment_id uuid, p_idempotency_key uuid, p_request_fingerprint text, p_action_type text); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public._appointment_lifecycle_action(p_business_id uuid, p_appointment_id uuid, p_idempotency_key uuid, p_request_fingerprint text, p_action_type text) FROM PUBLIC;
GRANT ALL ON FUNCTION public._appointment_lifecycle_action(p_business_id uuid, p_appointment_id uuid, p_idempotency_key uuid, p_request_fingerprint text, p_action_type text) TO service_role;


--
-- Name: FUNCTION book_appointment_atomic(p_customer_name text, p_customer_phone text, p_customer_email text, p_service_id uuid, p_appointment_date date, p_appointment_time time without time zone, p_notes text); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.book_appointment_atomic(p_customer_name text, p_customer_phone text, p_customer_email text, p_service_id uuid, p_appointment_date date, p_appointment_time time without time zone, p_notes text) TO anon;
GRANT ALL ON FUNCTION public.book_appointment_atomic(p_customer_name text, p_customer_phone text, p_customer_email text, p_service_id uuid, p_appointment_date date, p_appointment_time time without time zone, p_notes text) TO authenticated;
GRANT ALL ON FUNCTION public.book_appointment_atomic(p_customer_name text, p_customer_phone text, p_customer_email text, p_service_id uuid, p_appointment_date date, p_appointment_time time without time zone, p_notes text) TO service_role;


--
-- Name: FUNCTION book_appointment_atomic_business(p_business_id uuid, p_customer_name text, p_customer_phone text, p_customer_email text, p_service_id uuid, p_appointment_date date, p_appointment_time time without time zone, p_notes text); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.book_appointment_atomic_business(p_business_id uuid, p_customer_name text, p_customer_phone text, p_customer_email text, p_service_id uuid, p_appointment_date date, p_appointment_time time without time zone, p_notes text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.book_appointment_atomic_business(p_business_id uuid, p_customer_name text, p_customer_phone text, p_customer_email text, p_service_id uuid, p_appointment_date date, p_appointment_time time without time zone, p_notes text) TO anon;
GRANT ALL ON FUNCTION public.book_appointment_atomic_business(p_business_id uuid, p_customer_name text, p_customer_phone text, p_customer_email text, p_service_id uuid, p_appointment_date date, p_appointment_time time without time zone, p_notes text) TO authenticated;
GRANT ALL ON FUNCTION public.book_appointment_atomic_business(p_business_id uuid, p_customer_name text, p_customer_phone text, p_customer_email text, p_service_id uuid, p_appointment_date date, p_appointment_time time without time zone, p_notes text) TO service_role;


--
-- Name: FUNCTION cancel_appointment_atomic_business(p_business_id uuid, p_appointment_id uuid, p_idempotency_key uuid, p_request_fingerprint text); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.cancel_appointment_atomic_business(p_business_id uuid, p_appointment_id uuid, p_idempotency_key uuid, p_request_fingerprint text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.cancel_appointment_atomic_business(p_business_id uuid, p_appointment_id uuid, p_idempotency_key uuid, p_request_fingerprint text) TO authenticated;
GRANT ALL ON FUNCTION public.cancel_appointment_atomic_business(p_business_id uuid, p_appointment_id uuid, p_idempotency_key uuid, p_request_fingerprint text) TO service_role;


--
-- Name: FUNCTION check_reschedule_appointment_business(p_business_id uuid, p_appointment_id uuid, p_customer_id uuid, p_service_id uuid, p_appointment_date date, p_appointment_time time without time zone); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.check_reschedule_appointment_business(p_business_id uuid, p_appointment_id uuid, p_customer_id uuid, p_service_id uuid, p_appointment_date date, p_appointment_time time without time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.check_reschedule_appointment_business(p_business_id uuid, p_appointment_id uuid, p_customer_id uuid, p_service_id uuid, p_appointment_date date, p_appointment_time time without time zone) TO authenticated;


--
-- Name: FUNCTION claim_appointment_notification(p_business_id uuid, p_action_id uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.claim_appointment_notification(p_business_id uuid, p_action_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.claim_appointment_notification(p_business_id uuid, p_action_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.claim_appointment_notification(p_business_id uuid, p_action_id uuid) TO service_role;


--
-- Name: FUNCTION complete_appointment_atomic_business(p_business_id uuid, p_appointment_id uuid, p_idempotency_key uuid, p_request_fingerprint text); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.complete_appointment_atomic_business(p_business_id uuid, p_appointment_id uuid, p_idempotency_key uuid, p_request_fingerprint text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.complete_appointment_atomic_business(p_business_id uuid, p_appointment_id uuid, p_idempotency_key uuid, p_request_fingerprint text) TO authenticated;
GRANT ALL ON FUNCTION public.complete_appointment_atomic_business(p_business_id uuid, p_appointment_id uuid, p_idempotency_key uuid, p_request_fingerprint text) TO service_role;


--
-- Name: FUNCTION confirm_appointment_atomic_business(p_business_id uuid, p_appointment_id uuid, p_idempotency_key uuid, p_request_fingerprint text); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.confirm_appointment_atomic_business(p_business_id uuid, p_appointment_id uuid, p_idempotency_key uuid, p_request_fingerprint text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.confirm_appointment_atomic_business(p_business_id uuid, p_appointment_id uuid, p_idempotency_key uuid, p_request_fingerprint text) TO authenticated;
GRANT ALL ON FUNCTION public.confirm_appointment_atomic_business(p_business_id uuid, p_appointment_id uuid, p_idempotency_key uuid, p_request_fingerprint text) TO service_role;


--
-- Name: FUNCTION create_appointment_atomic_business(p_business_id uuid, p_customer_id uuid, p_service_id uuid, p_appointment_date date, p_appointment_time time without time zone, p_notes text); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.create_appointment_atomic_business(p_business_id uuid, p_customer_id uuid, p_service_id uuid, p_appointment_date date, p_appointment_time time without time zone, p_notes text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.create_appointment_atomic_business(p_business_id uuid, p_customer_id uuid, p_service_id uuid, p_appointment_date date, p_appointment_time time without time zone, p_notes text) TO authenticated;
GRANT ALL ON FUNCTION public.create_appointment_atomic_business(p_business_id uuid, p_customer_id uuid, p_service_id uuid, p_appointment_date date, p_appointment_time time without time zone, p_notes text) TO service_role;


--
-- Name: FUNCTION create_business_for_current_user(p_setup jsonb); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.create_business_for_current_user(p_setup jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.create_business_for_current_user(p_setup jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.create_business_for_current_user(p_setup jsonb) TO service_role;


--
-- Name: FUNCTION finish_appointment_notification(p_business_id uuid, p_notification_id uuid, p_claim_token uuid, p_status text, p_provider_id text); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.finish_appointment_notification(p_business_id uuid, p_notification_id uuid, p_claim_token uuid, p_status text, p_provider_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.finish_appointment_notification(p_business_id uuid, p_notification_id uuid, p_claim_token uuid, p_status text, p_provider_id text) TO authenticated;
GRANT ALL ON FUNCTION public.finish_appointment_notification(p_business_id uuid, p_notification_id uuid, p_claim_token uuid, p_status text, p_provider_id text) TO service_role;


--
-- Name: FUNCTION is_business_admin(p_business_id uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.is_business_admin(p_business_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_business_admin(p_business_id uuid) TO anon;
GRANT ALL ON FUNCTION public.is_business_admin(p_business_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.is_business_admin(p_business_id uuid) TO service_role;


--
-- Name: FUNCTION is_business_member(p_business_id uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.is_business_member(p_business_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_business_member(p_business_id uuid) TO anon;
GRANT ALL ON FUNCTION public.is_business_member(p_business_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.is_business_member(p_business_id uuid) TO service_role;


--
-- Name: FUNCTION is_business_owner(p_business_id uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.is_business_owner(p_business_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_business_owner(p_business_id uuid) TO anon;
GRANT ALL ON FUNCTION public.is_business_owner(p_business_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.is_business_owner(p_business_id uuid) TO service_role;


--
-- Name: TABLE employees; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.employees TO service_role;


--
-- Name: FUNCTION m04_write_employee(p_business_id uuid, p_actor_id uuid, p_employee_id uuid, p_expected_updated_at timestamp with time zone, p_pin_snapshot jsonb, p_values jsonb); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.m04_write_employee(p_business_id uuid, p_actor_id uuid, p_employee_id uuid, p_expected_updated_at timestamp with time zone, p_pin_snapshot jsonb, p_values jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.m04_write_employee(p_business_id uuid, p_actor_id uuid, p_employee_id uuid, p_expected_updated_at timestamp with time zone, p_pin_snapshot jsonb, p_values jsonb) TO service_role;


--
-- Name: FUNCTION m05_assert_employee_identity(p_business_id uuid, p_employee_id uuid, p_device_id uuid, p_session_id uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.m05_assert_employee_identity(p_business_id uuid, p_employee_id uuid, p_device_id uuid, p_session_id uuid) FROM PUBLIC;


--
-- Name: FUNCTION m05_record_time_event(p_business_id uuid, p_employee_id uuid, p_device_id uuid, p_session_id uuid, p_action text, p_break_type text, p_request_id uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.m05_record_time_event(p_business_id uuid, p_employee_id uuid, p_device_id uuid, p_session_id uuid, p_action text, p_break_type text, p_request_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.m05_record_time_event(p_business_id uuid, p_employee_id uuid, p_device_id uuid, p_session_id uuid, p_action text, p_break_type text, p_request_id uuid) TO service_role;


--
-- Name: FUNCTION m05_report_time_issue(p_business_id uuid, p_employee_id uuid, p_device_id uuid, p_session_id uuid, p_request_id uuid, p_work_date date, p_time_event_id uuid, p_note text); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.m05_report_time_issue(p_business_id uuid, p_employee_id uuid, p_device_id uuid, p_session_id uuid, p_request_id uuid, p_work_date date, p_time_event_id uuid, p_note text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.m05_report_time_issue(p_business_id uuid, p_employee_id uuid, p_device_id uuid, p_session_id uuid, p_request_id uuid, p_work_date date, p_time_event_id uuid, p_note text) TO service_role;


--
-- Name: FUNCTION m05_time_events_delete_guard(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.m05_time_events_delete_guard() FROM PUBLIC;


--
-- Name: FUNCTION m05_time_events_immutable(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.m05_time_events_immutable() FROM PUBLIC;


--
-- Name: FUNCTION reschedule_appointment_atomic_business(p_business_id uuid, p_appointment_id uuid, p_customer_id uuid, p_service_id uuid, p_appointment_date date, p_appointment_time time without time zone, p_notes text); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.reschedule_appointment_atomic_business(p_business_id uuid, p_appointment_id uuid, p_customer_id uuid, p_service_id uuid, p_appointment_date date, p_appointment_time time without time zone, p_notes text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.reschedule_appointment_atomic_business(p_business_id uuid, p_appointment_id uuid, p_customer_id uuid, p_service_id uuid, p_appointment_date date, p_appointment_time time without time zone, p_notes text) TO authenticated;
GRANT ALL ON FUNCTION public.reschedule_appointment_atomic_business(p_business_id uuid, p_appointment_id uuid, p_customer_id uuid, p_service_id uuid, p_appointment_date date, p_appointment_time time without time zone, p_notes text) TO service_role;


--
-- Name: FUNCTION schedule_appointment_idempotent_business(p_business_id uuid, p_idempotency_key uuid, p_request_fingerprint text, p_operation text, p_request jsonb); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.schedule_appointment_idempotent_business(p_business_id uuid, p_idempotency_key uuid, p_request_fingerprint text, p_operation text, p_request jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.schedule_appointment_idempotent_business(p_business_id uuid, p_idempotency_key uuid, p_request_fingerprint text, p_operation text, p_request jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.schedule_appointment_idempotent_business(p_business_id uuid, p_idempotency_key uuid, p_request_fingerprint text, p_operation text, p_request jsonb) TO service_role;


--
-- Name: FUNCTION voice_book_appointment_business(p_business_id uuid, p_idempotency_key uuid, p_request_fingerprint text, p_customer_name text, p_customer_phone text, p_customer_email text, p_service_id uuid, p_appointment_date date, p_appointment_time time without time zone, p_notes text); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.voice_book_appointment_business(p_business_id uuid, p_idempotency_key uuid, p_request_fingerprint text, p_customer_name text, p_customer_phone text, p_customer_email text, p_service_id uuid, p_appointment_date date, p_appointment_time time without time zone, p_notes text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.voice_book_appointment_business(p_business_id uuid, p_idempotency_key uuid, p_request_fingerprint text, p_customer_name text, p_customer_phone text, p_customer_email text, p_service_id uuid, p_appointment_date date, p_appointment_time time without time zone, p_notes text) TO service_role;


--
-- Name: FUNCTION voice_check_appointment_availability(p_business_id uuid, p_service_id uuid, p_appointment_date date, p_appointment_time time without time zone); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.voice_check_appointment_availability(p_business_id uuid, p_service_id uuid, p_appointment_date date, p_appointment_time time without time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.voice_check_appointment_availability(p_business_id uuid, p_service_id uuid, p_appointment_date date, p_appointment_time time without time zone) TO service_role;


--
-- Name: FUNCTION voice_claim_appointment_notification(p_business_id uuid, p_action_id uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.voice_claim_appointment_notification(p_business_id uuid, p_action_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.voice_claim_appointment_notification(p_business_id uuid, p_action_id uuid) TO service_role;


--
-- Name: FUNCTION voice_find_appointments_business(p_business_id uuid, p_caller_phone text); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.voice_find_appointments_business(p_business_id uuid, p_caller_phone text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.voice_find_appointments_business(p_business_id uuid, p_caller_phone text) TO service_role;


--
-- Name: FUNCTION voice_finish_appointment_notification(p_business_id uuid, p_notification_id uuid, p_claim_token uuid, p_status text, p_provider_id text); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.voice_finish_appointment_notification(p_business_id uuid, p_notification_id uuid, p_claim_token uuid, p_status text, p_provider_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.voice_finish_appointment_notification(p_business_id uuid, p_notification_id uuid, p_claim_token uuid, p_status text, p_provider_id text) TO service_role;


--
-- Name: FUNCTION voice_manage_appointment_business(p_business_id uuid, p_caller_phone text, p_appointment_id uuid, p_action_type text, p_idempotency_key uuid, p_request_fingerprint text, p_expected jsonb, p_date date, p_time time without time zone, p_check_only boolean); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.voice_manage_appointment_business(p_business_id uuid, p_caller_phone text, p_appointment_id uuid, p_action_type text, p_idempotency_key uuid, p_request_fingerprint text, p_expected jsonb, p_date date, p_time time without time zone, p_check_only boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.voice_manage_appointment_business(p_business_id uuid, p_caller_phone text, p_appointment_id uuid, p_action_type text, p_idempotency_key uuid, p_request_fingerprint text, p_expected jsonb, p_date date, p_time time without time zone, p_check_only boolean) TO service_role;


--
-- Name: TABLE ai_settings; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.ai_settings TO anon;
GRANT ALL ON TABLE public.ai_settings TO authenticated;
GRANT ALL ON TABLE public.ai_settings TO service_role;


--
-- Name: TABLE appointment_actions; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.appointment_actions TO service_role;
GRANT SELECT ON TABLE public.appointment_actions TO authenticated;


--
-- Name: TABLE appointment_notifications; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.appointment_notifications TO service_role;


--
-- Name: COLUMN appointment_notifications.id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(id) ON TABLE public.appointment_notifications TO authenticated;


--
-- Name: COLUMN appointment_notifications.business_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(business_id) ON TABLE public.appointment_notifications TO authenticated;


--
-- Name: COLUMN appointment_notifications.appointment_action_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(appointment_action_id) ON TABLE public.appointment_notifications TO authenticated;


--
-- Name: COLUMN appointment_notifications.appointment_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(appointment_id) ON TABLE public.appointment_notifications TO authenticated;


--
-- Name: COLUMN appointment_notifications.channel; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(channel) ON TABLE public.appointment_notifications TO authenticated;


--
-- Name: COLUMN appointment_notifications.notification_kind; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(notification_kind) ON TABLE public.appointment_notifications TO authenticated;


--
-- Name: COLUMN appointment_notifications.status; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(status) ON TABLE public.appointment_notifications TO authenticated;


--
-- Name: COLUMN appointment_notifications.provider_message_id; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(provider_message_id) ON TABLE public.appointment_notifications TO authenticated;


--
-- Name: COLUMN appointment_notifications.last_error_code; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(last_error_code) ON TABLE public.appointment_notifications TO authenticated;


--
-- Name: COLUMN appointment_notifications.created_at; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(created_at) ON TABLE public.appointment_notifications TO authenticated;


--
-- Name: COLUMN appointment_notifications.updated_at; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(updated_at) ON TABLE public.appointment_notifications TO authenticated;


--
-- Name: COLUMN appointment_notifications.accepted_at; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT(accepted_at) ON TABLE public.appointment_notifications TO authenticated;


--
-- Name: TABLE appointments; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.appointments TO anon;
GRANT ALL ON TABLE public.appointments TO authenticated;
GRANT ALL ON TABLE public.appointments TO service_role;


--
-- Name: TABLE business_knowledge; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.business_knowledge TO anon;
GRANT ALL ON TABLE public.business_knowledge TO authenticated;
GRANT ALL ON TABLE public.business_knowledge TO service_role;


--
-- Name: TABLE business_members; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.business_members TO anon;
GRANT ALL ON TABLE public.business_members TO authenticated;
GRANT ALL ON TABLE public.business_members TO service_role;


--
-- Name: TABLE business_phone_numbers; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.business_phone_numbers TO anon;
GRANT ALL ON TABLE public.business_phone_numbers TO authenticated;
GRANT ALL ON TABLE public.business_phone_numbers TO service_role;


--
-- Name: TABLE business_profiles; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.business_profiles TO anon;
GRANT ALL ON TABLE public.business_profiles TO authenticated;
GRANT ALL ON TABLE public.business_profiles TO service_role;


--
-- Name: TABLE businesses; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.businesses TO anon;
GRANT ALL ON TABLE public.businesses TO authenticated;
GRANT ALL ON TABLE public.businesses TO service_role;


--
-- Name: TABLE customers; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.customers TO anon;
GRANT ALL ON TABLE public.customers TO authenticated;
GRANT ALL ON TABLE public.customers TO service_role;


--
-- Name: TABLE employee_sessions; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.employee_sessions TO service_role;


--
-- Name: TABLE employee_time_events; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.employee_time_events TO service_role;


--
-- Name: SEQUENCE employee_time_events_seq_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.employee_time_events_seq_seq TO anon;
GRANT ALL ON SEQUENCE public.employee_time_events_seq_seq TO authenticated;
GRANT ALL ON SEQUENCE public.employee_time_events_seq_seq TO service_role;


--
-- Name: TABLE employee_time_issues; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.employee_time_issues TO service_role;


--
-- Name: TABLE services; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.services TO anon;
GRANT ALL ON TABLE public.services TO authenticated;
GRANT ALL ON TABLE public.services TO service_role;


--
-- Name: TABLE voice_handoff_settings; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.voice_handoff_settings TO service_role;


--
-- Name: TABLE zude_devices; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.zude_devices TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: supabase_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: supabase_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: supabase_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- PostgreSQL database dump complete
--

\unrestrict 2oHa3YZPmuhDfI0rgLOGqoHSFgQ0z2VsvOnDUQ9r8EMAHORkymxWO1DYPgEq0sU

