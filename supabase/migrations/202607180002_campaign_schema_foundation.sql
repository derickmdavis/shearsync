create extension if not exists pgcrypto;

create table public.campaign_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  link_type text not null,
  subject text not null,
  message text not null,
  version integer not null default 1,
  active boolean not null default true,
  sort_order integer not null default 0,
  icon_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint campaign_templates_name_length_check check (char_length(trim(name)) between 1 and 60),
  constraint campaign_templates_description_length_check check (description is null or char_length(description) <= 500),
  constraint campaign_templates_link_type_check check (link_type in ('booking_link', 'referral_link')),
  constraint campaign_templates_subject_length_check check (char_length(trim(subject)) between 1 and 100),
  constraint campaign_templates_message_length_check check (char_length(trim(message)) between 1 and 2000),
  constraint campaign_templates_version_check check (version > 0),
  constraint campaign_templates_sort_order_check check (sort_order >= 0),
  constraint campaign_templates_icon_key_length_check check (icon_key is null or char_length(icon_key) <= 80),
  constraint campaign_templates_id_version_unique unique (id, version)
);

create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  name text,
  status text not null default 'draft',
  campaign_kind text not null default 'one_time',
  send_mode text not null default 'now',
  scheduled_for timestamptz,
  timezone_snapshot text not null default 'UTC',
  link_type text,
  template_id uuid,
  template_version integer,
  subject_snapshot text,
  message_snapshot text,
  audience_mode text not null default 'everyone',
  revision integer not null default 1,
  validated_at timestamptz,
  validation_nonce_hash text,
  scheduled_at timestamptz,
  sending_started_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancelled_reason text,
  failure_summary jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint campaigns_id_user_unique unique (id, user_id),
  constraint campaigns_name_length_check check (name is null or char_length(trim(name)) between 1 and 60),
  constraint campaigns_status_check check (
    status in ('draft', 'scheduled', 'sending', 'completed', 'partially_failed', 'failed', 'cancelled')
  ),
  constraint campaigns_kind_check check (campaign_kind = 'one_time'),
  constraint campaigns_send_mode_check check (send_mode in ('now', 'scheduled')),
  constraint campaigns_timezone_length_check check (char_length(trim(timezone_snapshot)) between 1 and 64),
  constraint campaigns_link_type_check check (link_type is null or link_type in ('booking_link', 'referral_link')),
  constraint campaigns_template_pair_check check (
    (template_id is null and template_version is null)
    or (template_id is not null and template_version is not null and template_version > 0)
  ),
  constraint campaigns_template_fkey foreign key (template_id, template_version)
    references public.campaign_templates(id, version) on delete restrict,
  constraint campaigns_subject_length_check check (
    subject_snapshot is null or char_length(trim(subject_snapshot)) between 1 and 100
  ),
  constraint campaigns_message_length_check check (
    message_snapshot is null or char_length(trim(message_snapshot)) between 1 and 2000
  ),
  constraint campaigns_audience_mode_check check (audience_mode in ('everyone', 'specific')),
  constraint campaigns_revision_check check (revision > 0),
  constraint campaigns_validation_hash_length_check check (
    validation_nonce_hash is null or char_length(validation_nonce_hash) between 32 and 128
  ),
  constraint campaigns_cancelled_reason_length_check check (
    cancelled_reason is null or char_length(cancelled_reason) <= 1000
  ),
  constraint campaigns_schedule_mode_check check (
    send_mode = 'scheduled' or scheduled_for is null
  ),
  constraint campaigns_submitted_fields_check check (
    status in ('draft', 'cancelled')
    or (
      name is not null
      and link_type is not null
      and subject_snapshot is not null
      and message_snapshot is not null
      and (send_mode = 'now' or scheduled_for is not null)
    )
  ),
  constraint campaigns_lifecycle_timestamps_check check (
    (status <> 'scheduled' or scheduled_at is not null)
    and (status <> 'sending' or sending_started_at is not null)
    and (status not in ('completed', 'partially_failed', 'failed') or completed_at is not null)
    and (status <> 'cancelled' or cancelled_at is not null)
  )
);

