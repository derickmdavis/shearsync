create extension if not exists pg_trgm;
create extension if not exists pgcrypto;

create table if not exists public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique not null,
  full_name text,
  phone_number text,
  business_name text,
  location_label text,
  avatar_image_id text,
  timezone text not null default 'America/Denver',
  plan_tier text not null default 'basic' check (plan_tier in ('basic', 'pro', 'premium')),
  plan_status text not null default 'active' check (plan_status in ('trialing', 'active', 'past_due', 'cancelled')),
  sms_monthly_limit integer not null default 0,
  sms_used_this_month integer not null default 0,
  plan_started_at timestamptz default now(),
  waitlist_enabled boolean not null default true,
  plan_updated_at timestamptz default now(),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  first_name text not null,
  last_name text,
  preferred_name text,
  phone text,
  phone_normalized text,
  email text,
  instagram text,
  birthday date,
  notes text,
  preferred_contact_method text check (preferred_contact_method in ('text', 'call', 'email', 'instagram')),
  tags text[],
  source text check (source in ('referral', 'instagram', 'walk-in', 'existing-client', 'other')),
  reminder_consent boolean,
  total_spend numeric(10, 2) not null default 0,
  last_visit_at timestamptz,
  deleted_at timestamptz,
  deleted_reason text,
  purge_after timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.plan_usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  event_type text not null,
  quantity integer not null default 1,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.account_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) on delete set null,
  status text not null default 'pending',
  reason text,
  client_request_id text,
  requested_at timestamptz not null default now(),
  scheduled_deletion_at timestamptz,
  processing_started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  failure_reason text,
  created_ip_hash text,
  created_user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint account_deletion_requests_status_check
    check (status in ('pending', 'processing', 'failed_retryable', 'completed', 'cancelled')),
  constraint account_deletion_requests_reason_length_check
    check (reason is null or char_length(reason) <= 1000),
  constraint account_deletion_requests_client_request_id_length_check
    check (client_request_id is null or char_length(client_request_id) <= 120)
);

create table if not exists public.account_deletion_audit_events (
  id uuid primary key default gen_random_uuid(),
  request_id uuid references public.account_deletion_requests(id) on delete set null,
  user_id uuid references public.users(id) on delete set null,
  event_type text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint account_deletion_audit_events_event_type_length_check
    check (char_length(trim(event_type)) between 1 and 80)
);

create table if not exists public.appointments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  appointment_date timestamptz not null,
  service_name text not null,
  duration_minutes integer not null,
  price numeric(10, 2) not null default 0,
  notes text,
  status text not null default 'scheduled',
  booking_source text not null default 'internal' check (booking_source in ('public', 'internal')),
  appointment_time_range tstzrange,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.photos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  file_path text not null,
  photo_type text,
  caption text,
  created_at timestamptz default now()
);

