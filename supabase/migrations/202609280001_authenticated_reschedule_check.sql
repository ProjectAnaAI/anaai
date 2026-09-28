-- Apply after 202609210008. No schema/data changes; no slot reservation.
begin;

create function public.check_reschedule_appointment_business(
  p_business_id uuid,
  p_appointment_id uuid,
  p_customer_id uuid,
  p_service_id uuid,
  p_appointment_date date,
  p_appointment_time time
) returns jsonb
language plpgsql volatile security invoker
set search_path = pg_catalog, public
as $function$
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
$function$;

revoke all on function public.check_reschedule_appointment_business(
  uuid, uuid, uuid, uuid, date, time
) from public, anon, service_role;
grant execute on function public.check_reschedule_appointment_business(
  uuid, uuid, uuid, uuid, date, time
) to authenticated;

commit;
