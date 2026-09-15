-- Forward correction to deployed 202609150003. Do not edit/reapply that migration.
-- Exact legacy reason contract verified by the project owner. Allowlisted failure
-- paths return before any customer or appointment writes. Unknown/malformed results
-- still raise into the outer exception block and roll back all invocation writes.
-- Legacy book_appointment_atomic_business and its search_path remain unchanged;
-- hardening that legacy search_path is separate future work.
begin;

create or replace function public.schedule_appointment_idempotent_business(
  p_business_id uuid, p_idempotency_key uuid, p_request_fingerprint text,
  p_operation text, p_request jsonb
) returns jsonb language plpgsql volatile security definer
set search_path = pg_catalog, public
as $function$
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
$function$;
revoke all on function public.schedule_appointment_idempotent_business(uuid,uuid,text,text,jsonb) from public,anon;
grant execute on function public.schedule_appointment_idempotent_business(uuid,uuid,text,text,jsonb) to authenticated;

commit;
