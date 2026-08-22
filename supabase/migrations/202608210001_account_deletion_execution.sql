-- Turns the existing deletion request into a durable, retryable worker job.
alter table public.users
  add column if not exists deletion_status text not null default 'active',
  add column if not exists deletion_requested_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'users_deletion_status_check'
  ) then
    alter table public.users
      add constraint users_deletion_status_check
      check (deletion_status in ('active', 'pending', 'processing', 'failed'));
  end if;
end $$;

create index if not exists users_deletion_status_idx
  on public.users (deletion_status)
  where deletion_status <> 'active';

alter table public.account_deletion_requests
  add column if not exists current_step text,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists next_attempt_at timestamptz,
  add column if not exists lease_token uuid,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists last_error_code text,
  add column if not exists last_error_at timestamptz,
  add column if not exists deleted_account_hash text,
  add column if not exists completion_summary jsonb not null default '{}'::jsonb;

alter table public.account_deletion_audit_events
  add column if not exists deleted_account_hash text;

-- Cascade-owned records cannot survive an Auth deletion. Keep only the
-- non-identifying audit facts needed for support, delivery, and reporting.
create table if not exists public.account_deletion_retained_events (
  id uuid primary key default gen_random_uuid(),
  request_id uuid references public.account_deletion_requests(id) on delete set null,
  deleted_account_hash text not null,
  source_table text not null,
  source_id text not null,
  event_category text not null,
  event_type text not null,
  occurred_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint account_deletion_retained_events_source_unique
    unique (request_id, source_table, source_id),
  constraint account_deletion_retained_events_source_table_length_check
    check (char_length(trim(source_table)) between 1 and 100),
  constraint account_deletion_retained_events_category_length_check
    check (char_length(trim(event_category)) between 1 and 80),
  constraint account_deletion_retained_events_type_length_check
    check (char_length(trim(event_type)) between 1 and 120)
);

create index if not exists account_deletion_retained_events_hash_occurred_idx
  on public.account_deletion_retained_events (deleted_account_hash, occurred_at);

alter table public.account_deletion_retained_events enable row level security;
revoke all on table public.account_deletion_retained_events from anon, authenticated;
grant select, insert, update, delete on table public.account_deletion_retained_events to service_role;

create index if not exists account_deletion_requests_claimable_idx
  on public.account_deletion_requests (status, next_attempt_at, scheduled_deletion_at)
  where status in ('pending', 'processing', 'failed_retryable');