create table public.campaign_runs (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null,
  user_id uuid not null,
  sequence_number integer not null,
  status text not null default 'draft',
  scheduled_for timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  recipient_total integer not null default 0,
  eligible_count integer not null default 0,
  excluded_count integer not null default 0,
  pending_count integer not null default 0,
  sending_count integer not null default 0,
  sent_count integer not null default 0,
  failed_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint campaign_runs_campaign_user_fkey foreign key (campaign_id, user_id)
    references public.campaigns(id, user_id) on delete cascade,
  constraint campaign_runs_id_campaign_user_unique unique (id, campaign_id, user_id),
  constraint campaign_runs_campaign_sequence_unique unique (campaign_id, sequence_number),
  constraint campaign_runs_sequence_check check (sequence_number > 0),
  constraint campaign_runs_status_check check (
    status in ('draft', 'scheduled', 'queued', 'sending', 'completed', 'partially_failed', 'failed', 'cancelled')
  ),
  constraint campaign_runs_counts_check check (
    recipient_total >= 0 and eligible_count >= 0 and excluded_count >= 0
    and pending_count >= 0 and sending_count >= 0 and sent_count >= 0 and failed_count >= 0
    and eligible_count + excluded_count <= recipient_total
    and pending_count <= recipient_total and sending_count <= recipient_total
    and sent_count <= recipient_total and failed_count <= recipient_total
  ),
  constraint campaign_runs_lifecycle_timestamps_check check (
    (status <> 'sending' or started_at is not null)
    and (status not in ('completed', 'partially_failed', 'failed') or completed_at is not null)
    and (status <> 'cancelled' or cancelled_at is not null)
  )
);

create unique index clients_id_user_id_unique on public.clients(id, user_id);
create unique index client_referral_links_id_user_id_unique on public.client_referral_links(id, user_id);

create table public.campaign_audience_selections (
  campaign_id uuid not null,
  user_id uuid not null,
  client_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (campaign_id, client_id),
  constraint campaign_audience_selections_campaign_user_fkey foreign key (campaign_id, user_id)
    references public.campaigns(id, user_id) on delete cascade,
  constraint campaign_audience_selections_client_user_fkey foreign key (client_id, user_id)
    references public.clients(id, user_id) on delete cascade
);

