-- REVIEW ONLY: unapplied. Run authenticated PostgreSQL concurrency/RLS tests first.
-- Definer functions must be owned by the trusted migration role, never an app role.
-- Existing appointment write grants and booking/reschedule RPCs are unchanged.
begin;

create table public.appointment_actions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  idempotency_key uuid not null,
  action_type text not null check (action_type in ('book','reschedule','confirm','cancel')),
  request_payload jsonb,
  request_fingerprint text not null check (length(btrim(request_fingerprint)) between 1 and 512),
  -- Intentionally retained even if the appointment is deleted: replay needs the
  -- original target identity. This is historical evidence, not a live-row FK.
  appointment_id uuid,
  success boolean not null default false,
  changed boolean not null default false,
  -- SQL NULL represents an unfinished claim; completion requires a receipt.
  result jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (business_id, idempotency_key),
  unique (id, business_id),
  check (not changed or success),
  constraint appointment_actions_completion_check check (
    (completed_at is null and not success and not changed and result is null)
    or
    (completed_at is not null and result is not null
      and jsonb_typeof(result) = 'object' and result <> '{}'::jsonb)
  )
);
create table public.appointment_notifications (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  appointment_action_id uuid not null,
  appointment_id uuid not null,
  channel text not null check (channel = 'sms'),
  notification_kind text not null check (notification_kind in ('confirmation','cancellation','reschedule')),
  status text not null default 'pending' check (status in ('pending','accepted','failed','uncertain')),
  payload jsonb not null,
  claim_token uuid,
  provider_message_id text,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  accepted_at timestamptz,
  foreign key (appointment_action_id, business_id)
    references public.appointment_actions(id, business_id) on delete no action,
  unique (appointment_action_id, channel, notification_kind)
);
create index appointment_notifications_business_status_idx
  on public.appointment_notifications (business_id, status);
alter table public.appointment_actions enable row level security;
alter table public.appointment_notifications enable row level security;
revoke all on public.appointment_actions, public.appointment_notifications from public, anon, authenticated;
grant select on public.appointment_actions to authenticated;
-- The delivery claim token is not exposed by ordinary member SELECT.
grant select (id,business_id,appointment_action_id,appointment_id,channel,notification_kind,status,
  provider_message_id,last_error_code,created_at,updated_at,accepted_at)
  on public.appointment_notifications to authenticated;
create policy appointment_actions_member_read on public.appointment_actions
  for select to authenticated using (public.is_business_member(business_id));
create policy appointment_notifications_member_read on public.appointment_notifications
  for select to authenticated using (public.is_business_member(business_id));

