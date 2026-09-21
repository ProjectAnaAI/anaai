-- AnaAI business-level simultaneous appointment capacity.
--
-- appointment_capacity is the maximum number of active appointments
-- (Booked or Confirmed) that the business may serve simultaneously.
--
-- Existing businesses intentionally default to 1 so deployment preserves
-- the current single-concurrent-appointment scheduling behavior.

begin;

alter table public.businesses
  add column if not exists appointment_capacity integer;

update public.businesses
set appointment_capacity = 1
where appointment_capacity is null;

alter table public.businesses
  alter column appointment_capacity set default 1,
  alter column appointment_capacity set not null;

alter table public.businesses
  drop constraint if exists businesses_appointment_capacity_check;

alter table public.businesses
  add constraint businesses_appointment_capacity_check
  check (
    appointment_capacity >= 1
    and appointment_capacity <= 100
  );

commit;