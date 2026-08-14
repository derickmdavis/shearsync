create table public.sms_inbound_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('twilio')),
  provider_message_id text not null,
  from_phone text not null,
  from_phone_normalized text not null,
  to_phone text,
  to_phone_normalized text,
  body text not null,
  classification text not null check (classification in ('stop', 'start', 'help', 'other')),
  classification_source text not null check (classification_source in ('twilio_opt_out_type', 'keyword_fallback')),
  provider_metadata jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint sms_inbound_events_provider_message_unique unique (provider, provider_message_id)
);

create index sms_inbound_events_from_phone_idx
  on public.sms_inbound_events(from_phone_normalized, received_at desc);

alter table public.sms_inbound_events enable row level security;
