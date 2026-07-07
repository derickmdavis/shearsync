create extension if not exists pgcrypto;

create table if not exists public.client_referral_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  referral_code text not null,
  referral_url text not null,
  status text not null default 'active',
  source text not null default 'client_share',
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint client_referral_links_status_check
    check (status in ('active', 'disabled')),
  constraint client_referral_links_code_format_check
    check (referral_code ~ '^rf_[A-Za-z0-9]{8,24}$'),
  constraint client_referral_links_referral_code_unique
    unique (referral_code)
);

alter table public.client_referral_links
  add column if not exists source text not null default 'client_share',
  add column if not exists disabled_at timestamptz;

create unique index if not exists client_referral_links_user_client_active_unique
  on public.client_referral_links(user_id, client_id)
  where status = 'active';

create index if not exists client_referral_links_user_id_idx
  on public.client_referral_links(user_id);

create index if not exists client_referral_links_client_id_idx
  on public.client_referral_links(client_id);

create index if not exists client_referral_links_referral_code_idx
  on public.client_referral_links(referral_code);

alter table public.clients
  add column if not exists original_referral_link_id uuid references public.client_referral_links(id) on delete set null,
  add column if not exists original_referred_by_client_id uuid references public.clients(id) on delete set null,
  add column if not exists original_referral_code text,
  add column if not exists original_acquisition_source text,
  add column if not exists original_referral_attributed_at timestamptz;

create index if not exists clients_original_referral_link_id_idx
  on public.clients(original_referral_link_id);

create index if not exists clients_original_referred_by_client_id_idx
  on public.clients(original_referred_by_client_id);

create index if not exists clients_original_referral_attributed_at_idx
  on public.clients(original_referral_attributed_at);

alter table public.appointments
  add column if not exists referral_link_id uuid references public.client_referral_links(id) on delete set null,
  add column if not exists referred_by_client_id uuid references public.clients(id) on delete set null,
  add column if not exists referral_code_used text,
  add column if not exists referral_attributed_at timestamptz,
  add column if not exists acquisition_source text;

create index if not exists appointments_referral_link_id_idx
  on public.appointments(referral_link_id);

create index if not exists appointments_referred_by_client_id_idx
  on public.appointments(referred_by_client_id);

create index if not exists appointments_referral_attributed_at_idx
  on public.appointments(referral_attributed_at);

create table if not exists public.referral_events (
  id uuid primary key default gen_random_uuid(),
  referral_link_id uuid not null references public.client_referral_links(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  referred_by_client_id uuid not null references public.clients(id) on delete cascade,
  referred_client_id uuid references public.clients(id) on delete set null,
  appointment_id uuid references public.appointments(id) on delete set null,
  event_type text not null,
  source text,
  campaign_id uuid,
  email_delivery_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  ip_hash text,
  user_agent text,
  created_at timestamptz not null default now(),
  constraint referral_events_event_type_check
    check (
      event_type in (
        'link_created',
        'opened',
        'link_clicked',
        'booking_started',
        'client_created',
        'appointment_requested',
        'appointment_booked',
        'booking_attributed',
        'appointment_completed',
        'attribution_created',
        'self_referral_blocked',
        'expired_attribution'
      )
    )
);

alter table public.referral_events
  add column if not exists referred_client_id uuid references public.clients(id) on delete set null,
  add column if not exists source text,
  add column if not exists campaign_id uuid,
  add column if not exists email_delivery_id uuid,
  add column if not exists ip_hash text,
  add column if not exists user_agent text;

create index if not exists referral_events_referral_link_id_idx
  on public.referral_events(referral_link_id);

create index if not exists referral_events_user_id_idx
  on public.referral_events(user_id);

create index if not exists referral_events_referred_by_client_id_idx
  on public.referral_events(referred_by_client_id);

create index if not exists referral_events_referred_client_id_idx
  on public.referral_events(referred_client_id);

create index if not exists referral_events_appointment_id_idx
  on public.referral_events(appointment_id);

create index if not exists referral_events_event_type_idx
  on public.referral_events(event_type);

create index if not exists referral_events_created_at_idx
  on public.referral_events(created_at);

create index if not exists referral_events_campaign_id_idx
  on public.referral_events(campaign_id);

create index if not exists referral_events_source_idx
  on public.referral_events(source);

create table if not exists public.thank_you_email_settings (
  user_id uuid primary key references public.users(id) on delete cascade,
  approval_required boolean not null default true,
  send_delay_hours integer not null default 0,
  subject_template text,
  custom_message_block text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint thank_you_email_settings_delay_check
    check (send_delay_hours between 0 and 720),
  constraint thank_you_email_settings_subject_length_check
    check (subject_template is null or char_length(subject_template) <= 160),
  constraint thank_you_email_settings_message_length_check
    check (custom_message_block is null or char_length(custom_message_block) <= 4000)
);

create table if not exists public.thank_you_emails (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  appointment_id uuid not null references public.appointments(id) on delete cascade,
  referral_link_id uuid references public.client_referral_links(id) on delete set null,
  email_event_id uuid references public.appointment_email_events(id) on delete set null,
  recipient_email text not null,
  status text not null default 'queued',
  approval_required boolean not null default false,
  send_after timestamptz not null,
  referral_code_snapshot text,
  referral_url_snapshot text,
  qr_code_url_snapshot text,
  subject_snapshot text,
  custom_message_block_snapshot text,
  template_data jsonb not null default '{}'::jsonb,
  approved_at timestamptz,
  approved_by uuid references public.users(id) on delete set null,
  cancelled_at timestamptz,
  cancelled_reason text,
  sent_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint thank_you_emails_recipient_email_check
    check (char_length(trim(recipient_email)) > 0),
  constraint thank_you_emails_subject_length_check
    check (subject_snapshot is null or char_length(subject_snapshot) <= 160),
  constraint thank_you_emails_message_length_check
    check (custom_message_block_snapshot is null or char_length(custom_message_block_snapshot) <= 4000),
  constraint thank_you_emails_status_check
    check (status in ('pending_approval', 'queued', 'sending', 'sent', 'cancelled', 'skipped', 'failed', 'superseded'))
);

alter table public.thank_you_emails
  add column if not exists referral_link_id uuid references public.client_referral_links(id) on delete set null,
  add column if not exists referral_code_snapshot text,
  add column if not exists referral_url_snapshot text,
  add column if not exists qr_code_url_snapshot text;

alter table public.appointment_email_events
  add column if not exists thank_you_email_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'appointment_email_events_thank_you_email_id_fkey'
  ) then
    alter table public.appointment_email_events
      add constraint appointment_email_events_thank_you_email_id_fkey
      foreign key (thank_you_email_id)
      references public.thank_you_emails(id)
      on delete set null;
  end if;
