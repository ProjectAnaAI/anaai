-- AnaAI legacy AI-chat booking: business-level simultaneous capacity.
--
-- REVIEW ONLY: do not deploy until the acceptance tests in
-- tests/appointment-capacity.README.md and tests/legacy-ai-capacity.README.md
-- pass. Apply AFTER 202609210002.
--
-- Requires 202609210001 (businesses.appointment_capacity) and 202609210002
-- (anaai_private.check_appointment_capacity_business).
--
-- This closes the last capacity-consistency gap. Before this migration
-- public.book_appointment_atomic_business was the only scheduling path still
-- enforcing single-overlap, so on a business with appointment_capacity > 1 the
-- AI chat booking tool refused slots that manual scheduling and Voice accept.
--
-- PROVENANCE
--
-- The body below is the deployed definition returned by pg_get_functiondef,
-- reproduced verbatim, with exactly one region changed: the per-appointment
-- overlap loop is replaced by a call to the shared private capacity helper.
-- The four declarations that loop owned (v_existing, v_existing_duration,
-- v_existing_start, v_existing_end) are removed because nothing else used
-- them, and v_capacity is added. Nothing else was rewritten, reordered or
-- reformatted.
--
-- DELIBERATELY PRESERVED
--
--   - the exact deployed signature
--   - SECURITY INVOKER (see the note on the explicit clause below)
--   - SET search_path TO 'public'
--   - the auth.uid() check and its exact reason string
--   - public.is_business_member(p_business_id), including its deployed form
--   - every input validation and every caller-visible reason string
--   - the business/date advisory lock expression
--   - service lookup, duration validation and business-hours parsing
--   - closed-day, opening-time and closing-time behaviour
--   - customer lookup by business-scoped trimmed phone ordered by created_at,
--     customer creation and customer update, including user_id and notes
--   - the appointment insert, 'Booked' status, notes and email handling
--   - the success receipt, key for key
--
-- Two clauses ARE stated explicitly that the deployed text left implicit:
-- `volatile` and `security invoker`. Both are PostgreSQL's defaults and
-- pg_get_functiondef never emits either, so this is a no-op at runtime. They
-- are written out so a future CREATE OR REPLACE cannot silently change the
-- security context of a function that is executable by anon.
--
-- HELPER ACCESS
--
-- No grant is added or needed. 202609210002 already grants USAGE on schema
-- anaai_private and EXECUTE on the helper to authenticated and service_role,
-- which covers both callers of this SECURITY INVOKER function: an
-- authenticated member calling it directly, and the SECURITY DEFINER wrapper
-- public.schedule_appointment_idempotent_business.
--
-- anon holds EXECUTE on this outer function but NOT on the helper. The
-- auth.uid() guard is therefore load-bearing for PERMISSIONS as well as
-- authorization: it returns before the helper is ever reached, so an
-- unauthenticated caller still receives 'Authentication is required.' rather
-- than a permission error. The helper call below must stay after that guard.
--
-- search_path is 'public', so anaai_private is NOT on the search path. The
-- call is schema-qualified, which is what makes it resolve.
--
-- REJECTION CONTRACT
--
-- public.schedule_appointment_idempotent_business (202609150004) matches this
-- function's rejections by EXACT reason string and rejects any object carrying
-- a key other than success/reason. Both capacity rejections below therefore
-- reuse the two strings that migration already allowlists, and build an object
-- with exactly those two keys.
--
-- An indeterminate capacity result has no allowlisted string, so it raises.
-- This function has no exception handler, so the raise propagates to that
-- wrapper's handler, which rolls back the entire invocation including the
-- durable action claim and returns INTERNAL_ERROR. Nothing is written and a
-- retry with the same idempotency key is permitted. Capacity that cannot be
-- determined must never become a booking.

begin;

create or replace function public.book_appointment_atomic_business(
  p_business_id uuid,
  p_customer_name text,
  p_customer_phone text,
  p_customer_email text,
  p_service_id uuid,
  p_appointment_date date,
  p_appointment_time time without time zone,
  p_notes text default null::text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path to 'public'
as $function$
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
$function$;

/*
 * Privileges are deliberately NOT restated.
 *
 * CREATE OR REPLACE preserves the existing ACL, and the deployed grants
 * (postgres, anon, authenticated, service_role) are a separate legacy contract
 * that this capacity patch has no evidence to change. Tightening anon is a
 * candidate for a later hardening pass, together with the 'public'-only
 * search_path that 202609150004 already flagged as outstanding.
 */

commit;