create table if not exists public.appointment_images (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  client_id uuid references public.clients(id) on delete set null,
  appointment_id uuid not null references public.appointments(id) on delete cascade,
  bucket text not null default 'appointment-images',
  storage_path text not null,
  thumbnail_path text,
  original_filename text,
  content_type text not null,
  file_size_bytes bigint not null,
  thumbnail_size_bytes bigint,
  width integer,
  height integer,
  thumbnail_width integer,
  thumbnail_height integer,
  image_role text not null default 'general',
  image_source text not null default 'stylist',
  captured_at timestamptz,
  label text,
  tags text[] not null default '{}',
  uploaded_by_user_id uuid references public.users(id) on delete set null,
  public_upload_token_id uuid,
  caption text,
  sort_order integer not null default 0,
  cache_version integer not null default 1,
  upload_status text not null default 'ready',
  upload_expires_at timestamptz,
  finalized_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint appointment_images_bucket_check
    check (bucket = 'appointment-images'),
  constraint appointment_images_content_type_check
    check (content_type in ('image/jpeg', 'image/png', 'image/webp')),
  constraint appointment_images_file_size_check
    check (file_size_bytes > 0 and file_size_bytes <= 2097152),
  constraint appointment_images_thumbnail_size_check
    check (thumbnail_size_bytes is null or (thumbnail_size_bytes > 0 and thumbnail_size_bytes <= 307200)),
  constraint appointment_images_width_check
    check (width is null or (width > 0 and width <= 1600)),
  constraint appointment_images_height_check
    check (height is null or (height > 0 and height <= 1600)),
  constraint appointment_images_thumbnail_width_check
    check (thumbnail_width is null or (thumbnail_width > 0 and thumbnail_width <= 400)),
  constraint appointment_images_thumbnail_height_check
    check (thumbnail_height is null or (thumbnail_height > 0 and thumbnail_height <= 400)),
  constraint appointment_images_ready_display_dimensions_check
    check (upload_status <> 'ready' or (width is not null and height is not null)),
  constraint appointment_images_ready_thumbnail_dimensions_check
    check (upload_status <> 'ready' or (thumbnail_width is not null and thumbnail_height is not null)),
  constraint appointment_images_role_check
    check (image_role in ('before', 'after', 'inspiration', 'reference', 'formula', 'progress', 'general')),
  constraint appointment_images_source_check
    check (image_source in ('stylist', 'client')),
  constraint appointment_images_upload_status_check
    check (upload_status in ('pending', 'ready', 'failed', 'expired')),
  constraint appointment_images_pending_expires_check
    check (upload_status <> 'pending' or upload_expires_at is not null),
  constraint appointment_images_ready_finalized_check
    check (upload_status <> 'ready' or finalized_at is not null),
  constraint appointment_images_upload_expires_after_created_check
    check (upload_expires_at is null or upload_expires_at > created_at),
  constraint appointment_images_label_length_check
    check (label is null or char_length(trim(label)) between 1 and 120),
  constraint appointment_images_caption_length_check
    check (caption is null or char_length(caption) <= 1000),
  constraint appointment_images_tags_count_check
    check (array_length(tags, 1) is null or array_length(tags, 1) <= 10),
  constraint appointment_images_sort_order_check
    check (sort_order >= 0),
  constraint appointment_images_cache_version_check
    check (cache_version >= 1),
  constraint appointment_images_storage_path_unique
    unique (bucket, storage_path)
);

create table if not exists public.reminders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  appointment_id uuid references public.appointments(id) on delete set null,
  title text not null,
  due_date timestamptz not null,
  status text not null default 'open',
  channel text,
  reminder_type text,
  sent_at timestamptz,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  check (status in ('open', 'done', 'dismissed', 'sent')),
  check (channel is null or channel in ('sms', 'email')),
  check (reminder_type is null or reminder_type in ('appointment_reminder', 'follow_up', 'general'))
);

create table if not exists public.activity_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  client_id uuid not null references public.clients(id),
  appointment_id uuid references public.appointments(id) on delete set null,
  activity_type text not null,
  title text not null,
  description text,
  occurred_at timestamptz not null default now(),
  metadata jsonb,
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  check (activity_type in ('booking_created', 'appointment_cancelled', 'appointment_rescheduled', 'reminder_sent', 'waitlist_joined'))
);

create table if not exists public.appointment_email_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  client_id uuid not null references public.clients(id),
  appointment_id uuid references public.appointments(id),
  rebook_nudge_id uuid,
  birthday_reminder_id uuid,
  email_type text not null,
  recipient_email text not null,
  status text not null default 'queued',
  idempotency_key text not null,
  provider text,
  provider_message_id text,
  template_data jsonb not null default '{}'::jsonb,
  error text,
  attempt_count integer not null default 0,
  last_attempt_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  check (email_type in ('appointment_scheduled', 'appointment_pending', 'appointment_confirmed', 'appointment_cancelled', 'appointment_rescheduled', 'appointment_reminder', 'rebooking_prompt', 'birthday_reminder')),
  check (status in ('queued', 'sending', 'sent', 'failed', 'skipped'))
);