create table public.campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null,
  campaign_run_id uuid not null,
  user_id uuid not null,
  client_id uuid,
  recipient_email_snapshot text,
  first_name_snapshot text,
  eligibility_status text not null,
  exclusion_reason text,
  subject_snapshot text,
  rendered_text_snapshot text,
  rendered_html_snapshot text,
  render_version integer not null default 1,
  booking_tracking_token_hash text,
  referral_link_id uuid,
  status text not null default 'pending',
  idempotency_key text not null,
  provider text,
  provider_message_id text,
  attempt_count integer not null default 0,
  last_attempt_at timestamptz,
  queued_at timestamptz,
  sending_started_at timestamptz,
  sent_at timestamptz,
  delivered_at timestamptz,
  failed_at timestamptz,
  skipped_at timestamptz,
  cancelled_at timestamptz,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint campaign_recipients_run_campaign_user_fkey foreign key (campaign_run_id, campaign_id, user_id)
    references public.campaign_runs(id, campaign_id, user_id) on delete cascade,
  constraint campaign_recipients_client_user_fkey foreign key (client_id, user_id)
    references public.clients(id, user_id) on delete set null (client_id),
  constraint campaign_recipients_referral_link_user_fkey foreign key (referral_link_id, user_id)
    references public.client_referral_links(id, user_id) on delete set null (referral_link_id),
  constraint campaign_recipients_run_idempotency_unique unique (campaign_run_id, idempotency_key),
  constraint campaign_recipients_email_length_check check (
    recipient_email_snapshot is null or char_length(trim(recipient_email_snapshot)) between 3 and 320
  ),
  constraint campaign_recipients_first_name_length_check check (
    first_name_snapshot is null or char_length(first_name_snapshot) <= 100
  ),
  constraint campaign_recipients_eligibility_check check (eligibility_status in ('eligible', 'excluded')),
  constraint campaign_recipients_exclusion_reason_check check (
    (eligibility_status = 'eligible' and exclusion_reason is null)
    or (
      eligibility_status = 'excluded'
      and exclusion_reason in (
        'missing_email', 'invalid_email', 'email_marketing_disabled', 'globally_unsubscribed',
        'client_deleted', 'duplicate_recipient', 'not_owned_or_not_found'
      )
    )
  ),
  constraint campaign_recipients_eligible_email_check check (
    eligibility_status = 'excluded' or recipient_email_snapshot is not null
  ),
  constraint campaign_recipients_subject_length_check check (
    subject_snapshot is null or char_length(trim(subject_snapshot)) between 1 and 100
  ),
  constraint campaign_recipients_rendered_text_length_check check (
    rendered_text_snapshot is null or char_length(rendered_text_snapshot) <= 20000
  ),
  constraint campaign_recipients_rendered_html_length_check check (
    rendered_html_snapshot is null or char_length(rendered_html_snapshot) <= 100000
  ),
  constraint campaign_recipients_render_version_check check (render_version > 0),
  constraint campaign_recipients_tracking_hash_length_check check (
    booking_tracking_token_hash is null or char_length(booking_tracking_token_hash) between 32 and 128
  ),
  constraint campaign_recipients_status_check check (
    status in ('pending', 'queued', 'sending', 'sent', 'delivered', 'failed', 'skipped', 'cancelled')
  ),
  constraint campaign_recipients_excluded_status_check check (
    eligibility_status = 'eligible' or status in ('skipped', 'cancelled')
  ),
  constraint campaign_recipients_idempotency_length_check check (
    char_length(trim(idempotency_key)) between 1 and 200
  ),
  constraint campaign_recipients_attempt_count_check check (attempt_count >= 0),
  constraint campaign_recipients_provider_length_check check (provider is null or char_length(provider) <= 80),
  constraint campaign_recipients_provider_message_length_check check (
    provider_message_id is null or char_length(provider_message_id) <= 255
  ),
  constraint campaign_recipients_error_length_check check (
    (error_code is null or char_length(error_code) <= 120)
    and (error_message is null or char_length(error_message) <= 2000)
  )
);

create unique index campaign_recipients_run_client_unique
  on public.campaign_recipients(campaign_run_id, client_id) where client_id is not null;
create unique index campaign_recipients_run_email_unique
  on public.campaign_recipients(campaign_run_id, lower(recipient_email_snapshot))
  where recipient_email_snapshot is not null and eligibility_status = 'eligible';

create table public.campaign_idempotency_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  scope text not null,
  idempotency_key text not null,
  request_hash text not null,
  response_status integer,
  response_body jsonb,
  resource_type text,
  resource_id uuid,
  locked_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint campaign_idempotency_user_scope_key_unique unique (user_id, scope, idempotency_key),
  constraint campaign_idempotency_scope_length_check check (char_length(trim(scope)) between 1 and 80),
  constraint campaign_idempotency_key_length_check check (char_length(trim(idempotency_key)) between 1 and 200),
  constraint campaign_idempotency_request_hash_check check (char_length(request_hash) between 32 and 128),
  constraint campaign_idempotency_response_status_check check (
    response_status is null or response_status between 100 and 599
  ),
  constraint campaign_idempotency_resource_type_length_check check (
    resource_type is null or char_length(resource_type) <= 80
  ),
  constraint campaign_idempotency_expiry_check check (expires_at > created_at),
  constraint campaign_idempotency_completion_check check (
    (completed_at is null and response_status is null and response_body is null)
    or (completed_at is not null and response_status is not null)
  )
);

create index campaign_templates_active_sort_idx
  on public.campaign_templates(active, sort_order, created_at, id);
create index campaigns_user_status_relevance_idx
  on public.campaigns(user_id, status, scheduled_for, updated_at desc, id);
create index campaigns_user_created_idx on public.campaigns(user_id, created_at desc, id);
create index campaign_runs_due_idx
  on public.campaign_runs(scheduled_for, id) where status in ('scheduled', 'queued');
create index campaign_runs_user_status_idx
  on public.campaign_runs(user_id, status, scheduled_for, id);
create index campaign_audience_selections_campaign_idx
  on public.campaign_audience_selections(campaign_id, created_at, client_id);
