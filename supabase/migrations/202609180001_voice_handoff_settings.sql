begin;

create table public.voice_handoff_settings (
  business_id uuid primary key
    references public.businesses(id) on delete cascade,
  human_transfer_phone text,
  is_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint voice_handoff_phone_format
    check (
      human_transfer_phone is null
      or human_transfer_phone ~ '^\+[1-9][0-9]{7,14}$'
    ),

  constraint voice_handoff_enabled_requires_phone
    check (
      not is_enabled
      or human_transfer_phone is not null
    )
);

alter table public.voice_handoff_settings
  enable row level security;

revoke all on table public.voice_handoff_settings
  from public, anon, authenticated;

commit;
