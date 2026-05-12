alter table public.appointment_email_events
  add column if not exists attempt_count integer not null default 0,
  add column if not exists last_attempt_at timestamptz;

create index if not exists appointment_email_events_delivery_retry_idx
  on public.appointment_email_events(status, last_attempt_at, created_at);
