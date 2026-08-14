alter table public.sms_inbound_events
  add column if not exists status text not null default 'processing'
    check (status in ('processing', 'processed', 'failed')),
  add column if not exists attempt_count integer not null default 1 check (attempt_count >= 1),
  add column if not exists lease_token uuid,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists processed_at timestamptz,
  add column if not exists failed_at timestamptz,
  add column if not exists error_code text;

create index if not exists sms_inbound_events_processing_lease_idx
  on public.sms_inbound_events(status, lease_expires_at)
  where status = 'processing';

alter table public.communication_events
  add column if not exists sms_inbound_event_id uuid references public.sms_inbound_events(id) on delete set null;
alter table public.communication_consent_events
  add column if not exists sms_inbound_event_id uuid references public.sms_inbound_events(id) on delete set null;

create unique index if not exists communication_events_sms_inbound_event_user_status_unique
  on public.communication_events(sms_inbound_event_id, user_id, status)
  where sms_inbound_event_id is not null;
create unique index if not exists communication_consent_events_sms_inbound_event_user_type_unique
  on public.communication_consent_events(sms_inbound_event_id, user_id, event_type)
  where sms_inbound_event_id is not null;

alter table public.sms_messages
  drop constraint if exists sms_messages_status_check;
alter table public.sms_messages
  add constraint sms_messages_status_check check (status in (
    'queued', 'sending', 'sent', 'delivered', 'failed', 'unknown', 'skipped', 'cancelled'
  ));
alter table public.sms_messages
  add column if not exists unknown_at timestamptz;