create table if not exists public.appointment_email_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  email_type text not null,
  subject_template text,
  custom_message_block text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint appointment_email_templates_email_type_check
    check (email_type in ('appointment_scheduled', 'appointment_pending', 'appointment_confirmed')),
  constraint appointment_email_templates_subject_length_check
    check (subject_template is null or (char_length(trim(subject_template)) between 1 and 160)),
  constraint appointment_email_templates_custom_block_length_check
    check (custom_message_block is null or (char_length(trim(custom_message_block)) between 1 and 4000)),
  constraint appointment_email_templates_user_email_type_unique unique (user_id, email_type)
);

create table if not exists public.birthday_reminders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  email_event_id uuid references public.appointment_email_events(id) on delete set null,
  recipient_email text not null,
  birthday date not null,
  birthday_occurrence_date date not null,
  scheduled_send_at timestamptz not null,
  status text not null default 'queued',
  template_data jsonb not null default '{}'::jsonb,
  cancelled_at timestamptz,
  cancelled_reason text,
  sent_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint birthday_reminders_recipient_email_check
    check (char_length(trim(recipient_email)) > 0),
  constraint birthday_reminders_status_check
    check (status in ('queued', 'sending', 'sent', 'cancelled', 'skipped', 'failed'))
);

alter table public.appointment_email_events
  add constraint appointment_email_events_birthday_reminder_id_fkey
  foreign key (birthday_reminder_id)
  references public.birthday_reminders(id)
  on delete set null;

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
    check (status in ('pending_approval', 'queued', 'sending', 'sent', 'cancelled', 'skipped', 'failed', 'superseded')),
  constraint rebook_nudges_interval_check
    check (rebook_interval_days between 1 and 730),
  constraint rebook_nudges_subject_length_check
    check (subject_snapshot is null or char_length(subject_snapshot) <= 160),
  constraint rebook_nudges_message_length_check
    check (custom_message_block_snapshot is null or char_length(custom_message_block_snapshot) <= 4000)
);

alter table public.appointment_email_events
  add constraint appointment_email_events_rebook_nudge_id_fkey
  foreign key (rebook_nudge_id)
  references public.rebook_nudges(id)
  on delete set null;

create table if not exists public.client_communication_preferences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  client_id uuid references public.clients(id) on delete set null,
  email text,
  email_normalized text,
  phone text,
  phone_normalized text,
  email_transactional_enabled boolean not null default true,
  email_reminders_enabled boolean not null default true,
  email_marketing_enabled boolean not null default true,
  email_rebooking_enabled boolean not null default true,
  opted_out_all_email boolean not null default false,
  email_opted_out_at timestamptz,
  email_opt_out_source text,
  sms_transactional_enabled boolean not null default false,
  sms_reminders_enabled boolean not null default false,
  sms_marketing_enabled boolean not null default false,
  sms_rebooking_enabled boolean not null default false,
  opted_out_all_sms boolean not null default false,
  sms_opted_in_at timestamptz,
  sms_opt_in_source text,
  sms_opt_in_text text,
  sms_opted_out_at timestamptz,
  sms_opt_out_source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint client_communication_preferences_contact_check
    check (email_normalized is not null or phone_normalized is not null)
);

create table if not exists public.communication_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  client_id uuid references public.clients(id) on delete set null,
  channel text not null,
  message_type text,
  to_address text,
  to_normalized text,
  provider text,
  provider_message_id text,
  status text not null,
  error_code text,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint communication_events_channel_check
    check (channel in ('email', 'sms')),
  constraint communication_events_message_type_check
    check (
      message_type is null
      or message_type in (
        'appointment_confirmation',
        'appointment_reminder',
        'appointment_cancelled',
        'appointment_rescheduled',
        'waitlist_update',
        'rebooking_prompt',
        'birthday_reminder',
        'marketing',
        'business_recap'
      )
    ),
  constraint communication_events_status_check
    check (
      status in (
        'queued',
        'sent',
        'delivered',
        'failed',
        'skipped_opted_out',
        'skipped_missing_consent',
        'bounced',
        'complained',
        'unsubscribed',
        'inbound_stop',
        'inbound_start',
        'inbound_help'
      )
    )
);