create index campaign_audience_selections_user_client_idx
  on public.campaign_audience_selections(user_id, client_id);
create index campaign_recipients_run_status_idx
  on public.campaign_recipients(campaign_run_id, status, id);
create index campaign_recipients_user_status_idx
  on public.campaign_recipients(user_id, status, updated_at, id);
create index campaign_recipients_provider_message_idx
  on public.campaign_recipients(provider, provider_message_id)
  where provider_message_id is not null;
create index campaign_recipients_campaign_idx on public.campaign_recipients(campaign_id, id);
create index campaign_recipients_client_idx on public.campaign_recipients(user_id, client_id);
create index campaign_idempotency_expiry_idx on public.campaign_idempotency_records(expires_at);

create or replace function public.set_campaign_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.validate_campaign_status_transition()
returns trigger language plpgsql as $$
begin
  if new.status = old.status then return new; end if;
  if not (
    (old.status = 'draft' and new.status in ('scheduled', 'sending', 'cancelled'))
    or (old.status = 'scheduled' and new.status in ('sending', 'cancelled'))
    or (old.status = 'sending' and new.status in ('completed', 'partially_failed', 'failed'))
  ) then
    raise exception using errcode = '23514', message = 'invalid_campaign_status_transition';
  end if;
  return new;
end;
$$;

create or replace function public.validate_campaign_run_status_transition()
returns trigger language plpgsql as $$
begin
  if new.status = old.status then return new; end if;
  if not (
    (old.status = 'draft' and new.status in ('scheduled', 'queued', 'sending', 'cancelled'))
    or (old.status = 'scheduled' and new.status in ('queued', 'sending', 'cancelled'))
    or (old.status = 'queued' and new.status in ('sending', 'cancelled'))
    or (old.status = 'sending' and new.status in ('completed', 'partially_failed', 'failed'))
  ) then
    raise exception using errcode = '23514', message = 'invalid_campaign_run_status_transition';
  end if;
  return new;
end;
$$;

create or replace function public.validate_campaign_recipient_status_transition()
returns trigger language plpgsql as $$
begin
  if new.status = old.status then return new; end if;
  if not (
    (old.status = 'pending' and new.status in ('queued', 'skipped', 'cancelled'))
    or (old.status = 'queued' and new.status in ('sending', 'skipped', 'cancelled'))
    or (old.status = 'sending' and new.status in ('sent', 'failed'))
    or (old.status = 'sent' and new.status in ('delivered', 'failed'))
    or (old.status = 'failed' and new.status in ('queued', 'skipped', 'cancelled'))
  ) then
    raise exception using errcode = '23514', message = 'invalid_campaign_recipient_status_transition';
  end if;
  return new;
end;
$$;

create or replace function public.create_initial_campaign_run()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.campaign_runs (campaign_id, user_id, sequence_number, status, scheduled_for)
  values (new.id, new.user_id, 1, new.status, new.scheduled_for);
  return new;
end;
$$;

create or replace function public.sync_initial_campaign_run()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.campaign_runs
  set
    status = new.status,
    scheduled_for = new.scheduled_for,
    started_at = case when new.status = 'sending' then new.sending_started_at else started_at end,
    completed_at = case when new.status in ('completed', 'partially_failed', 'failed') then new.completed_at else completed_at end,
    cancelled_at = case when new.status = 'cancelled' then new.cancelled_at else cancelled_at end
  where campaign_id = new.id and user_id = new.user_id and sequence_number = 1;
  return new;
end;
$$;

create or replace function public.ensure_initial_campaign_run_exists()
returns trigger language plpgsql as $$
declare
  checked_campaign_id uuid;
begin
  checked_campaign_id = case when tg_op = 'DELETE' then old.campaign_id else new.campaign_id end;

  if exists (select 1 from public.campaigns where id = checked_campaign_id)
    and not exists (
      select 1 from public.campaign_runs where campaign_id = checked_campaign_id and sequence_number = 1
    ) then
    raise exception using errcode = '23514', message = 'campaign_initial_run_required';
  end if;

  if tg_op = 'UPDATE' and old.campaign_id <> new.campaign_id
    and exists (select 1 from public.campaigns where id = old.campaign_id)
    and not exists (
      select 1 from public.campaign_runs where campaign_id = old.campaign_id and sequence_number = 1
    ) then
    raise exception using errcode = '23514', message = 'campaign_initial_run_required';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger campaign_templates_set_updated_at before update on public.campaign_templates
  for each row execute function public.set_campaign_updated_at();
