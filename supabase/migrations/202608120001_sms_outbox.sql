alter table public.users
  add column if not exists sms_delivery_enabled boolean not null default true;

create table public.sms_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  client_id uuid references public.clients(id) on delete set null,
  appointment_id uuid references public.appointments(id) on delete set null,
  message_type text not null check (message_type in (
    'appointment_confirmation', 'appointment_reminder', 'appointment_cancelled',
    'appointment_rescheduled', 'waitlist_update', 'rebooking_prompt',
    'birthday_reminder', 'marketing', 'business_recap'
  )),
  recipient_phone text not null,
  recipient_phone_normalized text not null,
  body text not null check (char_length(body) between 1 and 1600),
  status text not null default 'queued' check (status in (
    'queued', 'sending', 'sent', 'delivered', 'failed', 'skipped', 'cancelled'
  )),
  idempotency_key text not null check (char_length(trim(idempotency_key)) between 1 and 200),
  provider text,
  provider_message_id text,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz default now(),
  last_attempt_at timestamptz,
  sending_started_at timestamptz,
  lease_token uuid,
  lease_expires_at timestamptz,
  sent_at timestamptz,
  delivered_at timestamptz,
  failed_at timestamptz,
  skipped_at timestamptz,
  error_code text,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sms_messages_user_idempotency_unique unique (user_id, idempotency_key),
  constraint sms_messages_provider_length_check check (provider is null or char_length(provider) <= 80),
  constraint sms_messages_provider_message_length_check check (
    provider_message_id is null or char_length(provider_message_id) <= 255
  ),
  constraint sms_messages_error_length_check check (
    (error_code is null or char_length(error_code) <= 120)
    and (error_message is null or char_length(error_message) <= 2000)
  )
);

create index sms_messages_delivery_retry_idx
  on public.sms_messages(status, next_attempt_at, created_at);
create index sms_messages_lease_expiry_idx
  on public.sms_messages(status, lease_expires_at)
  where status = 'sending';
create index sms_messages_user_status_idx
  on public.sms_messages(user_id, status, created_at);
create index sms_messages_provider_message_idx
  on public.sms_messages(provider, provider_message_id)
  where provider_message_id is not null;

alter table public.sms_messages enable row level security;

create or replace function public.set_sms_message_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger sms_messages_set_updated_at
  before update on public.sms_messages
  for each row execute function public.set_sms_message_updated_at();
