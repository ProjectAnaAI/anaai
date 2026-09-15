-- REVIEW ONLY: do not deploy until authenticated integration/concurrency tests pass.
-- Uses the production AI RPC's exact advisory lock expression. All participants
-- must use READ COMMITTED and the same DateStyle (production ISO expected).
-- No trigger: direct writes and legacy status transitions remain outside this guard.
begin;

create index if not exists appointments_business_date_blocking_idx
  on public.appointments (business_id, appointment_date)
  where status in ('Booked', 'Confirmed');


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
  v_existing record;
  v_duration integer;
begin
  if v_user_id is null then
    return jsonb_build_object('success', false, 'code', 'UNAUTHORIZED');
  end if;
  if p_business_id is null or not coalesce(public.is_business_member(p_business_id), false) then
    return jsonb_build_object('success', false, 'code', 'FORBIDDEN');
  end if;
  if current_setting('transaction_isolation') <> 'read committed' then
    return jsonb_build_object('success', false, 'code', 'UNSUPPORTED_ISOLATION');
  end if;
  if p_appointment_date is null or not isfinite(p_appointment_date)
     or p_appointment_time is null then
    return jsonb_build_object('success', false, 'code', 'INVALID_SCHEDULE');
  end if;
  perform pg_advisory_xact_lock(
    hashtext(p_business_id::text || ':' || p_appointment_date::text)
  );

  select * into v_customer from public.customers
    where id = p_customer_id and business_id = p_business_id;
  if not found then
    return jsonb_build_object('success', false, 'code', 'INVALID_CUSTOMER');
  end if;
  select * into v_service from public.services
    where id = p_service_id and business_id = p_business_id and is_active = true;
  if not found then
    return jsonb_build_object('success', false, 'code', 'INVALID_SERVICE');
  end if;
  if v_service.duration_minutes is null or v_service.duration_minutes <= 0 then
    return jsonb_build_object('success', false, 'code', 'INVALID_DURATION');
  end if;

  begin
    -- Select the latest TEXT value before parsing. Historical rows must never
    -- be cast while the SELECT is finding/sorting candidates.
    select business_hours into v_hours_text from public.business_profiles
      where business_id = p_business_id order by created_at desc limit 1;
    if not found or v_hours_text is null then
      return jsonb_build_object('success', false, 'code', 'INVALID_HOURS');
    end if;
    -- Separate PL/pgSQL statement: only the selected value can be parsed.
    -- A malformed latest value is caught by this block's existing handler.
    v_hours := v_hours_text::jsonb;
    v_day := v_hours -> (array['sunday','monday','tuesday','wednesday',
                              'thursday','friday','saturday'])[extract(dow from p_appointment_date)::integer + 1];
    if v_day is null or jsonb_typeof(v_day -> 'closed') is distinct from 'boolean' then
      return jsonb_build_object('success', false, 'code', 'INVALID_HOURS');
    end if;
    if (v_day ->> 'closed')::boolean then
      return jsonb_build_object('success', false, 'code', 'CLOSED');
    end if;
    v_open := (v_day ->> 'open')::time;
    v_close := (v_day ->> 'close')::time;
    if v_open is null or v_close is null or v_close <= v_open then
      return jsonb_build_object('success', false, 'code', 'INVALID_HOURS');
    end if;
  exception when others then
    return jsonb_build_object('success', false, 'code', 'INVALID_HOURS');
  end;
  v_start := p_appointment_date + p_appointment_time;
  v_end := v_start + make_interval(mins => v_service.duration_minutes);
  if v_start < p_appointment_date + v_open or v_end > p_appointment_date + v_close then
    return jsonb_build_object('success', false, 'code', 'OUTSIDE_HOURS');
  end if;

  -- Fresh statement after the advisory lock; no row locks on other appointments.
  for v_existing in
    select a.* from public.appointments a
      where a.business_id = p_business_id and a.appointment_date = p_appointment_date
        and a.status in ('Booked', 'Confirmed')
  loop
    v_duration := null;
    select s.duration_minutes into v_duration from public.services s
      where s.id = v_existing.service_id and s.business_id = p_business_id;
    if not found then
      -- Name fallback is legacy compatibility. Fail closed if ambiguous.
      select case when count(*) = 1 then min(s.duration_minutes) end into v_duration
        from public.services s where s.business_id = p_business_id
          and lower(s.name) = lower(v_existing.service);
    end if;
    if v_duration is null or v_duration <= 0 or v_existing.appointment_time is null then
      return jsonb_build_object('success', false, 'code', 'INVALID_EXISTING_SCHEDULE');
    end if;
    if v_start < (p_appointment_date + v_existing.appointment_time) + make_interval(mins => v_duration)
       and v_end > p_appointment_date + v_existing.appointment_time then
      return jsonb_build_object('success', false, 'code', 'SLOT_CONFLICT');
    end if;
  end loop;
  insert into public.appointments (
    business_id, user_id, customer_id, service_id,
    customer_name, customer_phone, customer_email, service,
    appointment_date, appointment_time, notes, status
  ) values (
    p_business_id, v_user_id, v_customer.id, v_service.id,
    v_customer.full_name, v_customer.phone, v_customer.email, v_service.name,
    p_appointment_date, p_appointment_time, nullif(btrim(p_notes), ''), 'Booked'
  ) returning * into v_appointment;
  return jsonb_build_object('success', true, 'appointment', jsonb_build_object(
    'id', v_appointment.id, 'customer_id', v_appointment.customer_id,
    'service_id', v_appointment.service_id, 'customer_name', v_appointment.customer_name,
    'customer_phone', v_appointment.customer_phone, 'customer_email', v_appointment.customer_email,
    'service', v_appointment.service, 'appointment_date', v_appointment.appointment_date,
    'appointment_time', v_appointment.appointment_time, 'status', v_appointment.status,
    'notes', v_appointment.notes
  ));