create trigger campaigns_validate_status before update of status on public.campaigns
  for each row execute function public.validate_campaign_status_transition();
create trigger campaigns_set_updated_at before update on public.campaigns
  for each row execute function public.set_campaign_updated_at();
create trigger campaign_runs_validate_status before update of status on public.campaign_runs
  for each row execute function public.validate_campaign_run_status_transition();
create trigger campaign_runs_set_updated_at before update on public.campaign_runs
  for each row execute function public.set_campaign_updated_at();
create trigger campaign_recipients_validate_status before update of status on public.campaign_recipients
  for each row execute function public.validate_campaign_recipient_status_transition();
create trigger campaign_recipients_set_updated_at before update on public.campaign_recipients
  for each row execute function public.set_campaign_updated_at();
create trigger campaign_idempotency_set_updated_at before update on public.campaign_idempotency_records
  for each row execute function public.set_campaign_updated_at();
create trigger campaigns_create_initial_run after insert on public.campaigns
  for each row execute function public.create_initial_campaign_run();
create trigger campaigns_sync_initial_run after update of status, scheduled_for on public.campaigns
  for each row execute function public.sync_initial_campaign_run();
create constraint trigger campaign_runs_require_initial
  after insert or update or delete on public.campaign_runs
  deferrable initially deferred
  for each row execute function public.ensure_initial_campaign_run_exists();

alter table public.campaign_templates enable row level security;
alter table public.campaigns enable row level security;
alter table public.campaign_runs enable row level security;
alter table public.campaign_audience_selections enable row level security;
alter table public.campaign_recipients enable row level security;
alter table public.campaign_idempotency_records enable row level security;

create policy campaign_templates_select_authenticated on public.campaign_templates
  for select to authenticated using (active = true);
create policy campaigns_select_own on public.campaigns for select using (auth.uid() = user_id);
create policy campaigns_insert_own on public.campaigns for insert with check (auth.uid() = user_id);
create policy campaigns_update_own on public.campaigns for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy campaigns_delete_own on public.campaigns for delete using (auth.uid() = user_id);
create policy campaign_runs_select_own on public.campaign_runs for select using (auth.uid() = user_id);
create policy campaign_runs_insert_own on public.campaign_runs for insert with check (auth.uid() = user_id);
create policy campaign_runs_update_own on public.campaign_runs for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy campaign_runs_delete_own on public.campaign_runs for delete using (auth.uid() = user_id);
create policy campaign_audience_selections_select_own on public.campaign_audience_selections
  for select using (auth.uid() = user_id);
create policy campaign_audience_selections_insert_own on public.campaign_audience_selections
  for insert with check (auth.uid() = user_id);
create policy campaign_audience_selections_delete_own on public.campaign_audience_selections
  for delete using (auth.uid() = user_id);
create policy campaign_recipients_select_own on public.campaign_recipients
  for select using (auth.uid() = user_id);
create policy campaign_recipients_insert_own on public.campaign_recipients
  for insert with check (auth.uid() = user_id);
create policy campaign_recipients_update_own on public.campaign_recipients for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy campaign_idempotency_select_own on public.campaign_idempotency_records
  for select using (auth.uid() = user_id);
create policy campaign_idempotency_insert_own on public.campaign_idempotency_records
  for insert with check (auth.uid() = user_id);
create policy campaign_idempotency_update_own on public.campaign_idempotency_records for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

comment on table public.campaign_templates is 'Product-managed one-time outreach campaign templates.';
comment on table public.campaign_runs is 'Delivery occurrences; sequence 1 is created atomically with every campaign.';
comment on table public.campaign_audience_selections is 'Editable specific-audience draft selections, not final recipient snapshots.';
comment on table public.campaign_recipients is 'Immutable recipient and rendered-content snapshots for a campaign run.';
comment on table public.campaign_idempotency_records is 'Reusable request idempotency records for campaign mutations.';
