-- AnaAI trusted phone-system availability boundary.
--
-- This migration adds a read-only availability check for the trusted voice
-- server. It intentionally does NOT modify the existing authoritative
-- voice_book_appointment_business booking RPC.
--
-- Security model:
-- - Voice ingress authenticates the Twilio request.
-- - The server resolves business_id from the called phone number.
-- - Only service_role may execute this function.
-- - Browser/anon/authenticated roles cannot execute it.
--
-- This function is advisory only. Availability can change after this check.
-- voice_book_appointment_business remains the final authoritative booking gate.

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
  v_requested_start timestamp without time zone;
  v_requested_end timestamp without time zone;
  v_existing record;
  v_existing_duration integer;
  v_existing_start timestamp without time zone;
  v_existing_end timestamp without time zone;
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

  v_requested_start :=
    p_appointment_date::timestamp + p_appointment_time;

  v_requested_end :=
    v_requested_start
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

  for v_existing in
    select
      a.appointment_time,
      a.service_id,
      a.service
    from public.appointments a
    where a.business_id = p_business_id
      and a.appointment_date = p_appointment_date
      and a.status in ('Booked', 'Confirmed')
  loop
    v_existing_duration := null;

    if v_existing.service_id is not null then
      select s.duration_minutes
      into v_existing_duration
      from public.services s
      where s.id = v_existing.service_id
        and s.business_id = p_business_id
      limit 1;
    end if;

    if v_existing_duration is null
       and v_existing.service is not null then
      select s.duration_minutes
      into v_existing_duration
      from public.services s
      where s.business_id = p_business_id
        and lower(s.name) = lower(v_existing.service)
      limit 1;
    end if;

    if v_existing_duration is null
       or v_existing_duration <= 0 then
      return jsonb_build_object(
        'available', false,
        'code', 'INVALID_EXISTING_SCHEDULE'
      );
    end if;

    v_existing_start :=
      p_appointment_date::timestamp
      + v_existing.appointment_time;

    v_existing_end :=
      v_existing_start
      + make_interval(mins => v_existing_duration);

    if v_requested_start < v_existing_end
       and v_requested_end > v_existing_start then
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
  end loop;

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