-- Request creation and its immediate safety actions must succeed or fail as a
-- unit. The account row lock also serializes duplicate client retries.
create or replace function public.request_account_deletion(
  p_user_id uuid,
  p_reason text,
  p_client_request_id text,
  p_created_ip_hash text,
  p_created_user_agent text,
  p_requested_at timestamptz,
  p_scheduled_deletion_at timestamptz,
  p_auth_source text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.account_deletion_requests%rowtype;
  v_duplicate boolean := false;
  v_now timestamptz := coalesce(p_requested_at, now());
begin
  perform 1 from public.users where id = p_user_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'account_not_found';
  end if;

  if exists (
    select 1 from public.admin_users where user_id = p_user_id and is_active = true
  ) then
    return jsonb_build_object('active_administrator', true);
  end if;

  select * into v_request
  from public.account_deletion_requests
  where user_id = p_user_id
    and status in ('pending', 'processing', 'failed_retryable')
  order by requested_at desc
  limit 1
  for update;

  if found then
    v_duplicate := true;
  else
    insert into public.account_deletion_requests (
      user_id, status, reason, client_request_id, requested_at,
      scheduled_deletion_at, created_ip_hash, created_user_agent
    ) values (
      p_user_id, 'pending', p_reason, p_client_request_id, v_now,
      p_scheduled_deletion_at, p_created_ip_hash, p_created_user_agent
    ) returning * into v_request;
  end if;

  update public.users
  set account_status = 'inactive',
      deactivated_at = case when v_duplicate then coalesce(deactivated_at, v_now) else v_now end,
      deletion_status = case when v_request.status = 'processing' then 'processing' else 'pending' end,
      deletion_requested_at = coalesce(deletion_requested_at, v_request.requested_at, v_now)
  where id = p_user_id;

  update public.stylists set booking_enabled = false where user_id = p_user_id;
  update public.rebook_nudges
    set status = 'cancelled', cancelled_at = v_now, cancelled_reason = 'account_deletion_requested'
    where user_id = p_user_id and status in ('pending_approval', 'queued', 'sending', 'failed');
  update public.birthday_reminders
    set status = 'cancelled', cancelled_at = v_now, cancelled_reason = 'account_deletion_requested'
    where user_id = p_user_id and status in ('queued', 'sending', 'failed');
  update public.appointment_email_events
    set status = 'skipped', error = 'account_deletion_requested'
    where user_id = p_user_id and status in ('queued', 'sending', 'failed');
  update public.sms_messages
    set status = 'cancelled', error_code = 'account_deletion_requested', error_message = 'Account deletion requested'
    where user_id = p_user_id and status in ('queued', 'sending', 'failed');
  update public.appointment_sms_confirmation_jobs
    set status = 'skipped', error_code = 'account_deletion_requested', error_message = 'Account deletion requested'
    where user_id = p_user_id and status in ('pending', 'queued');
  update public.thank_you_emails
    set status = 'cancelled', cancelled_at = v_now, cancelled_reason = 'account_deletion_requested'
    where user_id = p_user_id and status in ('pending_approval', 'queued', 'sending', 'failed');
  update public.campaigns
    set status = 'cancelled', cancelled_at = v_now, cancelled_reason = 'account_deletion_requested'
    where user_id = p_user_id and status in ('draft', 'scheduled');
  update public.campaign_runs
    set status = 'cancelled', cancelled_at = v_now
    where user_id = p_user_id and status in ('draft', 'scheduled', 'queued');
  update public.campaign_recipients
    set status = 'cancelled', cancelled_at = v_now, error_code = 'account_deletion_requested'
    where user_id = p_user_id and status in ('pending', 'queued', 'failed');

  insert into public.account_deletion_audit_events (request_id, user_id, event_type, metadata)
  values (
    v_request.id,
    p_user_id,
    case when v_duplicate then 'duplicate_request' else 'requested' end,
    jsonb_build_object('clientRequestId', p_client_request_id, 'authSource', p_auth_source)
  );

  return jsonb_build_object('request', to_jsonb(v_request), 'duplicate', v_duplicate);
end;
$$;

revoke all on function public.request_account_deletion(uuid, text, text, text, text, timestamptz, timestamptz, text) from public;
grant execute on function public.request_account_deletion(uuid, text, text, text, text, timestamptz, timestamptz, text) to service_role;

-- These production tables predate the checked-in migration history. Preserve
-- minimal operational evidence while eliminating direct account linkage.
alter table if exists public.api_request_logs
  add column if not exists deleted_account_hash text,
  add column if not exists anonymized_at timestamptz;
alter table if exists public.booking_error_events
  add column if not exists deleted_account_hash text,
  add column if not exists anonymized_at timestamptz;
alter table if exists public.notification_events
  add column if not exists deleted_account_hash text,
  add column if not exists anonymized_at timestamptz;
alter table if exists public.product_events
  add column if not exists deleted_account_hash text,
  add column if not exists anonymized_at timestamptz;
alter table if exists public.admin_account_notes
  add column if not exists deleted_account_hash text,
  add column if not exists anonymized_at timestamptz;

do $$
begin
  if to_regclass('public.api_request_logs') is not null then
    execute 'create index if not exists api_request_logs_deleted_account_hash_idx on public.api_request_logs (deleted_account_hash) where deleted_account_hash is not null';
  end if;
  if to_regclass('public.booking_error_events') is not null then
    execute 'create index if not exists booking_error_events_deleted_account_hash_idx on public.booking_error_events (deleted_account_hash) where deleted_account_hash is not null';
  end if;
  if to_regclass('public.notification_events') is not null then
    execute 'create index if not exists notification_events_deleted_account_hash_idx on public.notification_events (deleted_account_hash) where deleted_account_hash is not null';
  end if;
  if to_regclass('public.product_events') is not null then
    execute 'create index if not exists product_events_deleted_account_hash_idx on public.product_events (deleted_account_hash) where deleted_account_hash is not null';
  end if;
  if to_regclass('public.admin_account_notes') is not null then
    execute 'create index if not exists admin_account_notes_deleted_account_hash_idx on public.admin_account_notes (deleted_account_hash) where deleted_account_hash is not null';
  end if;
end $$;