-- Private executor. Elevated privileges are necessary because clients must not
-- be able to forge receipts/outbox rows through direct DML. Every call explicitly
-- checks auth.uid(), membership, action allowlist and tenant/target binding.
create function public._appointment_lifecycle_action(
  p_business_id uuid, p_appointment_id uuid, p_idempotency_key uuid,
  p_request_fingerprint text, p_action_type text
) returns jsonb language plpgsql volatile security definer
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
    return jsonb_build_object('success',false,'code','UNAUTHORIZED','replayed',false);
  end if;
  if p_business_id is null or not coalesce(public.is_business_member(p_business_id),false) then
    return jsonb_build_object('success',false,'code','FORBIDDEN','replayed',false);
  end if;
  if current_setting('transaction_isolation') <> 'read committed' then
    return jsonb_build_object('success',false,'code','UNSUPPORTED_ISOLATION','replayed',false);
  end if;
  if p_appointment_id is null or p_idempotency_key is null
     or p_request_fingerprint is null or length(btrim(p_request_fingerprint)) not between 1 and 512
     or p_action_type is null or p_action_type not in ('confirm','cancel') then
    return jsonb_build_object('success',false,'code','INVALID_REQUEST','replayed',false);
  end if;

  -- Unique insertion waits for a competing transaction's commit/rollback. All
  -- mutation and terminal receipt writes below belong to this same transaction.
  insert into public.appointment_actions
    (business_id, actor_user_id, idempotency_key, action_type, request_fingerprint, appointment_id)
    values (p_business_id,v_user_id,p_idempotency_key,p_action_type,p_request_fingerprint,p_appointment_id)
    on conflict (business_id,idempotency_key) do nothing
    returning * into v_action;
  if not found then
    -- Fresh READ COMMITTED snapshot after waiting on the unique constraint.
    select * into v_action from public.appointment_actions
      where business_id = p_business_id and idempotency_key = p_idempotency_key for update;
    if not found then raise exception 'missing action'; end if;
    if v_action.action_type is distinct from p_action_type
       or v_action.request_fingerprint is distinct from p_request_fingerprint
       or v_action.appointment_id is distinct from p_appointment_id then
      return jsonb_build_object('success',false,'code','IDEMPOTENCY_CONFLICT','replayed',false);
    end if;
    if v_action.completed_at is null then
      return jsonb_build_object('success',false,'code','ACTION_INCOMPLETE','replayed',false);
    end if;
    -- Original outcome, not an assertion of the appointment's present status.
    return v_action.result || jsonb_build_object('replayed',true);
  end if;

  select appointment_date into v_source_date from public.appointments
    where id = p_appointment_id and business_id = p_business_id;
  if not found then v_code := 'APPOINTMENT_NOT_FOUND';
  else
    -- Scheduling advisory lock BEFORE row lock, matching booking/rescheduling.
    -- Legacy NULL dates have no scheduling bucket; still lock and recheck the row.
    if v_source_date is not null then
      perform pg_advisory_xact_lock(hashtext(p_business_id::text || ':' || v_source_date::text));
    end if;
    select * into v_appointment from public.appointments
      where id = p_appointment_id and business_id = p_business_id for update;
    if not found then v_code := 'APPOINTMENT_NOT_FOUND';
    elsif v_appointment.appointment_date is distinct from v_source_date then v_code := 'SOURCE_DATE_CHANGED';
    else
      v_previous_status := v_appointment.status;
      v_target_status := case when p_action_type = 'confirm' then 'Confirmed' else 'Cancelled' end;
      if v_previous_status = v_target_status then
        v_success := true;
        v_code := 'ALREADY_IN_TARGET_STATE';
      elsif (p_action_type = 'confirm' and v_previous_status = 'Booked')
         or (p_action_type = 'cancel' and v_previous_status in ('Booked','Confirmed')) then
        update public.appointments set status = v_target_status
          where id = p_appointment_id and business_id = p_business_id
          returning * into v_appointment;
        if not found then raise exception 'missing updated appointment'; end if;
        if v_appointment.status is distinct from v_target_status then raise exception 'unexpected transition'; end if;
        v_success := true;
        v_changed := true;
        v_code := 'APPLIED';
      else
        v_code := 'INVALID_TRANSITION';
      end if;
    end if;
  end if;

  v_receipt := jsonb_build_object(
    'success',v_success,'changed',v_changed,'code',v_code,'replayed',false,
    'action_id',v_action.id,'action_type',p_action_type,
    'business_id',p_business_id,'appointment_id',p_appointment_id,
    'previous_status',v_previous_status,
    'status',case when v_success then v_target_status else v_previous_status end,
    'appointment',case when v_success then to_jsonb(v_appointment) else null end,
    'receipt_scope','action_outcome','completed_at',clock_timestamp()
  );
  if v_changed then
    insert into public.appointment_notifications
      (business_id,appointment_action_id,appointment_id,channel,notification_kind,payload)
      values (p_business_id,v_action.id,p_appointment_id,'sms',
        case when p_action_type = 'confirm' then 'confirmation' else 'cancellation' end,
        jsonb_build_object('action',p_action_type,'phone',v_appointment.customer_phone,'date',v_appointment.appointment_date,'time',v_appointment.appointment_time));
    if not found then raise exception 'missing notification'; end if;
  end if;
  update public.appointment_actions set success = v_success, changed = v_changed,
    result = v_receipt, completed_at = (v_receipt ->> 'completed_at')::timestamptz
    where id = v_action.id and business_id = p_business_id;
  if not found then raise exception 'missing receipt'; end if;
  return v_receipt;
exception when others then
  -- Rolls back this protected block's claim, appointment update and notification.
  -- Internal failures are not persisted as terminal ledger outcomes. All work
  -- in this protected block rolls back; no mutation commits, so retry is permitted.
  raise log 'AnaAI lifecycle action failed sqlstate=%', SQLSTATE;
  return jsonb_build_object('success',false,'code','INTERNAL_ERROR','replayed',false);
