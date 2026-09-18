begin;

create or replace function public.create_business_for_current_user(p_setup jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_user uuid := auth.uid();
  v_business uuid;
  v_inserted boolean;
  v_day text;
  v_hours jsonb;
  v_service jsonb;
  v_field text;
  v_timezone text;
begin
  if v_user is null then
    return jsonb_build_object(
      'success', false,
      'code', 'UNAUTHORIZED'
    );
  end if;

  -- Membership must be read from a fresh statement snapshot after waiting.
  if current_setting('transaction_isolation') <> 'read committed' then
    return jsonb_build_object(
      'success', false,
      'code', 'UNSUPPORTED_ISOLATION'
    );
  end if;

  -- Serialize onboarding for this authenticated login.
  perform pg_advisory_xact_lock(
    hashtextextended(
      'anaai:onboarding:' || v_user::text,
      0
    )
  );

  -- MVP rule: one business/login.
  if exists (
    select 1
    from public.business_members
    where user_id = v_user
  ) then
    return jsonb_build_object(
      'success', false,
      'code', 'ALREADY_PROVISIONED'
    );
  end if;

  -- Validate the complete setup before performing any writes.
  begin
    if jsonb_typeof(p_setup) is distinct from 'object' then
      raise exception 'invalid';
    end if;

    foreach v_field in array array[
      'name',
      'phone',
      'email',
      'address',
      'timezone',
      'receptionist',
      'greeting'
    ]
    loop
      if jsonb_typeof(p_setup -> v_field) is distinct from 'string'
         or length(p_setup ->> v_field) > 2000 then
        raise exception 'invalid';
      end if;
    end loop;

    -- Core business details are mandatory.
    if btrim(p_setup ->> 'name') = ''
       or length(p_setup ->> 'name') > 200
       or btrim(p_setup ->> 'phone') = ''
       or btrim(p_setup ->> 'email') = ''
       or btrim(p_setup ->> 'address') = ''
       or btrim(p_setup ->> 'timezone') = ''
       or length(p_setup ->> 'timezone') > 200
       or btrim(p_setup ->> 'receptionist') = ''
       or btrim(p_setup ->> 'greeting') = '' then
      raise exception 'invalid';
    end if;

    if (p_setup ->> 'email')
       !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
      raise exception 'invalid';
    end if;

    if (p_setup ->> 'phone')
       !~ '^[+0-9[:space:]().-]{7,30}$' then
      raise exception 'invalid';
    end if;

    v_timezone := btrim(p_setup ->> 'timezone');

    if not exists (
      select 1
      from pg_catalog.pg_timezone_names
      where name = v_timezone
    ) then
      raise exception 'invalid';
    end if;

    foreach v_day in array array[
      'monday',
      'tuesday',
      'wednesday',
      'thursday',
      'friday',
      'saturday',
      'sunday'
    ]
    loop
      v_hours := p_setup -> 'hours' -> v_day;

      if jsonb_typeof(v_hours) is distinct from 'object'
         or jsonb_typeof(v_hours -> 'closed')
            is distinct from 'boolean' then
        raise exception 'invalid';
      end if;

      if not (v_hours ->> 'closed')::boolean then
        if jsonb_typeof(v_hours -> 'open') is distinct from 'string'
           or jsonb_typeof(v_hours -> 'close') is distinct from 'string'
           or (v_hours ->> 'open')
              !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
           or (v_hours ->> 'close')
              !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
           or (v_hours ->> 'close')::time
              <= (v_hours ->> 'open')::time then
          raise exception 'invalid';
        end if;
      end if;
    end loop;

    if jsonb_typeof(p_setup -> 'services')
       is distinct from 'array' then
      raise exception 'invalid';
    end if;

    if jsonb_array_length(p_setup -> 'services')
       not between 1 and 50 then
      raise exception 'invalid';
    end if;

    for v_service in
      select value
      from jsonb_array_elements(p_setup -> 'services')
    loop
      foreach v_field in array array[
        'name',
        'duration',
        'price',
        'description'
      ]
      loop
        if jsonb_typeof(v_service -> v_field)
           is distinct from 'string' then
          raise exception 'invalid';
        end if;
      end loop;

      if btrim(v_service ->> 'name') = ''
         or length(v_service ->> 'name') > 200
         or length(v_service ->> 'description') > 2000
         or (v_service ->> 'duration') !~ '^[0-9]+$'
         or (v_service ->> 'duration')::integer
            not between 1 and 1440 then
        raise exception 'invalid';
      end if;

      if (v_service ->> 'price') <> ''
         and (v_service ->> 'price')
             !~ '^[0-9]+(\.[0-9]{1,2})?$' then
        raise exception 'invalid';
      end if;
    end loop;

  exception
    when others then
      return jsonb_build_object(
        'success', false,
        'code', 'INVALID_SETUP'
      );
  end;

  insert into public.businesses (
    name,
    timezone
  )
  values (
    btrim(p_setup ->> 'name'),
    v_timezone
  )
  returning id into v_business;

  if not found then
    raise exception 'provisioning write failed';
  end if;

  insert into public.business_members (
    business_id,
    user_id,
    role
  )
  values (
    v_business,
    v_user,
    'owner'
  )
  returning true into v_inserted;

  if not found then
    raise exception 'provisioning write failed';
  end if;

  insert into public.business_profiles (
    business_id,
    user_id,
    business_name,
    owner_name,
    phone,
    email,
    address,
    business_hours,
    timezone
  )
  values (
    v_business,
    v_user,
    btrim(p_setup ->> 'name'),
    '',
    btrim(p_setup ->> 'phone'),
    btrim(p_setup ->> 'email'),
    btrim(p_setup ->> 'address'),
    (p_setup -> 'hours')::text,
    v_timezone
  )
  returning true into v_inserted;

  if not found then
    raise exception 'provisioning write failed';
  end if;

  for v_service in
    select value
    from jsonb_array_elements(p_setup -> 'services')
  loop
    insert into public.services (
      business_id,
      user_id,
      name,
      duration_minutes,
      price,
      description,
      is_active
    )
    values (
      v_business,
      v_user,
      btrim(v_service ->> 'name'),
      (v_service ->> 'duration')::integer,
      nullif(v_service ->> 'price', '')::numeric,
      nullif(btrim(v_service ->> 'description'), ''),
      true
    )
    returning true into v_inserted;

    if not found then
      raise exception 'provisioning write failed';
    end if;
  end loop;

  insert into public.ai_settings (
    business_id,
    user_id,
    receptionist_name,
    greeting
  )
  values (
    v_business,
    v_user,
    btrim(p_setup ->> 'receptionist'),
    btrim(p_setup ->> 'greeting')
  )
  returning true into v_inserted;

  if not found then
    raise exception 'provisioning write failed';
  end if;

  return jsonb_build_object(
    'success', true
  );

exception
  when others then
    -- The exception handler rolls back writes in this function's protected block.
    -- Never expose submitted values or PostgreSQL error details.
    raise log 'AnaAI provisioning failed SQLSTATE=%', SQLSTATE;

    return jsonb_build_object(
      'success', false,
      'code', 'INTERNAL_ERROR'
    );
end;
$function$;

commit;