exception when others then
  -- Entering this handler rolls back database changes within this block
  -- (its implicit subtransaction), not unrelated work in the caller transaction.
  raise log 'AnaAI atomic scheduling failed sqlstate=%', SQLSTATE;
  return jsonb_build_object('success', false, 'code', 'INTERNAL_ERROR');
end;
$function$;
revoke all on function public.create_appointment_atomic_business(uuid, uuid, uuid, date, time, text) from public, anon;
grant execute on function public.create_appointment_atomic_business(uuid, uuid, uuid, date, time, text) to authenticated;


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
  v_existing record;
  v_duration integer;
  v_source_date date;
  v_scheduling_date date;
begin
  if v_user_id is null then
    return jsonb_build_object('success', false, 'code', 'UNAUTHORIZED');
  end if;
  if p_business_id is null or not coalesce(public.is_business_member(p_business_id), false) then
    return jsonb_build_object('success', false, 'code', 'FORBIDDEN');
  end if;
  if current_setting('transaction_isolation') <> 'read committed' then
    return jsonb_build_object('success', false, 'code', 'UNSUPPORTED_ISOLATION');
  end if;
  if p_appointment_date is null or not isfinite(p_appointment_date)
     or p_appointment_time is null then
    return jsonb_build_object('success', false, 'code', 'INVALID_SCHEDULE');
  end if;
  -- Discovery only: this read is not authoritative until the locked reread.
  select appointment_date into v_source_date from public.appointments
    where id = p_appointment_id and business_id = p_business_id;
  if not found then
    return jsonb_build_object('success', false, 'code', 'APPOINTMENT_NOT_FOUND');
  end if;
  if v_source_date is null or not isfinite(v_source_date) then
    return jsonb_build_object('success', false, 'code', 'INVALID_EXISTING_SCHEDULE');
  end if;

  -- Lock both affected dates before any appointment row lock. DISTINCT makes
  -- same-date reschedules acquire one lock; DATE ordering is chronological.
  for v_scheduling_date in
    select distinct d.scheduling_date
    from (values (v_source_date), (p_appointment_date)) as d(scheduling_date)
    order by d.scheduling_date
  loop
    perform pg_advisory_xact_lock(
      hashtext(p_business_id::text || ':' || v_scheduling_date::text)
    );
  end loop;

  select * into v_appointment from public.appointments
    where id = p_appointment_id and business_id = p_business_id for update;
  if not found then
    return jsonb_build_object('success', false, 'code', 'APPOINTMENT_NOT_FOUND');
  end if;
  -- A competing move can commit while we wait. Never acquire additional date
  -- locks out of order or mutate under a stale/incomplete lock set; retry fresh.
  if v_appointment.appointment_date is distinct from v_source_date then
    return jsonb_build_object('success', false, 'code', 'SOURCE_DATE_CHANGED');
  end if;
  if v_appointment.status is null or v_appointment.status not in ('Booked', 'Confirmed') then
    return jsonb_build_object('success', false, 'code', 'TERMINAL_APPOINTMENT');
  end if;

  select * into v_customer from public.customers
    where id = p_customer_id and business_id = p_business_id;
  if not found then
    return jsonb_build_object('success', false, 'code', 'INVALID_CUSTOMER');
  end if;
  select * into v_service from public.services
    where id = p_service_id and business_id = p_business_id and is_active = true;
  if not found then
    return jsonb_build_object('success', false, 'code', 'INVALID_SERVICE');
  end if;
  if v_service.duration_minutes is null or v_service.duration_minutes <= 0 then
    return jsonb_build_object('success', false, 'code', 'INVALID_DURATION');
  end if;

  begin
    -- Select the latest TEXT value before parsing. Historical rows must never
    -- be cast while the SELECT is finding/sorting candidates.
    select business_hours into v_hours_text from public.business_profiles
      where business_id = p_business_id order by created_at desc limit 1;
    if not found or v_hours_text is null then
      return jsonb_build_object('success', false, 'code', 'INVALID_HOURS');
    end if;
    -- Separate PL/pgSQL statement: only the selected value can be parsed.
    -- A malformed latest value is caught by this block's existing handler.
    v_hours := v_hours_text::jsonb;
    v_day := v_hours -> (array['sunday','monday','tuesday','wednesday',
                              'thursday','friday','saturday'])[extract(dow from p_appointment_date)::integer + 1];
    if v_day is null or jsonb_typeof(v_day -> 'closed') is distinct from 'boolean' then
      return jsonb_build_object('success', false, 'code', 'INVALID_HOURS');
    end if;
    if (v_day ->> 'closed')::boolean then
      return jsonb_build_object('success', false, 'code', 'CLOSED');
    end if;
    v_open := (v_day ->> 'open')::time;
    v_close := (v_day ->> 'close')::time;
    if v_open is null or v_close is null or v_close <= v_open then
      return jsonb_build_object('success', false, 'code', 'INVALID_HOURS');
    end if;
  exception when others then
    return jsonb_build_object('success', false, 'code', 'INVALID_HOURS');
  end;
  v_start := p_appointment_date + p_appointment_time;
  v_end := v_start + make_interval(mins => v_service.duration_minutes);
  if v_start < p_appointment_date + v_open or v_end > p_appointment_date + v_close then
    return jsonb_build_object('success', false, 'code', 'OUTSIDE_HOURS');
  end if;

  -- Fresh statement after the advisory lock; no row locks on other appointments.
  for v_existing in
    select a.* from public.appointments a
      where a.business_id = p_business_id and a.appointment_date = p_appointment_date
        and a.status in ('Booked', 'Confirmed')
        and a.id <> p_appointment_id
  loop
    v_duration := null;
    select s.duration_minutes into v_duration from public.services s
      where s.id = v_existing.service_id and s.business_id = p_business_id;
    if not found then
      -- Name fallback is legacy compatibility. Fail closed if ambiguous.
      select case when count(*) = 1 then min(s.duration_minutes) end into v_duration
        from public.services s where s.business_id = p_business_id
          and lower(s.name) = lower(v_existing.service);
    end if;
    if v_duration is null or v_duration <= 0 or v_existing.appointment_time is null then
      return jsonb_build_object('success', false, 'code', 'INVALID_EXISTING_SCHEDULE');
    end if;
    if v_start < (p_appointment_date + v_existing.appointment_time) + make_interval(mins => v_duration)
       and v_end > p_appointment_date + v_existing.appointment_time then
      return jsonb_build_object('success', false, 'code', 'SLOT_CONFLICT');
    end if;
  end loop;
  update public.appointments set
    customer_id = v_customer.id, service_id = v_service.id,
    customer_name = v_customer.full_name, customer_phone = v_customer.phone,
    customer_email = v_customer.email, service = v_service.name,
    appointment_date = p_appointment_date, appointment_time = p_appointment_time,
    notes = nullif(btrim(p_notes), '')
    -- user_id and existing Booked/Confirmed status intentionally preserved.
    where id = p_appointment_id and business_id = p_business_id
    returning * into v_appointment;
  if not found then
    return jsonb_build_object('success', false, 'code', 'APPOINTMENT_NOT_FOUND');
  end if;
  return jsonb_build_object('success', true, 'appointment', jsonb_build_object(
    'id', v_appointment.id, 'customer_id', v_appointment.customer_id,
    'service_id', v_appointment.service_id, 'customer_name', v_appointment.customer_name,
    'customer_phone', v_appointment.customer_phone, 'customer_email', v_appointment.customer_email,
    'service', v_appointment.service, 'appointment_date', v_appointment.appointment_date,
    'appointment_time', v_appointment.appointment_time, 'status', v_appointment.status,
    'notes', v_appointment.notes
  ));
exception when others then
  -- Entering this handler rolls back database changes within this block
  -- (its implicit subtransaction), not unrelated work in the caller transaction.
  raise log 'AnaAI atomic scheduling failed sqlstate=%', SQLSTATE;
  return jsonb_build_object('success', false, 'code', 'INTERNAL_ERROR');
end;
$function$;
revoke all on function public.reschedule_appointment_atomic_business(uuid, uuid, uuid, uuid, date, time, text) from public, anon;
grant execute on function public.reschedule_appointment_atomic_business(uuid, uuid, uuid, uuid, date, time, text) to authenticated;


commit;
