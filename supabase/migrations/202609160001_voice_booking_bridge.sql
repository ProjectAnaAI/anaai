-- AnaAI trusted phone-system booking boundary.
--
-- This migration intentionally does NOT modify the existing authenticated
-- dashboard/AI scheduling RPCs. Voice calls do not impersonate a Supabase user.
-- This RPC is callable only by the server-side service_role.
--
-- IMPORTANT:
-- The database cannot independently prove that p_business_id originated from an
-- authenticated Twilio request. The Next.js voice ingress remains responsible
-- for authenticating the request and resolving business_id from the called
-- phone number. Browser/anon/authenticated roles cannot execute this function.

begin;

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
  v_existing record;
  v_existing_duration integer;
  v_existing_start timestamp without time zone;
  v_existing_end timestamp without time zone;
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
    for v_existing in
      select
        a.id,
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
        v_receipt := jsonb_build_object(
          'success', false,
          'changed', false,
          'code', 'INVALID_EXISTING_SCHEDULE'
        );
        exit;
      end if;

      v_existing_start :=
        p_appointment_date::timestamp + v_existing.appointment_time;

      v_existing_end :=
        v_existing_start + make_interval(mins => v_existing_duration);

      if v_requested_start < v_existing_end
         and v_requested_end > v_existing_start then
        v_receipt := jsonb_build_object(
          'success', false,
          'changed', false,
          'code', 'SLOT_CONFLICT'
        );
        exit;
      end if;
    end loop;
  end if;

  if v_receipt is null then
    select c.id
    into v_customer_id
    from public.customers c
    where c.business_id = p_business_id
      and c.phone = btrim(p_customer_phone)
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
        null,
        btrim(p_customer_name),
        btrim(p_customer_phone),
        v_email,
        'Created by AnaAI phone booking'
      )
      returning id into v_customer_id;
    else
      update public.customers
      set
        full_name = btrim(p_customer_name),
        email = v_email
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


-- Server-only notification delivery boundary for trusted phone-system actions.
--
-- These functions intentionally mirror the existing authenticated
-- claim_appointment_notification / finish_appointment_notification state machine,
-- but do not require auth.uid() or business membership. Authorization is instead
-- enforced by EXECUTE privileges: only service_role may call them.
--
-- The application must call these only from the trusted server after the voice
-- ingress has already authenticated the request and resolved the business.

create or replace function public.voice_claim_appointment_notification(
  p_business_id uuid,
  p_action_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
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
$function$;

create or replace function public.voice_finish_appointment_notification(
  p_business_id uuid,
  p_notification_id uuid,
  p_claim_token uuid,
  p_status text,
  p_provider_id text default null
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
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
$function$;

revoke all on function public.voice_claim_appointment_notification(
  uuid, uuid
) from public, anon, authenticated;

revoke all on function public.voice_finish_appointment_notification(
  uuid, uuid, uuid, text, text
) from public, anon, authenticated;

grant execute on function public.voice_claim_appointment_notification(
  uuid, uuid
) to service_role;

grant execute on function public.voice_finish_appointment_notification(
  uuid, uuid, uuid, text, text
) to service_role;

commit;
