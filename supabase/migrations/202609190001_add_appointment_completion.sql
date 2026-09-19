begin;

alter table public.appointment_actions
  drop constraint if exists appointment_actions_action_type_check;

alter table public.appointment_actions
  add constraint appointment_actions_action_type_check
  check (
    action_type in (
      'book',
      'reschedule',
      'confirm',
      'cancel',
      'complete'
    )
  );

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

revoke all
on function public._appointment_lifecycle_action(
  uuid,
  uuid,
  uuid,
  text,
  text
)
from public, anon, authenticated;

create or replace function public.complete_appointment_atomic_business(
  p_business_id uuid,
  p_appointment_id uuid,
  p_idempotency_key uuid,
  p_request_fingerprint text
) returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
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
$function$;

revoke all
on function public.complete_appointment_atomic_business(
  uuid,
  uuid,
  uuid,
  text
)
from public, anon;

grant execute
on function public.complete_appointment_atomic_business(
  uuid,
  uuid,
  uuid,
  text
)
to authenticated;

commit;