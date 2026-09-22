-- Voice management, apply manually AFTER 007. No data backfill.
-- Private cores retain the deployed scheduling/lifecycle algorithm. Public manual
-- entry points retain their signatures, security modes, ACLs and member guards.
-- Never expose anaai_private through PostgREST.
begin;

create or replace function anaai_private.reschedule_appointment_core(
  p_business_id uuid,
  p_appointment_id uuid,
  p_customer_id uuid,
  p_service_id uuid,
  p_appointment_date date,
  p_appointment_time time,
  p_notes text default null,
  p_check_only boolean default false
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
$function$;
revoke all on function anaai_private.reschedule_appointment_core(uuid,uuid,uuid,uuid,date,time,text,boolean) from public,anon;
grant execute on function anaai_private.reschedule_appointment_core(uuid,uuid,uuid,uuid,date,time,text,boolean) to authenticated,service_role;

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
$function$;

create or replace function anaai_private.appointment_lifecycle_core(
  p_business_id uuid,
  p_appointment_id uuid,
  p_idempotency_key uuid,
  p_request_fingerprint text,
  p_action_type text,
  p_preclaimed_action uuid default null
) returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
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
$function$;
revoke all on function anaai_private.appointment_lifecycle_core(uuid,uuid,uuid,text,text,uuid) from public,anon,authenticated,service_role;

create or replace function public._appointment_lifecycle_action(
  p_business_id uuid,
  p_appointment_id uuid,
  p_idempotency_key uuid,
  p_request_fingerprint text,
  p_action_type text
) returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
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
$function$;

-- Only canonical E.164 is accepted, matching Voice booking's stored phone.
-- Duplicate customer records sharing a phone are deliberately not guessed.
create function anaai_private.voice_customer(p_business_id uuid, p_caller_phone text)
returns uuid language sql stable security invoker
set search_path = pg_catalog, public
as $function$
  select case when count(*) = 1 then (array_agg(c.id))[1] end
  from public.customers c
  where c.business_id = p_business_id and c.phone = p_caller_phone
    and p_caller_phone ~ '^\+[1-9][0-9]{7,14}$';
$function$;
revoke all on function anaai_private.voice_customer(uuid,text) from public,anon,authenticated,service_role;

create function public.voice_find_appointments_business(p_business_id uuid, p_caller_phone text)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public
as $function$
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
$function$;
revoke all on function public.voice_find_appointments_business(uuid,text) from public,anon,authenticated;
grant execute on function public.voice_find_appointments_business(uuid,text) to service_role;

-- A single bounded bridge supports check-only and commit. All commit retries
-- claim the action BEFORE ordered date locks, then row locks, just like manual
-- scheduling. The caller cannot change the target customer or service.
create function public.voice_manage_appointment_business(
  p_business_id uuid, p_caller_phone text, p_appointment_id uuid,
  p_action_type text, p_idempotency_key uuid, p_request_fingerprint text,
  p_expected jsonb, p_date date default null, p_time time default null,
  p_check_only boolean default false
) returns jsonb language plpgsql volatile security definer
set search_path = pg_catalog, public
as $function$
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
$function$;
revoke all on function public.voice_manage_appointment_business(uuid,text,uuid,text,uuid,text,jsonb,date,time,boolean) from public,anon,authenticated;
grant execute on function public.voice_manage_appointment_business(uuid,text,uuid,text,uuid,text,jsonb,date,time,boolean) to service_role;
commit;
