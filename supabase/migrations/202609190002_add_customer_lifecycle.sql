begin;

-- Customer records are part of the business's historical CRM record.
-- Routine removal is represented by deactivation rather than deletion so
-- appointments.customer_id continues to reference the original customer.
alter table public.customers
  add column is_active boolean not null default true;

-- Active customers are the normal working set for booking and CRM screens.
-- Keep this business-scoped because customers are tenant-owned records.
create index customers_business_active_created_idx
  on public.customers (business_id, is_active, created_at desc);

commit;