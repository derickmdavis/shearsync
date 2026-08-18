-- Scheduler failures happen before an SMS outbox row exists. Keep an auditable
-- per-occurrence record so a missed reminder is observable and actionable.
create table if not exists public.appointment_sms_reminder_failures (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references public.appointments(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  appointment_start_at timestamptz not null,
  error_code text not null check (char_length(error_code) between 1 and 120),
  error_message text not null check (char_length(error_message) between 1 and 2000),
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists appointment_sms_reminder_failures_occurred_idx
  on public.appointment_sms_reminder_failures(occurred_at desc);
create index if not exists appointment_sms_reminder_failures_appointment_idx
  on public.appointment_sms_reminder_failures(appointment_id, appointment_start_at, occurred_at desc);

alter table public.appointment_sms_reminder_failures enable row level security;