create table if not exists public.communication_consent_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  client_id uuid references public.clients(id) on delete set null,
  channel text not null,
  contact_value text,
  contact_normalized text,
  event_type text not null,
  source text not null,
  message_type text,
  consent_text text,
  ip_address text,
  user_agent text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint communication_consent_events_channel_check
    check (channel in ('email', 'sms')),
  constraint communication_consent_events_event_type_check
    check (
      event_type in (
        'opted_in',
        'opted_out',
        'opted_back_in',
        'preference_updated',
        'inbound_stop',
        'inbound_start',
        'inbound_help',
        'unsubscribe_link_clicked',
        'admin_updated',
        'imported'
      )
    ),
  constraint communication_consent_events_source_check
    check (
      source in (
        'booking_page',
        'admin',
        'unsubscribe_link',
        'inbound_sms',
        'manual',
        'import',
        'client_portal',
        'system'
      )
    ),
  constraint communication_consent_events_message_type_check
    check (
      message_type is null
      or message_type in (
        'appointment_confirmation',
        'appointment_reminder',
        'appointment_cancelled',
        'appointment_rescheduled',
        'waitlist_update',
        'rebooking_prompt',
        'birthday_reminder',
        'marketing',
        'business_recap'
      )
    )
);

create table if not exists public.communication_preference_tokens (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null,
  user_id uuid not null references public.users(id) on delete cascade,
  client_id uuid references public.clients(id) on delete set null,
  channel text not null,
  contact_value text not null,
  contact_normalized text not null,
  message_type text,
  action text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  constraint communication_preference_tokens_channel_check
    check (channel in ('email', 'sms')),
  constraint communication_preference_tokens_message_type_check
    check (
      message_type is null
      or message_type in (
        'appointment_confirmation',
        'appointment_reminder',
        'appointment_cancelled',
        'appointment_rescheduled',
        'waitlist_update',
        'rebooking_prompt',
        'birthday_reminder',
        'marketing',
        'business_recap'
      )
    ),
  constraint communication_preference_tokens_action_check
    check (action in ('unsubscribe', 'manage_preferences', 'sms_opt_in', 'sms_opt_out'))
);

create table if not exists public.global_email_unsubscribes (
  id uuid primary key default gen_random_uuid(),
  email_normalized text not null,
  opted_out_at timestamptz not null default now(),
  opt_out_source text not null default 'unsubscribe_link',
  triggering_user_id uuid references public.users(id) on delete set null,
  triggering_client_id uuid references public.clients(id) on delete set null,
  triggering_stylist_id uuid references public.users(id) on delete set null,
  triggering_message_type text,
  preference_token_id uuid references public.communication_preference_tokens(id) on delete set null,
  ip_address text,
  user_agent text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint global_email_unsubscribes_email_unique unique (email_normalized),
  constraint global_email_unsubscribes_source_check
    check (opt_out_source in ('unsubscribe_link', 'admin', 'manual', 'import', 'system')),
  constraint global_email_unsubscribes_message_type_check
    check (
      triggering_message_type is null
      or triggering_message_type in (
        'appointment_confirmation',
        'appointment_reminder',
        'appointment_cancelled',
        'appointment_rescheduled',
        'waitlist_update',
        'rebooking_prompt',
        'birthday_reminder',
        'marketing',
        'business_recap'
      )
    )
);

create table if not exists public.automation_settings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  key text not null,
  enabled boolean not null default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint automation_settings_key_check
    check (key in ('rebook_nudges', 'appointment_reminders', 'email_confirmations', 'no_show_follow_up', 'waitlist_match', 'birthday_reminders')),
  constraint automation_settings_user_key_unique unique (user_id, key)
);

