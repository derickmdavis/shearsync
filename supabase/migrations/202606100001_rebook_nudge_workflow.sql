create table if not exists public.rebook_nudge_settings (
  user_id uuid primary key references public.users(id) on delete cascade,
  approval_required boolean not null default true,
  default_rebook_interval_days integer not null default 90,
  subject_template text,
  custom_message_block text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint rebook_nudge_settings_interval_check
    check (default_rebook_interval_days between 1 and 730),
  constraint rebook_nudge_settings_subject_length_check
    check (subject_template is null or char_length(subject_template) <= 160),
  constraint rebook_nudge_settings_message_length_check
    check (custom_message_block is null or char_length(custom_message_block) <= 4000)
);

create table if not exists public.rebook_nudges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  last_appointment_id uuid references public.appointments(id) on delete set null,
  email_event_id uuid references public.appointment_email_events(id) on delete set null,
  recipient_email text not null,
  status text not null default 'queued',
  approval_required boolean not null default false,
  send_after timestamptz not null,
  rebook_interval_days integer not null,
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
  constraint rebook_nudges_status_check
    check (status in (
      'pending_approval',
      'queued',
      'sending',
      'sent',
      'cancelled',
      'skipped',
      'failed',
      'superseded'
    )),
  constraint rebook_nudges_interval_check
    check (rebook_interval_days between 1 and 730),
  constraint rebook_nudges_subject_length_check
    check (subject_snapshot is null or char_length(subject_snapshot) <= 160),
  constraint rebook_nudges_message_length_check
    check (custom_message_block_snapshot is null or char_length(custom_message_block_snapshot) <= 4000)
);

create index if not exists rebook_nudge_settings_user_id_idx
  on public.rebook_nudge_settings(user_id);

create index if not exists rebook_nudges_user_status_send_after_idx
  on public.rebook_nudges(user_id, status, send_after);

create index if not exists rebook_nudges_status_send_after_idx
  on public.rebook_nudges(status, send_after);

create index if not exists rebook_nudges_client_id_idx
  on public.rebook_nudges(client_id);

create index if not exists rebook_nudges_last_appointment_id_idx
  on public.rebook_nudges(last_appointment_id);

create unique index if not exists rebook_nudges_active_last_appointment_idx
  on public.rebook_nudges(user_id, client_id, last_appointment_id)
  where status in ('pending_approval', 'queued', 'sending', 'failed');

alter table public.appointment_email_events
  alter column appointment_id drop not null;

alter table public.appointment_email_events
  add column if not exists rebook_nudge_id uuid references public.rebook_nudges(id) on delete set null;

create index if not exists appointment_email_events_rebook_nudge_id_idx
  on public.appointment_email_events(rebook_nudge_id);

alter table public.appointment_email_events
  drop constraint if exists appointment_email_events_email_type_check;

alter table public.appointment_email_events
  add constraint appointment_email_events_email_type_check
  check (email_type in (
    'appointment_scheduled',
    'appointment_pending',
    'appointment_confirmed',
    'appointment_cancelled',
    'appointment_rescheduled',
    'rebooking_prompt'
  ));

alter table public.rebook_nudge_settings enable row level security;
alter table public.rebook_nudges enable row level security;

drop policy if exists rebook_nudge_settings_select_own on public.rebook_nudge_settings;
create policy rebook_nudge_settings_select_own
  on public.rebook_nudge_settings
  for select
  using (auth.uid() = user_id);

drop policy if exists rebook_nudge_settings_insert_own on public.rebook_nudge_settings;
create policy rebook_nudge_settings_insert_own
  on public.rebook_nudge_settings
  for insert
  with check (auth.uid() = user_id);

drop policy if exists rebook_nudge_settings_update_own on public.rebook_nudge_settings;
create policy rebook_nudge_settings_update_own
  on public.rebook_nudge_settings
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists rebook_nudges_select_own on public.rebook_nudges;
create policy rebook_nudges_select_own
  on public.rebook_nudges
  for select
  using (auth.uid() = user_id);

drop policy if exists rebook_nudges_insert_own on public.rebook_nudges;
create policy rebook_nudges_insert_own
  on public.rebook_nudges
  for insert
  with check (auth.uid() = user_id);

drop policy if exists rebook_nudges_update_own on public.rebook_nudges;
create policy rebook_nudges_update_own
  on public.rebook_nudges
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
