-- AnaAI Voice availability: business-level simultaneous capacity.
--
-- REVIEW ONLY: do not deploy until the acceptance tests in
-- tests/appointment-capacity.README.md and tests/voice-capacity.README.md pass.
--
-- Requires 202609210001 (businesses.appointment_capacity) and 202609210002
-- (anaai_private.check_appointment_capacity_business).
--
-- Replaces the inline "any overlap = SLOT_CONFLICT" loop with the SAME shared
-- helper the authoritative manual scheduling RPCs use, so Voice and the
-- dashboard can no longer disagree about whether a slot is free.
--
-- Deliberately unchanged:
--   - the exact function signature
--   - SECURITY DEFINER and the service_role-only grant
--   - business existence, service, duration and business-hours validation
--   - business-local date/time arithmetic (no timezone conversion)
--   - the returned JSON shape and every result code
--   - advisory-only semantics; voice_book_appointment_business is still the
--     authoritative gate and re-checks capacity under the advisory lock
--
-- Behaviour changes, both required fail-closed corrections:
--   - an active appointment with a NULL appointment_time used to make the
--     overlap comparison NULL, which read as "no conflict" and could overbook.
--     It now returns INVALID_EXISTING_SCHEDULE.
--   - the legacy service-name duration fallback used `limit 1`, silently
--     picking one of several same-named services. An ambiguous name now fails
--     closed, matching the deployed manual scheduling rule.
--
-- The helper is called SCHEMA-QUALIFIED. search_path stays pinned to
-- pg_catalog, public, so anaai_private is never resolved by search order.

begin;

create or replace function public.voice_check_appointment_availability(
  p_business_id uuid,
  p_service_id uuid,
  p_appointment_date date,
  p_appointment_time time without time zone
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
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
$function$;

revoke all on function public.voice_check_appointment_availability(
  uuid,
  uuid,
  date,
  time without time zone
) from public, anon, authenticated;

grant execute on function public.voice_check_appointment_availability(
  uuid,
  uuid,
  date,
  time without time zone
) to service_role;

commit;