create table if not exists public.stylists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.users(id) on delete cascade,
  slug text unique not null,
  display_name text not null,
  bio text,
  cover_photo_url text,
  instagram text,
  booking_enabled boolean not null default true,
  intelligent_scheduling_enabled boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.booking_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.users(id) on delete cascade,
  lead_time_hours integer not null default 2,
  same_day_booking_allowed boolean not null default true,
  same_day_booking_cutoff time not null default '17:00:00',
  max_booking_window_days integer not null default 90,
  cancellation_window_hours integer not null default 24,
  late_cancellation_fee_enabled boolean not null default false,
  late_cancellation_fee_type text not null default 'flat' check (late_cancellation_fee_type in ('flat', 'percent')),
  late_cancellation_fee_value numeric(10, 2) not null default 0,
  allow_cancellation_after_cutoff boolean not null default false,
  reschedule_window_hours integer not null default 24,
  max_reschedules integer,
  same_day_rescheduling_allowed boolean not null default false,
  preserve_appointment_history boolean not null default true,
  new_client_approval_required boolean not null default false,
  new_client_booking_window_days integer not null default 30,
  restrict_services_for_new_clients boolean not null default false,
  restricted_service_ids uuid[] not null default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  check (lead_time_hours >= 0),
  check (max_booking_window_days > 0),
  check (lead_time_hours <= max_booking_window_days * 24),
  check (cancellation_window_hours >= 0),
  check (reschedule_window_hours >= 0),
  check (late_cancellation_fee_value >= 0),
  check (new_client_booking_window_days >= 0),
  check (max_reschedules is null or max_reschedules >= 0)
);