end;
$function$;
revoke all on function public._appointment_lifecycle_action(uuid,uuid,uuid,text,text) from public, anon, authenticated;

-- Definer wrappers can invoke the private executor; callers cannot invoke it or
-- write either table directly. Wrapper action types are fixed, not browser input.
create function public.confirm_appointment_atomic_business(
  p_business_id uuid, p_appointment_id uuid, p_idempotency_key uuid, p_request_fingerprint text
) returns jsonb language plpgsql volatile security definer
set search_path = pg_catalog, public
as $function$
begin
  if auth.uid() is null then return jsonb_build_object('success',false,'code','UNAUTHORIZED'); end if;
  if p_business_id is null or not coalesce(public.is_business_member(p_business_id),false) then
    return jsonb_build_object('success',false,'code','FORBIDDEN'); end if;
  return public._appointment_lifecycle_action(p_business_id,p_appointment_id,p_idempotency_key,p_request_fingerprint,'confirm');
end;
$function$;
create function public.cancel_appointment_atomic_business(
  p_business_id uuid, p_appointment_id uuid, p_idempotency_key uuid, p_request_fingerprint text
) returns jsonb language plpgsql volatile security definer
set search_path = pg_catalog, public
as $function$
begin
  if auth.uid() is null then return jsonb_build_object('success',false,'code','UNAUTHORIZED'); end if;
  if p_business_id is null or not coalesce(public.is_business_member(p_business_id),false) then
    return jsonb_build_object('success',false,'code','FORBIDDEN'); end if;
  return public._appointment_lifecycle_action(p_business_id,p_appointment_id,p_idempotency_key,p_request_fingerprint,'cancel');
end;
$function$;
revoke all on function public.confirm_appointment_atomic_business(uuid,uuid,uuid,text) from public, anon;
revoke all on function public.cancel_appointment_atomic_business(uuid,uuid,uuid,text) from public, anon;
grant execute on function public.confirm_appointment_atomic_business(uuid,uuid,uuid,text) to authenticated;
grant execute on function public.cancel_appointment_atomic_business(uuid,uuid,uuid,text) to authenticated;

-- Structured payload is bound in addition to the caller fingerprint. Definer
-- execution never trusts arbitrary client tenant references: the existing RPCs
-- enforce membership and tenant ownership; the returned row is checked again.
create function public.schedule_appointment_idempotent_business(
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
    -- AI RPC exposes only reason; roll back its failure path conservatively.
    if p_operation='ai_book' then raise exception 'ai booking rejected'; end if;
    v_changed := false;
    v_receipt := jsonb_build_object('success',false,'changed',false,'code',
      case when v_result ->> 'code' in ('UNAUTHORIZED','FORBIDDEN','INVALID_CUSTOMER','INVALID_SERVICE','INVALID_DURATION','INVALID_SCHEDULE','INVALID_HOURS','CLOSED','OUTSIDE_HOURS','SOURCE_DATE_CHANGED','SLOT_CONFLICT','INVALID_EXISTING_SCHEDULE','APPOINTMENT_NOT_FOUND','TERMINAL_APPOINTMENT')
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

-- Mark uncertain BEFORE leaving the transaction for the provider. Only the caller
-- holding the random claim token can record its outcome. Replays never reclaim it.
create function public.claim_appointment_notification(p_business_id uuid,p_action_id uuid)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,public
as $function$
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
$function$;
create function public.finish_appointment_notification(p_business_id uuid,p_notification_id uuid,p_claim_token uuid,p_status text,p_provider_id text default null)
returns boolean language plpgsql volatile security definer set search_path=pg_catalog,public
as $function$
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
$function$;
revoke all on function public.claim_appointment_notification(uuid,uuid) from public,anon;
revoke all on function public.finish_appointment_notification(uuid,uuid,uuid,text,text) from public,anon;
grant execute on function public.claim_appointment_notification(uuid,uuid) to authenticated;
grant execute on function public.finish_appointment_notification(uuid,uuid,uuid,text,text) to authenticated;
commit;
