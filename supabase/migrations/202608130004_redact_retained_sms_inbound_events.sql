alter table public.sms_inbound_events
  alter column from_phone drop not null,
  alter column from_phone_normalized drop not null,
  alter column body drop not null,
  add column if not exists redacted_at timestamptz;

create index if not exists sms_inbound_events_retention_redaction_idx
  on public.sms_inbound_events(received_at)
  where redacted_at is null and status in ('processed', 'failed');