create table if not exists public.services (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  name text not null,
  description text,
  category text,
  duration_minutes integer not null,
  price numeric(10, 2) default 0,
  is_active boolean default true,
  is_default boolean not null default false,
  sort_order integer not null default 1,
  visible boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.availability (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  day_of_week integer not null check (day_of_week between 0 and 6),
  start_time time not null,
  end_time time not null,
  client_audience text not null default 'all' check (client_audience in ('all', 'new', 'returning')),
  is_active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.stylist_off_days (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  date date not null,
  label text,
  reason text,
  is_recurring boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint stylist_off_days_user_date_unique unique (user_id, date)
);

create table if not exists public.waitlist_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id uuid references public.clients(id) on delete set null,
  service_id uuid references public.services(id) on delete set null,
  requested_date date not null,
  requested_time_preference text,
  client_name text not null,
  client_email text,
  client_phone text,
  note text,
  status text not null default 'active',
  source text not null default 'public_booking',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint waitlist_entries_status_check
    check (status in ('active', 'contacted', 'booked', 'cancelled', 'expired')),
  constraint waitlist_entries_source_check
    check (source in ('public_booking', 'stylist_created', 'manual')),
  constraint waitlist_entries_contact_check
    check (
      nullif(trim(coalesce(client_email, '')), '') is not null
      or nullif(trim(coalesce(client_phone, '')), '') is not null
    )
);

create index if not exists clients_user_id_idx on public.clients(user_id);
create index if not exists clients_user_phone_normalized_idx on public.clients(user_id, phone_normalized);
create index if not exists clients_user_updated_at_idx on public.clients(user_id, updated_at desc, id);
create index if not exists clients_user_name_idx on public.clients(user_id, last_name, first_name, id);
create index if not exists clients_user_total_spend_idx on public.clients(user_id, total_spend desc, id);
create index if not exists clients_user_last_visit_at_idx on public.clients(user_id, last_visit_at desc, id);
create index if not exists clients_user_active_updated_at_idx
  on public.clients(user_id, updated_at desc, id)
  where deleted_at is null;
create index if not exists clients_purge_after_idx
  on public.clients(purge_after)
  where purge_after is not null;
create index if not exists clients_user_first_name_trgm_idx on public.clients using gin (first_name gin_trgm_ops);
create index if not exists clients_user_last_name_trgm_idx on public.clients using gin (last_name gin_trgm_ops);
create index if not exists clients_user_preferred_name_trgm_idx on public.clients using gin (preferred_name gin_trgm_ops);
create index if not exists clients_user_email_trgm_idx on public.clients using gin (email gin_trgm_ops);
create index if not exists clients_user_phone_trgm_idx on public.clients using gin (phone gin_trgm_ops);
create index if not exists clients_user_phone_normalized_trgm_idx on public.clients using gin (phone_normalized gin_trgm_ops);
create index if not exists clients_user_instagram_trgm_idx on public.clients using gin (instagram gin_trgm_ops);
create index if not exists clients_user_notes_trgm_idx on public.clients using gin (notes gin_trgm_ops);
create index if not exists clients_tags_gin_idx on public.clients using gin (tags);
create index if not exists appointments_user_id_date_idx on public.appointments(user_id, appointment_date);
create unique index if not exists appointments_user_id_appointment_date_active_idx
  on public.appointments(user_id, appointment_date)
  where status <> 'cancelled';
create index if not exists appointments_time_range_gist_idx
  on public.appointments using gist (appointment_time_range);
create index if not exists photos_user_id_client_id_idx on public.photos(user_id, client_id);
create unique index if not exists appointment_images_thumbnail_path_unique_idx
  on public.appointment_images(bucket, thumbnail_path)
  where thumbnail_path is not null;
create index if not exists appointment_images_appointment_id_idx
  on public.appointment_images(appointment_id);
create index if not exists appointment_images_client_id_idx
  on public.appointment_images(client_id);
create index if not exists appointment_images_user_id_idx
  on public.appointment_images(user_id);
create index if not exists appointment_images_user_appointment_sort_idx
  on public.appointment_images(user_id, appointment_id, sort_order, created_at desc);
create index if not exists appointment_images_user_client_idx
  on public.appointment_images(user_id, client_id);
create index if not exists appointment_images_user_created_idx
  on public.appointment_images(user_id, created_at desc);
create index if not exists appointment_images_user_status_expires_idx
  on public.appointment_images(user_id, upload_status, upload_expires_at);
create index if not exists reminders_user_id_due_date_idx on public.reminders(user_id, due_date);
create index if not exists reminders_user_id_sent_at_idx on public.reminders(user_id, sent_at);
create index if not exists booking_rules_user_id_idx on public.booking_rules(user_id);
create index if not exists services_user_id_active_idx on public.services(user_id, is_active);
create index if not exists services_user_id_sort_order_idx on public.services(user_id, sort_order);
alter table public.appointments
  add column if not exists service_id uuid references public.services(id) on delete set null;

create index if not exists appointments_service_id_idx on public.appointments(service_id);
create index if not exists availability_user_id_day_idx on public.availability(user_id, day_of_week);
create index if not exists availability_user_id_day_audience_idx on public.availability(user_id, day_of_week, client_audience);
create index if not exists stylist_off_days_user_id_idx on public.stylist_off_days(user_id);
create index if not exists stylist_off_days_user_date_idx on public.stylist_off_days(user_id, date);
create index if not exists waitlist_entries_user_id_idx on public.waitlist_entries(user_id);
create index if not exists waitlist_entries_user_date_idx on public.waitlist_entries(user_id, requested_date);
create index if not exists waitlist_entries_user_status_idx on public.waitlist_entries(user_id, status);
create index if not exists waitlist_entries_user_created_at_idx on public.waitlist_entries(user_id, created_at desc);
create index if not exists activity_events_user_occurred_at_idx on public.activity_events(user_id, occurred_at desc, id desc);
create index if not exists activity_events_appointment_id_idx on public.activity_events(appointment_id);
create index if not exists activity_events_client_id_idx on public.activity_events(client_id);
create index if not exists activity_events_activity_type_idx on public.activity_events(activity_type);
create unique index if not exists activity_events_user_dedupe_key_idx on public.activity_events(user_id, dedupe_key);
create unique index if not exists appointment_email_events_idempotency_key_idx
  on public.appointment_email_events(idempotency_key);
create index if not exists appointment_email_events_delivery_retry_idx
  on public.appointment_email_events(status, last_attempt_at, created_at);
create index if not exists appointment_email_events_user_status_idx
  on public.appointment_email_events(user_id, status, created_at);
create index if not exists appointment_email_events_appointment_id_idx
  on public.appointment_email_events(appointment_id);
create index if not exists appointment_email_events_rebook_nudge_id_idx
  on public.appointment_email_events(rebook_nudge_id);
create index if not exists appointment_email_events_birthday_reminder_id_idx
  on public.appointment_email_events(birthday_reminder_id);
create index if not exists appointment_email_templates_user_id_idx
  on public.appointment_email_templates(user_id);
create index if not exists birthday_reminders_user_status_send_at_idx
  on public.birthday_reminders(user_id, status, scheduled_send_at);
create index if not exists birthday_reminders_status_send_at_idx
  on public.birthday_reminders(status, scheduled_send_at);
create index if not exists birthday_reminders_client_id_idx
  on public.birthday_reminders(client_id);
create index if not exists birthday_reminders_email_event_id_idx
  on public.birthday_reminders(email_event_id);
create unique index if not exists birthday_reminders_active_client_year_idx
  on public.birthday_reminders(user_id, client_id, birthday_occurrence_date)
  where status in ('queued', 'sending', 'failed');
create index if not exists plan_usage_events_user_month_idx
  on public.plan_usage_events(user_id, created_at);
create unique index if not exists account_deletion_requests_user_active_idx
  on public.account_deletion_requests(user_id)
  where user_id is not null
    and status in ('pending', 'processing', 'failed_retryable');
create unique index if not exists account_deletion_requests_user_client_request_idx
  on public.account_deletion_requests(user_id, client_request_id)
  where user_id is not null
    and client_request_id is not null;
create index if not exists account_deletion_requests_status_scheduled_idx
  on public.account_deletion_requests(status, scheduled_deletion_at);
create index if not exists account_deletion_audit_events_request_idx
  on public.account_deletion_audit_events(request_id, created_at);
create index if not exists account_deletion_audit_events_user_idx
  on public.account_deletion_audit_events(user_id, created_at);
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
create unique index if not exists client_communication_preferences_user_email_idx
  on public.client_communication_preferences(user_id, email_normalized)
  where email_normalized is not null;
create unique index if not exists client_communication_preferences_user_phone_idx
  on public.client_communication_preferences(user_id, phone_normalized)
  where phone_normalized is not null;
create index if not exists client_communication_preferences_client_id_idx
  on public.client_communication_preferences(client_id);
create index if not exists communication_events_user_created_at_idx
  on public.communication_events(user_id, created_at desc);
create index if not exists communication_events_client_created_at_idx
  on public.communication_events(client_id, created_at desc);
create index if not exists communication_events_contact_idx
  on public.communication_events(channel, to_normalized, created_at desc);
create index if not exists communication_consent_events_user_created_at_idx
  on public.communication_consent_events(user_id, created_at desc);
create index if not exists communication_consent_events_contact_idx
  on public.communication_consent_events(channel, contact_normalized, created_at desc);
create unique index if not exists communication_preference_tokens_token_hash_idx
  on public.communication_preference_tokens(token_hash);
create index if not exists communication_preference_tokens_contact_idx
  on public.communication_preference_tokens(channel, contact_normalized, created_at desc);
create index if not exists communication_preference_tokens_expires_at_idx
  on public.communication_preference_tokens(expires_at);
create index if not exists global_email_unsubscribes_email_idx
  on public.global_email_unsubscribes(email_normalized);
create index if not exists global_email_unsubscribes_opted_out_at_idx
  on public.global_email_unsubscribes(opted_out_at desc);
create index if not exists automation_settings_user_id_idx on public.automation_settings(user_id);

alter table public.users enable row level security;
alter table public.clients enable row level security;
alter table public.appointments enable row level security;
alter table public.photos enable row level security;
alter table public.appointment_images enable row level security;
alter table public.reminders enable row level security;
alter table public.activity_events enable row level security;
alter table public.appointment_email_events enable row level security;
alter table public.appointment_email_templates enable row level security;
alter table public.birthday_reminders enable row level security;
alter table public.plan_usage_events enable row level security;
alter table public.account_deletion_requests enable row level security;
alter table public.account_deletion_audit_events enable row level security;
alter table public.rebook_nudge_settings enable row level security;
alter table public.rebook_nudges enable row level security;
alter table public.client_communication_preferences enable row level security;
alter table public.communication_events enable row level security;
alter table public.communication_consent_events enable row level security;
alter table public.communication_preference_tokens enable row level security;
alter table public.global_email_unsubscribes enable row level security;
alter table public.automation_settings enable row level security;
alter table public.stylists enable row level security;
alter table public.booking_rules enable row level security;
alter table public.services enable row level security;
alter table public.availability enable row level security;
alter table public.stylist_off_days enable row level security;
alter table public.waitlist_entries enable row level security;

create or replace function public.set_appointment_images_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_appointment_images_updated_at on public.appointment_images;
create trigger set_appointment_images_updated_at
  before update on public.appointment_images
  for each row
  execute function public.set_appointment_images_updated_at();

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'activity_events'
      and policyname = 'activity_events_select_own'
  ) then
    create policy activity_events_select_own
      on public.activity_events
      for select
      using (auth.uid() = user_id);
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'account_deletion_requests'
      and policyname = 'account_deletion_requests_select_own'
  ) then
    create policy account_deletion_requests_select_own
      on public.account_deletion_requests
      for select
      using (auth.uid() = user_id);
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'appointment_images'
      and policyname = 'appointment_images_select_own'
  ) then
    create policy appointment_images_select_own
      on public.appointment_images
      for select
      using (auth.uid() = user_id);
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'appointment_images'
      and policyname = 'appointment_images_insert_own'
  ) then
    create policy appointment_images_insert_own
      on public.appointment_images
      for insert
      with check (auth.uid() = user_id);
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'appointment_images'
      and policyname = 'appointment_images_update_own'
  ) then
    create policy appointment_images_update_own
      on public.appointment_images
      for update
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'appointment_images'
      and policyname = 'appointment_images_delete_own'
  ) then
    create policy appointment_images_delete_own
      on public.appointment_images
      for delete
      using (auth.uid() = user_id);
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'waitlist_entries'
      and policyname = 'waitlist_entries_select_own'
  ) then
    create policy waitlist_entries_select_own
      on public.waitlist_entries
      for select
      using (auth.uid() = user_id);
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'waitlist_entries'
      and policyname = 'waitlist_entries_insert_own'
  ) then
    create policy waitlist_entries_insert_own
      on public.waitlist_entries
      for insert
      with check (auth.uid() = user_id);
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'waitlist_entries'
      and policyname = 'waitlist_entries_update_own'
  ) then
    create policy waitlist_entries_update_own
      on public.waitlist_entries
      for update
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'waitlist_entries'
      and policyname = 'waitlist_entries_delete_own'
  ) then
    create policy waitlist_entries_delete_own
      on public.waitlist_entries
      for delete
      using (auth.uid() = user_id);
  end if;
end
$$;

create or replace view public.user_storage_usage
with (security_invoker = true)
as
select
  user_id,
  count(*) filter (where upload_status = 'ready') as appointment_image_count,
  coalesce(
    sum(file_size_bytes + coalesce(thumbnail_size_bytes, 0))
      filter (where upload_status = 'ready'),
    0
  )::bigint as appointment_image_bytes
from public.appointment_images
group by user_id;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'stylist_off_days'
      and policyname = 'stylist_off_days_select_own'
  ) then
    create policy stylist_off_days_select_own
      on public.stylist_off_days
      for select
      using (auth.uid() = user_id);
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'stylist_off_days'
      and policyname = 'stylist_off_days_insert_own'
  ) then
    create policy stylist_off_days_insert_own
      on public.stylist_off_days
      for insert
      with check (auth.uid() = user_id);
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'stylist_off_days'
      and policyname = 'stylist_off_days_update_own'
  ) then
    create policy stylist_off_days_update_own
      on public.stylist_off_days
      for update
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'stylist_off_days'
      and policyname = 'stylist_off_days_delete_own'
  ) then
    create policy stylist_off_days_delete_own
      on public.stylist_off_days
      for delete
      using (auth.uid() = user_id);
  end if;
end
$$;
