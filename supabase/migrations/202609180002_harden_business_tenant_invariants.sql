begin;

-- Remove known duplicate/test profiles for Om Beauty Salon.
-- Fail closed if the canonical profile is unexpectedly missing.
do $$
begin
  if not exists (
    select 1
    from public.business_profiles
    where id = '9df9f26d-16be-486b-a840-325ccfe97aef'
      and business_id = '5bf3bb78-f107-47df-9269-a9510d42c9a7'
  ) then
    raise exception 'Canonical Om Beauty business profile is missing.';
  end if;
end
$$;

delete from public.business_profiles
where business_id = '5bf3bb78-f107-47df-9269-a9510d42c9a7'
  and id in (
    '28c5c40a-d472-483d-97d3-ad71e78892d8',
    'd5e07430-782d-4926-93f0-4d677b8f38b1'
  );

-- Tenant-owned records must always belong to a business.
alter table public.business_profiles
  alter column business_id set not null;

alter table public.services
  alter column business_id set not null;

alter table public.customers
  alter column business_id set not null;

alter table public.appointments
  alter column business_id set not null;

alter table public.business_knowledge
  alter column business_id set not null;

alter table public.ai_settings
  alter column business_id set not null;

-- One profile per business.
alter table public.business_profiles
  add constraint business_profiles_business_id_unique
  unique (business_id);

-- AI settings belong to businesses, not individual users.
alter table public.ai_settings
  drop constraint ai_settings_user_id_unique;

alter table public.ai_settings
  add constraint ai_settings_business_id_unique
  unique (business_id);

commit;