end
$$;

do $$
begin
  execute 'create index if not exists thank_you_emails_referral_link_id_idx on public.thank_you_emails(referral_link_id)';
end
$$;

create index if not exists thank_you_emails_user_status_send_after_idx
  on public.thank_you_emails(user_id, status, send_after);
create index if not exists thank_you_emails_status_send_after_idx
  on public.thank_you_emails(status, send_after);
create index if not exists thank_you_emails_client_id_idx
  on public.thank_you_emails(client_id);
create index if not exists thank_you_emails_appointment_id_idx
  on public.thank_you_emails(appointment_id);
create index if not exists thank_you_emails_email_event_id_idx
  on public.thank_you_emails(email_event_id);
create index if not exists thank_you_email_settings_user_id_idx
  on public.thank_you_email_settings(user_id);
create unique index if not exists thank_you_emails_active_appointment_idx
  on public.thank_you_emails(user_id, appointment_id)
  where status in ('pending_approval', 'queued', 'sending', 'failed', 'sent');
create index if not exists appointment_email_events_thank_you_email_id_idx
  on public.appointment_email_events(thank_you_email_id);

alter table public.client_referral_links enable row level security;
alter table public.referral_events enable row level security;
alter table public.thank_you_email_settings enable row level security;
alter table public.thank_you_emails enable row level security;

drop policy if exists client_referral_links_select_own on public.client_referral_links;
create policy client_referral_links_select_own
  on public.client_referral_links
  for select
  using (auth.uid() = user_id);

drop policy if exists client_referral_links_insert_own on public.client_referral_links;
create policy client_referral_links_insert_own
  on public.client_referral_links
  for insert
  with check (auth.uid() = user_id);

drop policy if exists client_referral_links_update_own on public.client_referral_links;
create policy client_referral_links_update_own
  on public.client_referral_links
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists referral_events_select_own on public.referral_events;
create policy referral_events_select_own
  on public.referral_events
  for select
  using (auth.uid() = user_id);

drop policy if exists referral_events_insert_own on public.referral_events;
create policy referral_events_insert_own
  on public.referral_events
  for insert
  with check (auth.uid() = user_id);

drop policy if exists thank_you_email_settings_select_own on public.thank_you_email_settings;
create policy thank_you_email_settings_select_own
  on public.thank_you_email_settings
  for select
  using (auth.uid() = user_id);

drop policy if exists thank_you_email_settings_insert_own on public.thank_you_email_settings;
create policy thank_you_email_settings_insert_own
  on public.thank_you_email_settings
  for insert
  with check (auth.uid() = user_id);

drop policy if exists thank_you_email_settings_update_own on public.thank_you_email_settings;
create policy thank_you_email_settings_update_own
  on public.thank_you_email_settings
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists thank_you_emails_select_own on public.thank_you_emails;
create policy thank_you_emails_select_own
  on public.thank_you_emails
  for select
  using (auth.uid() = user_id);

drop policy if exists thank_you_emails_insert_own on public.thank_you_emails;
create policy thank_you_emails_insert_own
  on public.thank_you_emails
  for insert
  with check (auth.uid() = user_id);

drop policy if exists thank_you_emails_update_own on public.thank_you_emails;
create policy thank_you_emails_update_own
  on public.thank_you_emails
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
