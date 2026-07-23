create extension if not exists pg_trgm;
create extension if not exists pgcrypto;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'payment_provider') then
    create type public.payment_provider as enum (
      'venmo',
      'paypal',
      'square',
      'cash_app',
      'zelle',
      'apple_pay',
      'google_pay',
      'cash',
      'other'
    );
  end if;
end
$$;

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'payment-method-qrs',
  'payment-method-qrs',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set
  name = excluded.name,
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

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
  birthday text,
  notes text,
  preferred_contact_method text check (preferred_contact_method in ('text', 'call', 'email', 'instagram')),
  tags text[],
  source text check (source in ('referral', 'instagram', 'walk-in', 'existing-client', 'other')),
  reminder_consent boolean,
  is_vip boolean not null default false,
  avatar_image_id uuid,
  total_spend numeric(10, 2) not null default 0,
  last_visit_at timestamptz,
  deleted_at timestamptz,
  deleted_reason text,
  purge_after timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint clients_birthday_dd_mm_check
    check (
      birthday is null
      or (
        birthday ~ '^\d{2}/\d{2}$'
        and substring(birthday from 1 for 2)::int between 1 and 31
        and substring(birthday from 4 for 2)::int between 1 and 12
        and substring(birthday from 1 for 2)::int <= extract(
          day from (
            date_trunc(
              'month',
              make_date(2024, substring(birthday from 4 for 2)::int, 1)
            )
            + interval '1 month - 1 day'
          )
        )
      )
    )
);

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

create table if not exists public.referral_programs (
  user_id uuid primary key references public.users(id) on delete cascade,
  enabled boolean not null default false,
  offer_name text,
  offer_description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint referral_programs_offer_name_length_check
    check (offer_name is null or char_length(trim(offer_name)) between 1 and 120),
  constraint referral_programs_offer_description_length_check
    check (offer_description is null or char_length(trim(offer_description)) between 1 and 500)
);

alter table public.clients
  add column if not exists original_referral_link_id uuid references public.client_referral_links(id) on delete set null,
  add column if not exists original_referred_by_client_id uuid references public.clients(id) on delete set null,
  add column if not exists original_referral_code text,
  add column if not exists original_acquisition_source text,
  add column if not exists original_referral_attributed_at timestamptz;

create table if not exists public.plan_usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  event_type text not null,
  quantity integer not null default 1,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.payment_methods (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  provider public.payment_provider not null,
  display_name text not null,
  payment_url text,
  qr_image_url text,
  qr_image_path text,
  instructions text,
  is_default boolean not null default false,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_methods_display_name_length_check
    check (char_length(trim(display_name)) between 1 and 80),
  constraint payment_methods_payment_url_length_check
    check (payment_url is null or char_length(payment_url) <= 2048),
  constraint payment_methods_qr_image_url_length_check
    check (qr_image_url is null or char_length(qr_image_url) <= 2048),
  constraint payment_methods_qr_image_path_length_check
    check (qr_image_path is null or char_length(qr_image_path) <= 500),
  constraint payment_methods_qr_image_path_owner_check
    check (
      qr_image_path is null
      or (
        qr_image_path ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|jpg|webp)$'
        and split_part(qr_image_path, '/', 1) = user_id::text
      )
    ),
  constraint payment_methods_instructions_length_check
    check (instructions is null or char_length(instructions) <= 500),
  constraint payment_methods_sort_order_check
    check (sort_order >= 0),
  constraint payment_methods_external_target_check
    check (
      provider in ('cash', 'other')
      or payment_url is not null
      or qr_image_url is not null
      or qr_image_path is not null
    )
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
  referral_link_id uuid references public.client_referral_links(id) on delete set null,
  referred_by_client_id uuid references public.clients(id) on delete set null,
  referral_code_used text,
  referral_attributed_at timestamptz,
  acquisition_source text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

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
  check (activity_type in ('booking_created', 'appointment_cancelled', 'appointment_rescheduled', 'reminder_sent', 'waitlist_joined', 'client_rebook_needed'))
);

create table if not exists public.appointment_email_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  client_id uuid not null references public.clients(id),
  appointment_id uuid references public.appointments(id),
  rebook_nudge_id uuid,
  birthday_reminder_id uuid,
  thank_you_email_id uuid,
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
  check (email_type in ('appointment_scheduled', 'appointment_pending', 'appointment_confirmed', 'appointment_cancelled', 'appointment_rescheduled', 'appointment_reminder', 'rebooking_prompt', 'birthday_reminder', 'thank_you_email')),
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
    check (email_type in ('appointment_scheduled', 'appointment_pending', 'appointment_confirmed', 'appointment_cancelled', 'appointment_rescheduled', 'appointment_reminder', 'rebooking_prompt', 'birthday_reminder', 'thank_you_email')),
  constraint appointment_email_templates_subject_length_check
    check (subject_template is null or (char_length(trim(subject_template)) between 1 and 160)),
  constraint appointment_email_templates_custom_block_length_check
    check (custom_message_block is null or (char_length(trim(custom_message_block)) between 1 and 4000)),
  constraint appointment_email_templates_user_email_type_unique unique (user_id, email_type)
);

create table if not exists public.appointment_reminder_suppressions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  appointment_id uuid not null references public.appointments(id) on delete cascade,
  appointment_start_at timestamptz not null,
  reason text,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint appointment_reminder_suppressions_reason_length_check
    check (reason is null or char_length(reason) <= 500),
  constraint appointment_reminder_suppressions_occurrence_unique
    unique (user_id, appointment_id, appointment_start_at)
);

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

alter table public.appointment_email_events
  add constraint appointment_email_events_thank_you_email_id_fkey
  foreign key (thank_you_email_id)
  references public.thank_you_emails(id)
  on delete set null;

create table if not exists public.birthday_reminders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  email_event_id uuid references public.appointment_email_events(id) on delete set null,
  recipient_email text not null,
  birthday text not null,
  birthday_occurrence_date date not null,
  scheduled_send_at timestamptz not null,
  status text not null default 'queued',
  subject_snapshot text,
  custom_message_block_snapshot text,
  template_data jsonb not null default '{}'::jsonb,
  cancelled_at timestamptz,
  cancelled_reason text,
  sent_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint birthday_reminders_recipient_email_check
    check (char_length(trim(recipient_email)) > 0),
  constraint birthday_reminders_birthday_dd_mm_check
    check (
      birthday ~ '^\d{2}/\d{2}$'
      and substring(birthday from 1 for 2)::int between 1 and 31
      and substring(birthday from 4 for 2)::int between 1 and 12
      and substring(birthday from 1 for 2)::int <= extract(
        day from (
          date_trunc(
            'month',
            make_date(2024, substring(birthday from 4 for 2)::int, 1)
          )
          + interval '1 month - 1 day'
        )
      )
    ),
  constraint birthday_reminders_subject_length_check
    check (subject_snapshot is null or char_length(subject_snapshot) <= 160),
  constraint birthday_reminders_message_length_check
    check (custom_message_block_snapshot is null or char_length(custom_message_block_snapshot) <= 4000),
  constraint birthday_reminders_status_check
    check (status in ('pending_approval', 'queued', 'sending', 'sent', 'cancelled', 'skipped', 'failed'))
);

alter table public.appointment_email_events
  add constraint appointment_email_events_birthday_reminder_id_fkey
  foreign key (birthday_reminder_id)
  references public.birthday_reminders(id)
  on delete set null;

create table if not exists public.birthday_reminder_settings (
  user_id uuid primary key references public.users(id) on delete cascade,
  approval_required boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

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

create table if not exists public.client_rebooking_preferences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  preferred_interval_days integer not null,
  source text not null default 'manual',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint client_rebooking_preferences_interval_check
    check (preferred_interval_days between 1 and 730),
  constraint client_rebooking_preferences_source_check
    check (source in ('manual')),
  constraint client_rebooking_preferences_user_client_unique
    unique (user_id, client_id)
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
    check (key in ('rebook_nudges', 'appointment_reminders', 'email_confirmations', 'no_show_follow_up', 'waitlist_match', 'birthday_reminders', 'thank_you_emails')),
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

create table if not exists public.appointment_action_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  stylist_id uuid references public.stylists(id) on delete set null,
  appointment_id uuid not null references public.appointments(id) on delete cascade,
  client_id uuid references public.clients(id) on delete set null,
  short_code text not null unique,
  purpose text not null default 'manage_appointment',
  allowed_actions text[] not null default array['cancel', 'reschedule']::text[],
  expires_at timestamptz not null,
  used_at timestamptz,
  revoked_at timestamptz,
  last_accessed_at timestamptz,
  access_count integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint appointment_action_links_purpose_check
    check (purpose in ('manage_appointment')),
  constraint appointment_action_links_access_count_check
    check (access_count >= 0)
);

create index if not exists clients_user_id_idx on public.clients(user_id);
create index if not exists clients_user_phone_normalized_idx on public.clients(user_id, phone_normalized);
create index if not exists clients_user_updated_at_idx on public.clients(user_id, updated_at desc, id);
create index if not exists clients_user_name_idx on public.clients(user_id, last_name, first_name, id);
create index if not exists clients_user_total_spend_idx on public.clients(user_id, total_spend desc, id);
create index if not exists clients_user_last_visit_at_idx on public.clients(user_id, last_visit_at desc, id);
create index if not exists clients_user_is_vip_idx on public.clients(user_id, is_vip, id);
create index if not exists clients_avatar_image_id_idx on public.clients(avatar_image_id);
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
create unique index if not exists payment_methods_user_default_active_idx
  on public.payment_methods(user_id)
  where is_default = true and is_active = true;
create index if not exists payment_methods_user_active_sort_idx
  on public.payment_methods(user_id, is_active, is_default desc, sort_order, created_at);
create index if not exists payment_methods_user_provider_idx
  on public.payment_methods(user_id, provider);
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

create unique index if not exists client_referral_links_user_client_active_unique
  on public.client_referral_links(user_id, client_id)
  where status = 'active';
create index if not exists client_referral_links_user_id_idx
  on public.client_referral_links(user_id);
create index if not exists client_referral_links_client_id_idx
  on public.client_referral_links(client_id);
create index if not exists client_referral_links_referral_code_idx
  on public.client_referral_links(referral_code);
create index if not exists referral_programs_enabled_idx
  on public.referral_programs(user_id)
  where enabled = true;
create index if not exists clients_original_referral_link_id_idx
  on public.clients(original_referral_link_id);
create index if not exists clients_original_referred_by_client_id_idx
  on public.clients(original_referred_by_client_id);
create index if not exists clients_original_referral_attributed_at_idx
  on public.clients(original_referral_attributed_at);
create index if not exists appointments_referral_link_id_idx
  on public.appointments(referral_link_id);
create index if not exists appointments_referred_by_client_id_idx
  on public.appointments(referred_by_client_id);
create index if not exists appointments_referral_attributed_at_idx
  on public.appointments(referral_attributed_at);
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

alter table if exists public.thank_you_emails
  add column if not exists referral_link_id uuid references public.client_referral_links(id) on delete set null,
  add column if not exists referral_code_snapshot text,
  add column if not exists referral_url_snapshot text,
  add column if not exists qr_code_url_snapshot text;

do $$
begin
  if to_regclass('public.thank_you_emails') is not null then
    execute 'create index if not exists thank_you_emails_referral_link_id_idx on public.thank_you_emails(referral_link_id)';
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'clients_avatar_image_id_fkey'
  ) then
    alter table public.clients
      add constraint clients_avatar_image_id_fkey
      foreign key (avatar_image_id)
      references public.appointment_images(id)
      on delete set null;
  end if;
end $$;
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
create unique index if not exists appointment_action_links_short_code_idx
  on public.appointment_action_links(short_code);
create index if not exists appointment_action_links_appointment_id_idx
  on public.appointment_action_links(appointment_id);
create index if not exists appointment_action_links_user_id_idx
  on public.appointment_action_links(user_id);
create index if not exists appointment_action_links_expires_at_idx
  on public.appointment_action_links(expires_at);
create index if not exists appointment_action_links_active_idx
  on public.appointment_action_links(appointment_id, purpose, expires_at)
  where revoked_at is null;
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
create index if not exists appointment_email_events_thank_you_email_id_idx
  on public.appointment_email_events(thank_you_email_id);
create index if not exists appointment_email_templates_user_id_idx
  on public.appointment_email_templates(user_id);
create index if not exists appointment_reminder_suppressions_user_start_idx
  on public.appointment_reminder_suppressions(user_id, appointment_start_at);
create index if not exists appointment_reminder_suppressions_appointment_idx
  on public.appointment_reminder_suppressions(appointment_id);
create index if not exists thank_you_email_settings_user_id_idx
  on public.thank_you_email_settings(user_id);
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
create unique index if not exists thank_you_emails_active_appointment_idx
  on public.thank_you_emails(user_id, appointment_id)
  where status in ('pending_approval', 'queued', 'sending', 'failed', 'sent');
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
  where status in ('pending_approval', 'queued', 'sending', 'failed');
create index if not exists birthday_reminder_settings_user_id_idx
  on public.birthday_reminder_settings(user_id);
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
create index if not exists client_rebooking_preferences_user_id_idx
  on public.client_rebooking_preferences(user_id);
create index if not exists client_rebooking_preferences_client_id_idx
  on public.client_rebooking_preferences(client_id);
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
alter table public.client_referral_links enable row level security;
alter table public.referral_programs enable row level security;
alter table public.appointments enable row level security;
alter table public.referral_events enable row level security;
alter table public.photos enable row level security;
alter table public.appointment_images enable row level security;
alter table public.payment_methods enable row level security;
alter table public.reminders enable row level security;
alter table public.activity_events enable row level security;
alter table public.appointment_email_events enable row level security;
alter table public.appointment_email_templates enable row level security;
alter table public.appointment_reminder_suppressions enable row level security;
alter table public.thank_you_email_settings enable row level security;
alter table public.thank_you_emails enable row level security;
alter table public.birthday_reminders enable row level security;
alter table public.birthday_reminder_settings enable row level security;
alter table public.plan_usage_events enable row level security;
alter table public.account_deletion_requests enable row level security;
alter table public.account_deletion_audit_events enable row level security;
alter table public.rebook_nudge_settings enable row level security;
alter table public.rebook_nudges enable row level security;
alter table public.client_rebooking_preferences enable row level security;
alter table public.client_communication_preferences enable row level security;
alter table public.communication_events enable row level security;
alter table public.communication_consent_events enable row level security;
alter table public.communication_preference_tokens enable row level security;
alter table public.global_email_unsubscribes enable row level security;
alter table public.automation_settings enable row level security;

drop policy if exists appointment_reminder_suppressions_select_own
  on public.appointment_reminder_suppressions;
create policy appointment_reminder_suppressions_select_own
  on public.appointment_reminder_suppressions
  for select
  using (auth.uid() = user_id);

drop policy if exists appointment_reminder_suppressions_insert_own
  on public.appointment_reminder_suppressions;
create policy appointment_reminder_suppressions_insert_own
  on public.appointment_reminder_suppressions
  for insert
  with check (auth.uid() = user_id and auth.uid() = created_by);
alter table public.stylists enable row level security;
alter table public.booking_rules enable row level security;
alter table public.services enable row level security;
alter table public.availability enable row level security;
alter table public.stylist_off_days enable row level security;
alter table public.waitlist_entries enable row level security;
alter table public.appointment_action_links enable row level security;

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

drop policy if exists referral_programs_select_own on public.referral_programs;
create policy referral_programs_select_own
  on public.referral_programs
  for select
  using (auth.uid() = user_id);

drop policy if exists referral_programs_insert_own on public.referral_programs;
create policy referral_programs_insert_own
  on public.referral_programs
  for insert
  with check (auth.uid() = user_id);

drop policy if exists referral_programs_update_own on public.referral_programs;
create policy referral_programs_update_own
  on public.referral_programs
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

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'birthday_reminder_settings'
      and policyname = 'birthday_reminder_settings_select_own'
  ) then
    create policy birthday_reminder_settings_select_own
      on public.birthday_reminder_settings
      for select
      using (auth.uid() = user_id);
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'birthday_reminder_settings'
      and policyname = 'birthday_reminder_settings_insert_own'
  ) then
    create policy birthday_reminder_settings_insert_own
      on public.birthday_reminder_settings
      for insert
      with check (auth.uid() = user_id);
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'birthday_reminder_settings'
      and policyname = 'birthday_reminder_settings_update_own'
  ) then
    create policy birthday_reminder_settings_update_own
      on public.birthday_reminder_settings
      for update
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'client_rebooking_preferences'
      and policyname = 'client_rebooking_preferences_select_own'
  ) then
    create policy client_rebooking_preferences_select_own
      on public.client_rebooking_preferences
      for select
      using (auth.uid() = user_id);
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'client_rebooking_preferences'
      and policyname = 'client_rebooking_preferences_insert_own'
  ) then
    create policy client_rebooking_preferences_insert_own
      on public.client_rebooking_preferences
      for insert
      with check (auth.uid() = user_id);
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'client_rebooking_preferences'
      and policyname = 'client_rebooking_preferences_update_own'
  ) then
    create policy client_rebooking_preferences_update_own
      on public.client_rebooking_preferences
      for update
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'client_rebooking_preferences'
      and policyname = 'client_rebooking_preferences_delete_own'
  ) then
    create policy client_rebooking_preferences_delete_own
      on public.client_rebooking_preferences
      for delete
      using (auth.uid() = user_id);
  end if;
end
$$;

create or replace function public.cancel_appointment_reminder_occurrence(
  p_user_id uuid,
  p_appointment_id uuid,
  p_appointment_start_at timestamptz,
  p_reason text default null
)
returns jsonb
language plpgsql
as $$
declare
  v_appointment public.appointments%rowtype;
  v_event public.appointment_email_events%rowtype;
  v_suppression public.appointment_reminder_suppressions%rowtype;
begin
  select * into v_appointment
  from public.appointments
  where id = p_appointment_id
    and user_id = p_user_id
    and appointment_date = p_appointment_start_at
    and status in ('pending', 'scheduled')
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'appointment_reminder_occurrence_not_found';
  end if;

  select * into v_event
  from public.appointment_email_events
  where user_id = p_user_id
    and appointment_id = p_appointment_id
    and email_type = 'appointment_reminder'
    and (template_data->>'appointment_start_time')::timestamptz = p_appointment_start_at
  for update;

  if found and v_event.status = 'sending' then
    raise exception using errcode = 'P0001', message = 'appointment_reminder_already_sending';
  end if;

  if found and v_event.status = 'sent' then
    raise exception using errcode = 'P0001', message = 'appointment_reminder_already_sent';
  end if;

  insert into public.appointment_reminder_suppressions (
    user_id, appointment_id, appointment_start_at, reason, created_by
  ) values (
    p_user_id, p_appointment_id, p_appointment_start_at, nullif(trim(p_reason), ''), p_user_id
  )
  on conflict (user_id, appointment_id, appointment_start_at)
  do update set reason = coalesce(excluded.reason, public.appointment_reminder_suppressions.reason)
  returning * into v_suppression;

  update public.appointment_email_events
  set status = 'skipped', error = 'Appointment reminder cancelled by stylist', updated_at = now()
  where user_id = p_user_id
    and appointment_id = p_appointment_id
    and email_type = 'appointment_reminder'
    and (template_data->>'appointment_start_time')::timestamptz = p_appointment_start_at
    and status in ('queued', 'failed');

  return jsonb_build_object(
    'id', v_suppression.id,
    'appointment_id', v_suppression.appointment_id,
    'appointment_start_at', v_suppression.appointment_start_at,
    'status', 'cancelled',
    'reason', v_suppression.reason,
    'created_at', v_suppression.created_at
  );
end;
$$;

create or replace function public.set_client_rebooking_preferences_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_client_rebooking_preferences_updated_at on public.client_rebooking_preferences;
create trigger set_client_rebooking_preferences_updated_at
  before update on public.client_rebooking_preferences
  for each row
  execute function public.set_client_rebooking_preferences_updated_at();

create or replace function public.set_birthday_reminder_settings_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_birthday_reminder_settings_updated_at on public.birthday_reminder_settings;
create trigger set_birthday_reminder_settings_updated_at
  before update on public.birthday_reminder_settings
  for each row
  execute function public.set_birthday_reminder_settings_updated_at();

create or replace function public.set_referral_programs_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_referral_programs_updated_at on public.referral_programs;
create trigger set_referral_programs_updated_at
  before update on public.referral_programs
  for each row
  execute function public.set_referral_programs_updated_at();

create or replace function public.upsert_birthday_reminder_settings_with_approval_mode(
  p_user_id uuid,
  p_approval_required boolean
)
returns jsonb
language plpgsql
as $$
declare
  v_settings jsonb;
begin
  with upserted as (
    insert into public.birthday_reminder_settings (
      user_id,
      approval_required
    )
    values (
      p_user_id,
      p_approval_required
    )
    on conflict (user_id)
    do update set
      approval_required = excluded.approval_required,
      updated_at = now()
    returning *
  )
  select to_jsonb(upserted) into v_settings
  from upserted;

  if p_approval_required then
    update public.birthday_reminders
    set
      status = 'pending_approval',
      error = null,
      updated_at = now()
    where user_id = p_user_id
      and status = 'queued'
      and scheduled_send_at >= now();
  else
    update public.birthday_reminders
    set
      status = 'queued',
      error = null,
      updated_at = now()
    where user_id = p_user_id
      and status = 'pending_approval';
  end if;

  return v_settings;
end;
$$;

create or replace function public.upsert_rebook_nudge_settings_with_approval_mode(
  p_user_id uuid,
  p_approval_required boolean,
  p_has_default_rebook_interval_days boolean default false,
  p_default_rebook_interval_days integer default null,
  p_has_subject_template boolean default false,
  p_subject_template text default null,
  p_has_custom_message_block boolean default false,
  p_custom_message_block text default null
)
returns jsonb
language plpgsql
as $$
declare
  v_settings jsonb;
begin
  with upserted as (
    insert into public.rebook_nudge_settings (
      user_id,
      approval_required,
      default_rebook_interval_days,
      subject_template,
      custom_message_block
    )
    values (
      p_user_id,
      p_approval_required,
      case when p_has_default_rebook_interval_days then p_default_rebook_interval_days else 90 end,
      case when p_has_subject_template then p_subject_template else null end,
      case when p_has_custom_message_block then p_custom_message_block else null end
    )
    on conflict (user_id)
    do update set
      approval_required = excluded.approval_required,
      default_rebook_interval_days = case
        when p_has_default_rebook_interval_days then p_default_rebook_interval_days
        else public.rebook_nudge_settings.default_rebook_interval_days
      end,
      subject_template = case
        when p_has_subject_template then p_subject_template
        else public.rebook_nudge_settings.subject_template
      end,
      custom_message_block = case
        when p_has_custom_message_block then p_custom_message_block
        else public.rebook_nudge_settings.custom_message_block
      end,
      updated_at = now()
    returning *
  )
  select to_jsonb(upserted) into v_settings
  from upserted;

  if p_approval_required then
    update public.rebook_nudges
    set
      status = 'pending_approval',
      approval_required = true,
      error = null,
      updated_at = now()
    where user_id = p_user_id
      and status = 'queued'
      and approval_required = false;
  else
    update public.rebook_nudges
    set
      status = 'queued',
      approval_required = false,
      approved_at = now(),
      approved_by = p_user_id,
      error = null,
      updated_at = now()
    where user_id = p_user_id
      and status = 'pending_approval';
  end if;

  return v_settings;
end;
$$;

create or replace function public.upsert_thank_you_email_settings_with_approval_mode(
  p_user_id uuid,
  p_approval_required boolean,
  p_has_send_delay_hours boolean default false,
  p_send_delay_hours integer default null,
  p_has_subject_template boolean default false,
  p_subject_template text default null,
  p_has_custom_message_block boolean default false,
  p_custom_message_block text default null
)
returns jsonb
language plpgsql
as $$
declare
  v_settings jsonb;
begin
  with upserted as (
    insert into public.thank_you_email_settings (
      user_id,
      approval_required,
      send_delay_hours,
      subject_template,
      custom_message_block
    )
    values (
      p_user_id,
      p_approval_required,
      case when p_has_send_delay_hours then p_send_delay_hours else 0 end,
      case when p_has_subject_template then p_subject_template else null end,
      case when p_has_custom_message_block then p_custom_message_block else null end
    )
    on conflict (user_id)
    do update set
      approval_required = excluded.approval_required,
      send_delay_hours = case
        when p_has_send_delay_hours then p_send_delay_hours
        else public.thank_you_email_settings.send_delay_hours
      end,
      subject_template = case
        when p_has_subject_template then p_subject_template
        else public.thank_you_email_settings.subject_template
      end,
      custom_message_block = case
        when p_has_custom_message_block then p_custom_message_block
        else public.thank_you_email_settings.custom_message_block
      end,
      updated_at = now()
    returning *
  )
  select to_jsonb(upserted) into v_settings
  from upserted;

  if p_approval_required then
    update public.thank_you_emails
    set
      status = 'pending_approval',
      approval_required = true,
      error = null,
      updated_at = now()
    where user_id = p_user_id
      and status = 'queued'
      and approval_required = false;
  else
    update public.thank_you_emails
    set
      status = 'queued',
      approval_required = false,
      approved_at = now(),
      approved_by = p_user_id,
      error = null,
      updated_at = now()
    where user_id = p_user_id
      and status = 'pending_approval';
  end if;

  return v_settings;
end;
$$;

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

create or replace function public.set_external_payment_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_payment_methods_updated_at on public.payment_methods;
create trigger set_payment_methods_updated_at
  before update on public.payment_methods
  for each row
  execute function public.set_external_payment_updated_at();

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
      and tablename = 'payment_methods'
      and policyname = 'payment_methods_select_own'
  ) then
    create policy payment_methods_select_own
      on public.payment_methods
      for select
      using (auth.uid() = user_id);
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'payment_methods'
      and policyname = 'payment_methods_insert_own'
  ) then
    create policy payment_methods_insert_own
      on public.payment_methods
      for insert
      with check (auth.uid() = user_id);
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'payment_methods'
      and policyname = 'payment_methods_update_own'
  ) then
    create policy payment_methods_update_own
      on public.payment_methods
      for update
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'appointment_action_links'
      and policyname = 'appointment_action_links_select_own'
  ) then
    create policy appointment_action_links_select_own
      on public.appointment_action_links
      for select
      using (auth.uid() = user_id);
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'appointment_action_links'
      and policyname = 'appointment_action_links_insert_own'
  ) then
    create policy appointment_action_links_insert_own
      on public.appointment_action_links
      for insert
      with check (auth.uid() = user_id);
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'appointment_action_links'
      and policyname = 'appointment_action_links_update_own'
  ) then
    create policy appointment_action_links_update_own
      on public.appointment_action_links
      for update
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
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

-- Campaign schema foundation (2026-07-18).
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

-- Campaign templates and immediate drafts (2026-07-18).
insert into public.campaign_templates (
  id, name, description, link_type, subject, message, version, active, sort_order, icon_key
)
values
  (
    '10000000-0000-4000-8000-000000000001',
    'Booking Boost',
    'Invite clients to book their next appointment.',
    'booking_link',
    'Ready for your next appointment?',
    E'Hi {{first_name}},\n\nI would love to see you again. Choose a time that works for you below.',
    1, true, 10, 'calendar'
  ),
  (
    '10000000-0000-4000-8000-000000000002',
    'Seasonal Special',
    'Share a timely service or seasonal promotion.',
    'booking_link',
    'A seasonal update, just for you',
    E'Hi {{first_name}},\n\nI have something special available for a limited time. Book your next visit below.',
    1, true, 20, 'sun'
  ),
  (
    '10000000-0000-4000-8000-000000000003',
    'Share With a Friend',
    'Invite existing clients to share their personal referral link.',
    'referral_link',
    'Know someone who would love this?',
    E'Hi {{first_name}},\n\nIf someone comes to mind, you can share your personal referral link below.',
    1, true, 30, 'users'
  )
on conflict (id) do nothing;

create or replace function public.create_campaign_draft(
  p_user_id uuid,
  p_timezone text,
  p_template_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_template public.campaign_templates%rowtype;
  v_campaign public.campaigns%rowtype;
begin
  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception using errcode = '42501', message = 'campaign_owner_mismatch';
  end if;

  if not exists (select 1 from public.users where id = p_user_id) then
    raise exception using errcode = 'P0002', message = 'campaign_owner_not_found';
  end if;

  if p_template_id is not null then
    select * into v_template
    from public.campaign_templates
    where id = p_template_id and active = true;

    if not found then
      raise exception using errcode = 'P0002', message = 'campaign_template_not_found';
    end if;
  end if;

  insert into public.campaigns (
    user_id,
    status,
    campaign_kind,
    send_mode,
    timezone_snapshot,
    link_type,
    template_id,
    template_version,
    subject_snapshot,
    message_snapshot,
    audience_mode
  ) values (
    p_user_id,
    'draft',
    'one_time',
    'now',
    p_timezone,
    v_template.link_type,
    v_template.id,
    v_template.version,
    v_template.subject,
    v_template.message,
    'everyone'
  )
  returning * into v_campaign;

  return to_jsonb(v_campaign);
end;
$$;

create or replace function public.update_campaign_draft(
  p_user_id uuid,
  p_campaign_id uuid,
  p_expected_revision integer,
  p_has_name boolean default false,
  p_name text default null,
  p_has_send_mode boolean default false,
  p_send_mode text default null,
  p_has_scheduled_for boolean default false,
  p_scheduled_for timestamptz default null,
  p_has_timezone boolean default false,
  p_timezone text default null,
  p_has_link_type boolean default false,
  p_link_type text default null,
  p_has_template boolean default false,
  p_template_id uuid default null,
  p_has_subject boolean default false,
  p_subject text default null,
  p_has_message boolean default false,
  p_message text default null,
  p_has_audience boolean default false,
  p_audience_mode text default null,
  p_client_ids uuid[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campaign public.campaigns%rowtype;
  v_template public.campaign_templates%rowtype;
  v_client_ids uuid[];
  v_owned_count integer;
  v_effective_send_mode text;
begin
  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception using errcode = '42501', message = 'campaign_owner_mismatch';
  end if;

  select * into v_campaign
  from public.campaigns
  where id = p_campaign_id and user_id = p_user_id
  for update;

  if not found or v_campaign.status <> 'draft' then
    raise exception using errcode = 'P0002', message = 'campaign_draft_not_found';
  end if;

  if v_campaign.revision <> p_expected_revision then
    raise exception using
      errcode = 'P0001',
      message = 'campaign_revision_conflict',
      detail = jsonb_build_object('current_revision', v_campaign.revision)::text;
  end if;

  if p_has_template and p_template_id is not null then
    select * into v_template
    from public.campaign_templates
    where id = p_template_id and active = true;

    if not found then
      raise exception using errcode = 'P0002', message = 'campaign_template_not_found';
    end if;
  end if;

  v_effective_send_mode = case when p_has_send_mode then p_send_mode else v_campaign.send_mode end;
  if v_effective_send_mode = 'now' and p_has_scheduled_for and p_scheduled_for is not null then
    raise exception using errcode = '23514', message = 'campaign_send_time_not_allowed';
  end if;

  if p_has_audience then
    v_client_ids = coalesce(p_client_ids, array[]::uuid[]);

    if p_audience_mode not in ('everyone', 'specific') then
      raise exception using errcode = '23514', message = 'campaign_audience_mode_invalid';
    end if;
    if p_audience_mode = 'everyone' and cardinality(v_client_ids) > 0 then
      raise exception using errcode = '23514', message = 'campaign_everyone_client_ids_not_allowed';
    end if;
    if cardinality(v_client_ids) <> cardinality(array(select distinct unnest(v_client_ids))) then
      raise exception using errcode = '23505', message = 'campaign_audience_duplicate_client';
    end if;

    select count(*) into v_owned_count
    from public.clients
    where user_id = p_user_id and id = any(v_client_ids);

    if v_owned_count <> cardinality(v_client_ids) then
      raise exception using errcode = '42501', message = 'campaign_audience_client_not_owned';
    end if;
  end if;

  update public.campaigns
  set
    name = case when p_has_name then nullif(trim(p_name), '') else name end,
    send_mode = case when p_has_send_mode then p_send_mode else send_mode end,
    scheduled_for = case
      when p_has_send_mode and p_send_mode = 'now' then null
      when p_has_scheduled_for then p_scheduled_for
      else scheduled_for
    end,
    timezone_snapshot = case when p_has_timezone then p_timezone else timezone_snapshot end,
    link_type = case
      when p_has_link_type then p_link_type
      when p_has_template and p_template_id is not null then v_template.link_type
      else link_type
    end,
    template_id = case when p_has_template then p_template_id else template_id end,
    template_version = case
      when p_has_template and p_template_id is not null then v_template.version
      when p_has_template then null
      else template_version
    end,
    subject_snapshot = case
      when p_has_subject then nullif(trim(p_subject), '')
      when p_has_template and p_template_id is not null then v_template.subject
      else subject_snapshot
    end,
    message_snapshot = case
      when p_has_message then nullif(trim(p_message), '')
      when p_has_template and p_template_id is not null then v_template.message
      else message_snapshot
    end,
    audience_mode = case when p_has_audience then p_audience_mode else audience_mode end,
    revision = revision + 1,
    validated_at = null,
    validation_nonce_hash = null
  where id = p_campaign_id and user_id = p_user_id
  returning * into v_campaign;

  if p_has_audience then
    delete from public.campaign_audience_selections
    where campaign_id = p_campaign_id and user_id = p_user_id;

    if p_audience_mode = 'specific' then
      insert into public.campaign_audience_selections (campaign_id, user_id, client_id)
      select p_campaign_id, p_user_id, client_id
      from unnest(v_client_ids) as client_id;
    end if;
  end if;

  return to_jsonb(v_campaign);
end;
$$;

revoke all on function public.create_campaign_draft(uuid, text, uuid) from public;
revoke all on function public.update_campaign_draft(
  uuid, uuid, integer, boolean, text, boolean, text, boolean, timestamptz,
  boolean, text, boolean, text, boolean, uuid, boolean, text, boolean, text,
  boolean, text, uuid[]
) from public;
grant execute on function public.create_campaign_draft(uuid, text, uuid) to authenticated, service_role;
grant execute on function public.update_campaign_draft(
  uuid, uuid, integer, boolean, text, boolean, text, boolean, timestamptz,
  boolean, text, boolean, text, boolean, uuid, boolean, text, boolean, text,
  boolean, text, uuid[]
) to authenticated, service_role;

-- Migration 202607180004_outreach_corrective_pass.sql
update public.campaign_templates
set message = case id
  when '10000000-0000-4000-8000-000000000001'::uuid then
    E'Hi {{first_name}},\n\nI would love to see you again. Choose a time that works for you below.'
  when '10000000-0000-4000-8000-000000000002'::uuid then
    E'Hi {{first_name}},\n\nI have something special available for a limited time. Book your next visit below.'
  when '10000000-0000-4000-8000-000000000003'::uuid then
    E'Hi {{first_name}},\n\nIf someone comes to mind, you can share your personal referral link below.'
  else message
end
where id in (
  '10000000-0000-4000-8000-000000000001'::uuid,
  '10000000-0000-4000-8000-000000000002'::uuid,
  '10000000-0000-4000-8000-000000000003'::uuid
);

create table if not exists public.outreach_schema_versions (
  component text primary key,
  version text not null,
  applied_at timestamptz not null default now(),
  constraint outreach_schema_versions_component_not_blank check (btrim(component) <> ''),
  constraint outreach_schema_versions_version_not_blank check (btrim(version) <> '')
);

alter table public.outreach_schema_versions enable row level security;

insert into public.outreach_schema_versions (component, version, applied_at)
values ('campaign_authoring', 'outreach_corrective_pass_2026_07_18', now())
on conflict (component) do update
set version = excluded.version,
    applied_at = excluded.applied_at;

revoke all on table public.outreach_schema_versions from anon, authenticated;
grant select on table public.outreach_schema_versions to service_role;

-- Migration 202607180005_campaign_submission_and_cancellation.sql
create or replace function public.sync_initial_campaign_run()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.campaign_runs set
    status = new.status,
    scheduled_for = case when new.send_mode = 'now' and new.status = 'scheduled'
      then coalesce(campaign_runs.scheduled_for, new.scheduled_at, now()) else new.scheduled_for end,
    started_at = case when new.status = 'sending' then new.sending_started_at else started_at end,
    completed_at = case when new.status in ('completed', 'partially_failed', 'failed') then new.completed_at else completed_at end,
    cancelled_at = case when new.status = 'cancelled' then new.cancelled_at else cancelled_at end
  where campaign_id = new.id and user_id = new.user_id and sequence_number = 1;
  return new;
end;
$$;

create or replace function public.submit_campaign(
  p_user_id uuid, p_campaign_id uuid, p_expected_revision integer, p_expected_send_mode text,
  p_validation_nonce_hash text, p_idempotency_key text, p_request_hash text, p_recipients jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_campaign public.campaigns%rowtype; v_run public.campaign_runs%rowtype;
  v_idempotency public.campaign_idempotency_records%rowtype; v_response jsonb;
  v_total integer; v_eligible integer; v_excluded integer;
begin
  if auth.uid() is not null and auth.uid() <> p_user_id then raise exception using errcode = '42501', message = 'campaign_owner_mismatch'; end if;
  if p_expected_send_mode not in ('now', 'scheduled') then raise exception using errcode = '22023', message = 'invalid_campaign_send_mode'; end if;
  if p_idempotency_key is null or char_length(trim(p_idempotency_key)) = 0 then raise exception using errcode = '22023', message = 'campaign_idempotency_key_required'; end if;
  select * into v_idempotency from public.campaign_idempotency_records
    where user_id = p_user_id and scope = 'campaign_submit' and idempotency_key = p_idempotency_key for update;
  if found then
    if v_idempotency.request_hash <> p_request_hash then raise exception using errcode = 'P0001', message = 'campaign_idempotency_key_reused'; end if;
    if v_idempotency.completed_at is not null then return v_idempotency.response_body; end if;
    raise exception using errcode = 'P0001', message = 'campaign_idempotency_in_progress';
  end if;
  insert into public.campaign_idempotency_records (user_id, scope, idempotency_key, request_hash, locked_at, expires_at)
    values (p_user_id, 'campaign_submit', p_idempotency_key, p_request_hash, now(), now() + interval '24 hours');
  select * into v_campaign from public.campaigns where id = p_campaign_id and user_id = p_user_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'campaign_draft_not_found'; end if;
  if v_campaign.status <> 'draft' then raise exception using errcode = 'P0001', message = 'campaign_not_draft'; end if;
  if v_campaign.revision <> p_expected_revision then raise exception using errcode = 'P0001', message = 'campaign_revision_conflict', detail = json_build_object('current_revision', v_campaign.revision)::text; end if;
  if v_campaign.send_mode <> p_expected_send_mode then raise exception using errcode = 'P0001', message = 'campaign_send_mode_mismatch'; end if;
  if v_campaign.validation_nonce_hash is null or v_campaign.validation_nonce_hash <> p_validation_nonce_hash then raise exception using errcode = 'P0001', message = 'campaign_validation_invalid'; end if;
  if v_campaign.name is null or v_campaign.link_type is null or v_campaign.subject_snapshot is null or v_campaign.message_snapshot is null or (v_campaign.send_mode = 'scheduled' and v_campaign.scheduled_for is null) then raise exception using errcode = 'P0001', message = 'campaign_submission_incomplete'; end if;
  if jsonb_typeof(p_recipients) <> 'array' or jsonb_array_length(p_recipients) = 0 then raise exception using errcode = 'P0001', message = 'campaign_has_no_eligible_recipients'; end if;
  select count(*), count(*) filter (where value->>'eligibility_status' = 'eligible'), count(*) filter (where value->>'eligibility_status' = 'excluded')
    into v_total, v_eligible, v_excluded from jsonb_array_elements(p_recipients);
  if v_eligible = 0 then raise exception using errcode = 'P0001', message = 'campaign_has_no_eligible_recipients'; end if;
  update public.campaigns set status = 'scheduled', scheduled_at = now(), validation_nonce_hash = null where id = v_campaign.id and user_id = p_user_id returning * into v_campaign;
  select * into v_run from public.campaign_runs where campaign_id = v_campaign.id and user_id = p_user_id and sequence_number = 1 for update;
  insert into public.campaign_recipients (campaign_id, campaign_run_id, user_id, client_id, recipient_email_snapshot, first_name_snapshot, eligibility_status, exclusion_reason, subject_snapshot, rendered_text_snapshot, rendered_html_snapshot, render_version, status, idempotency_key, queued_at, skipped_at)
  select v_campaign.id, v_run.id, p_user_id, nullif(value->>'client_id', '')::uuid, nullif(value->>'recipient_email_snapshot', ''), nullif(value->>'first_name_snapshot', ''), value->>'eligibility_status', nullif(value->>'exclusion_reason', ''), nullif(value->>'subject_snapshot', ''), nullif(value->>'rendered_text_snapshot', ''), nullif(value->>'rendered_html_snapshot', ''), coalesce((value->>'render_version')::integer, 1), case when value->>'eligibility_status' = 'eligible' then 'queued' else 'skipped' end, value->>'idempotency_key', case when value->>'eligibility_status' = 'eligible' then now() else null end, case when value->>'eligibility_status' = 'excluded' then now() else null end from jsonb_array_elements(p_recipients);
  update public.campaign_runs set status = 'scheduled', scheduled_for = case when v_campaign.send_mode = 'now' then coalesce(scheduled_for, v_campaign.scheduled_at, now()) else v_campaign.scheduled_for end, recipient_total = v_total, eligible_count = v_eligible, excluded_count = v_excluded, pending_count = 0, sending_count = 0, sent_count = 0, failed_count = 0 where id = v_run.id and campaign_id = v_campaign.id and user_id = p_user_id returning * into v_run;
  v_response = jsonb_build_object('campaign_id', v_campaign.id, 'run_id', v_run.id, 'status', v_campaign.status, 'send_mode', v_campaign.send_mode, 'scheduled_for', coalesce(v_campaign.scheduled_for, v_run.scheduled_for), 'recipient_total', v_total, 'eligible_count', v_eligible, 'excluded_count', v_excluded);
  update public.campaign_idempotency_records set response_status = 200, response_body = v_response, resource_type = 'campaign_run', resource_id = v_run.id, completed_at = now() where user_id = p_user_id and scope = 'campaign_submit' and idempotency_key = p_idempotency_key;
  return v_response;
end;
$$;

create or replace function public.cancel_campaign_submission(p_user_id uuid, p_campaign_id uuid, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_campaign public.campaigns%rowtype; v_cancelled integer;
begin
  if auth.uid() is not null and auth.uid() <> p_user_id then raise exception using errcode = '42501', message = 'campaign_owner_mismatch'; end if;
  select * into v_campaign from public.campaigns where id = p_campaign_id and user_id = p_user_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'campaign_not_found'; end if;
  if v_campaign.status = 'cancelled' then return jsonb_build_object('campaign_id', v_campaign.id, 'status', 'cancelled', 'cancelled_recipients', 0); end if;
  if v_campaign.status = 'sending' then raise exception using errcode = 'P0001', message = 'campaign_already_sending'; end if;
  if v_campaign.status <> 'scheduled' then raise exception using errcode = 'P0001', message = 'campaign_not_cancellable'; end if;
  update public.campaigns set status = 'cancelled', cancelled_at = now(), cancelled_reason = nullif(left(trim(coalesce(p_reason, '')), 1000), '') where id = v_campaign.id and user_id = p_user_id;
  update public.campaign_recipients set status = 'cancelled', cancelled_at = now() where campaign_id = v_campaign.id and user_id = p_user_id and status in ('pending', 'queued'); get diagnostics v_cancelled = row_count;
  return jsonb_build_object('campaign_id', v_campaign.id, 'status', 'cancelled', 'cancelled_recipients', v_cancelled);
end;
$$;

insert into public.outreach_schema_versions (component, version, applied_at) values ('campaign_authoring', 'campaign_submission_2026_07_18', now()) on conflict (component) do update set version = excluded.version, applied_at = excluded.applied_at;
revoke all on function public.submit_campaign(uuid, uuid, integer, text, text, text, text, jsonb) from public;
revoke all on function public.cancel_campaign_submission(uuid, uuid, text) from public;
grant execute on function public.submit_campaign(uuid, uuid, integer, text, text, text, text, jsonb) to authenticated, service_role;
grant execute on function public.cancel_campaign_submission(uuid, uuid, text) to authenticated, service_role;

-- Migration 202607180006_campaign_booking_attribution.sql
alter table public.appointments
  add column if not exists campaign_id uuid,
  add column if not exists campaign_run_id uuid,
  add column if not exists campaign_recipient_id uuid,
  add column if not exists campaign_attributed_at timestamptz;
alter table public.appointments
  add constraint appointments_campaign_fkey foreign key (campaign_id) references public.campaigns(id) on delete set null,
  add constraint appointments_campaign_run_fkey foreign key (campaign_run_id) references public.campaign_runs(id) on delete set null,
  add constraint appointments_campaign_recipient_fkey foreign key (campaign_recipient_id) references public.campaign_recipients(id) on delete set null;
create index appointments_campaign_attribution_idx on public.appointments(campaign_id, campaign_attributed_at desc) where campaign_id is not null and status <> 'cancelled';
create index campaign_recipients_tracking_token_idx on public.campaign_recipients(booking_tracking_token_hash) where booking_tracking_token_hash is not null;
insert into public.outreach_schema_versions (component, version, applied_at) values ('campaign_authoring', 'campaign_booking_attribution_2026_07_18', now()) on conflict (component) do update set version = excluded.version, applied_at = excluded.applied_at;

-- Migration 202607180007_campaign_delivery_worker.sql
create or replace function public.claim_campaign_recipients(p_limit integer, p_stale_before timestamptz, p_max_attempts integer default 3)
returns setof public.campaign_recipients language plpgsql security definer set search_path = public as $$
begin
  return query
  with candidates as (
    select r.id from public.campaign_recipients r
    join public.campaigns c on c.id = r.campaign_id and c.user_id = r.user_id
    join public.campaign_runs run on run.id = r.campaign_run_id and run.campaign_id = r.campaign_id
    where c.status in ('scheduled', 'sending') and run.status in ('scheduled', 'sending')
      and (run.scheduled_for is null or run.scheduled_for <= now())
      and (r.status = 'queued' or (r.status = 'failed' and r.attempt_count < greatest(1, least(p_max_attempts, 10))) or (r.status = 'sending' and r.sending_started_at < p_stale_before))
    order by coalesce(r.queued_at, r.created_at), r.id
    limit greatest(1, least(p_limit, 100)) for update of r, c, run skip locked
  ), claimed as (
    update public.campaign_recipients r set status = 'sending', attempt_count = attempt_count + 1,
      last_attempt_at = now(), sending_started_at = now(), error_code = null, error_message = null
    from candidates where r.id = candidates.id returning r.*
  ), runs as (
    update public.campaign_runs run set status = 'sending', started_at = coalesce(started_at, now())
    where run.id in (select campaign_run_id from claimed) and run.status = 'scheduled'
  ), campaigns as (
    update public.campaigns c set status = 'sending', sending_started_at = coalesce(sending_started_at, now())
    where c.id in (select campaign_id from claimed) and c.status = 'scheduled'
  ) select * from claimed;
end;
$$;
create or replace function public.validate_campaign_recipient_status_transition()
returns trigger language plpgsql as $$
begin
  if new.status = old.status then return new; end if;
  if not ((old.status = 'pending' and new.status in ('queued', 'skipped', 'cancelled'))
    or (old.status = 'queued' and new.status in ('sending', 'skipped', 'cancelled'))
    or (old.status = 'sending' and new.status in ('sent', 'failed', 'skipped'))
    or (old.status = 'sent' and new.status in ('delivered', 'failed'))
    or (old.status = 'failed' and new.status in ('queued', 'sending', 'skipped', 'cancelled'))) then
    raise exception using errcode = '23514', message = 'invalid_campaign_recipient_status_transition';
  end if;
  return new;
end;
$$;
create or replace function public.finalize_campaign_runs(p_run_ids uuid[], p_max_attempts integer default 3)
returns void language plpgsql security definer set search_path = public as $$
declare v_run record; v_pending integer; v_failed integer; v_sent integer; v_status text;
begin
  for v_run in select id, campaign_id, user_id from public.campaign_runs where id = any(p_run_ids) for update loop
    select count(*) filter (where status in ('pending','queued','sending') or (status = 'failed' and attempt_count < greatest(1, least(p_max_attempts, 10)))), count(*) filter (where status = 'failed'), count(*) filter (where status in ('sent','delivered')) into v_pending, v_failed, v_sent from public.campaign_recipients where campaign_run_id = v_run.id;
    if v_pending > 0 then continue; end if;
    v_status := case when v_sent = 0 and v_failed > 0 then 'failed' when v_failed > 0 then 'partially_failed' else 'completed' end;
    update public.campaign_runs set status = v_status, completed_at = now(), pending_count = 0, sending_count = 0, sent_count = v_sent, failed_count = v_failed where id = v_run.id;
    update public.campaigns set status = v_status, completed_at = now(), failure_summary = jsonb_build_object('sent_count', v_sent, 'failed_count', v_failed) where id = v_run.campaign_id and user_id = v_run.user_id;
  end loop;
end;
$$;
insert into public.outreach_schema_versions (component, version, applied_at) values ('campaign_authoring', 'campaign_delivery_worker_2026_07_18', now()) on conflict (component) do update set version = excluded.version, applied_at = excluded.applied_at;
grant execute on function public.claim_campaign_recipients(integer, timestamptz, integer) to service_role;
grant execute on function public.finalize_campaign_runs(uuid[], integer) to service_role;

-- Migration 202607180008_campaign_reporting.sql
create or replace function public.get_campaign_reporting_summaries(p_user_id uuid, p_campaign_ids uuid[])
returns table (campaign_id uuid, recipient_total bigint, eligible_count bigint, excluded_count bigint,
  pending_count bigint, queued_count bigint, sending_count bigint, sent_count bigint, delivered_count bigint,
  failed_count bigint, skipped_count bigint, cancelled_count bigint, attributed_booking_count bigint, booked_revenue_cents bigint)
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception using errcode = '42501', message = 'campaign_owner_mismatch';
  end if;
  return query
  select c.id, coalesce(r.recipient_total, 0), coalesce(r.eligible_count, 0), coalesce(r.excluded_count, 0),
    coalesce(r.pending_count, 0), coalesce(r.queued_count, 0), coalesce(r.sending_count, 0), coalesce(r.sent_count, 0),
    coalesce(r.delivered_count, 0), coalesce(r.failed_count, 0), coalesce(r.skipped_count, 0), coalesce(r.cancelled_count, 0),
    coalesce(a.attributed_booking_count, 0), coalesce(a.booked_revenue_cents, 0)
  from public.campaigns c
  left join lateral (
    select count(*)::bigint as recipient_total, count(*) filter (where eligibility_status = 'eligible')::bigint as eligible_count,
      count(*) filter (where eligibility_status = 'excluded')::bigint as excluded_count, count(*) filter (where status = 'pending')::bigint as pending_count,
      count(*) filter (where status = 'queued')::bigint as queued_count, count(*) filter (where status = 'sending')::bigint as sending_count,
      count(*) filter (where status = 'sent')::bigint as sent_count, count(*) filter (where status = 'delivered')::bigint as delivered_count,
      count(*) filter (where status = 'failed')::bigint as failed_count, count(*) filter (where status = 'skipped')::bigint as skipped_count,
      count(*) filter (where status = 'cancelled')::bigint as cancelled_count
    from public.campaign_recipients r where r.campaign_id = c.id and r.user_id = p_user_id
  ) r on true
  left join lateral (
    select count(*)::bigint as attributed_booking_count, coalesce(sum(round(coalesce(a.price, 0) * 100))::bigint, 0)::bigint as booked_revenue_cents
    from public.appointments a where a.campaign_id = c.id and a.user_id = p_user_id and a.status <> 'cancelled'
  ) a on true
  where c.user_id = p_user_id and c.id = any(p_campaign_ids);
end;
$$;
insert into public.outreach_schema_versions (component, version, applied_at) values ('campaign_authoring', 'campaign_reporting_2026_07_18', now()) on conflict (component) do update set version = excluded.version, applied_at = excluded.applied_at;
revoke all on function public.get_campaign_reporting_summaries(uuid, uuid[]) from public;
grant execute on function public.get_campaign_reporting_summaries(uuid, uuid[]) to authenticated, service_role;

-- Migration 202607180009_campaign_delivery_analytics.sql
create table public.campaign_delivery_events (
  id uuid primary key default gen_random_uuid(), campaign_id uuid not null, campaign_recipient_id uuid not null, user_id uuid not null,
  provider text not null, provider_event_id text not null, provider_message_id text, event_type text not null, occurred_at timestamptz not null,
  url text, is_automated boolean not null default false, privacy_limited boolean not null default false, provider_payload jsonb, created_at timestamptz not null default now(),
  constraint campaign_delivery_events_campaign_fkey foreign key (campaign_id, user_id) references public.campaigns(id, user_id) on delete cascade,
  constraint campaign_delivery_events_recipient_fkey foreign key (campaign_recipient_id) references public.campaign_recipients(id) on delete cascade,
  constraint campaign_delivery_events_provider_event_unique unique (provider, provider_event_id),
  constraint campaign_delivery_events_type_check check (event_type in ('delivered', 'opened', 'clicked', 'bounced', 'complained')),
  constraint campaign_delivery_events_provider_check check (char_length(trim(provider)) between 1 and 80),
  constraint campaign_delivery_events_provider_event_check check (char_length(trim(provider_event_id)) between 1 and 255),
  constraint campaign_delivery_events_provider_message_check check (provider_message_id is null or char_length(provider_message_id) <= 255),
  constraint campaign_delivery_events_url_check check (url is null or char_length(url) <= 4000)
);
create index campaign_delivery_events_campaign_type_idx on public.campaign_delivery_events(campaign_id, event_type, occurred_at desc);
create index campaign_delivery_events_recipient_type_idx on public.campaign_delivery_events(campaign_recipient_id, event_type, occurred_at desc);
create index campaign_delivery_events_provider_message_idx on public.campaign_delivery_events(provider, provider_message_id) where provider_message_id is not null;

-- Insights aggregate indexes: all reporting queries are account-scoped and
-- bounded to an explicit reporting window.
create index if not exists insights_appointments_user_date_idx on public.appointments(user_id, appointment_date) where status <> 'cancelled';
create index if not exists insights_activity_events_user_type_occurred_idx on public.activity_events(user_id, activity_type, occurred_at desc);
create index if not exists insights_referral_links_user_created_idx on public.client_referral_links(user_id, created_at desc);
create index if not exists insights_referral_events_user_type_created_idx on public.referral_events(user_id, event_type, created_at desc);
create index if not exists insights_clients_user_referral_attributed_idx on public.clients(user_id, original_referral_attributed_at desc) where original_referral_attributed_at is not null;
create index if not exists insights_appointments_user_referral_attributed_idx on public.appointments(user_id, referral_attributed_at desc) where referral_attributed_at is not null and status <> 'cancelled';
create index if not exists insights_campaign_recipients_user_sent_idx on public.campaign_recipients(user_id, sent_at desc, campaign_id) where sent_at is not null;
create index if not exists insights_appointments_user_campaign_attributed_idx on public.appointments(user_id, campaign_attributed_at desc, campaign_id) where campaign_id is not null and status <> 'cancelled';
alter table public.campaign_delivery_events enable row level security;
create policy campaign_delivery_events_owner_select on public.campaign_delivery_events for select using (auth.uid() = user_id);
revoke all on table public.campaign_delivery_events from anon, authenticated;
grant select, insert, update, delete on table public.campaign_delivery_events to service_role;
create or replace function public.get_campaign_reporting_summaries_v2(p_user_id uuid, p_campaign_ids uuid[])
returns table (campaign_id uuid, recipient_total bigint, eligible_count bigint, excluded_count bigint, pending_count bigint, queued_count bigint, sending_count bigint, sent_count bigint, delivered_count bigint, failed_count bigint, skipped_count bigint, cancelled_count bigint, attributed_booking_count bigint, booked_revenue_cents bigint, delivered_raw bigint, opens_raw bigint, opens_unique bigint, opens_automated bigint, opens_privacy_limited bigint, clicks_raw bigint, clicks_unique bigint, clicks_automated bigint, clicks_privacy_limited bigint)
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and auth.uid() <> p_user_id then raise exception using errcode = '42501', message = 'campaign_owner_mismatch'; end if;
  return query
  select c.id, coalesce(r.recipient_total, 0), coalesce(r.eligible_count, 0), coalesce(r.excluded_count, 0), coalesce(r.pending_count, 0), coalesce(r.queued_count, 0), coalesce(r.sending_count, 0), coalesce(r.sent_count, 0), coalesce(r.delivered_count, 0), coalesce(r.failed_count, 0), coalesce(r.skipped_count, 0), coalesce(r.cancelled_count, 0), coalesce(a.attributed_booking_count, 0), coalesce(a.booked_revenue_cents, 0), coalesce(e.delivered_raw, 0), coalesce(e.opens_raw, 0), coalesce(e.opens_unique, 0), coalesce(e.opens_automated, 0), coalesce(e.opens_privacy_limited, 0), coalesce(e.clicks_raw, 0), coalesce(e.clicks_unique, 0), coalesce(e.clicks_automated, 0), coalesce(e.clicks_privacy_limited, 0)
  from public.campaigns c
  left join lateral (select count(*)::bigint recipient_total, count(*) filter (where eligibility_status = 'eligible')::bigint eligible_count, count(*) filter (where eligibility_status = 'excluded')::bigint excluded_count, count(*) filter (where status = 'pending')::bigint pending_count, count(*) filter (where status = 'queued')::bigint queued_count, count(*) filter (where status = 'sending')::bigint sending_count, count(*) filter (where status = 'sent')::bigint sent_count, count(*) filter (where status = 'delivered')::bigint delivered_count, count(*) filter (where status = 'failed')::bigint failed_count, count(*) filter (where status = 'skipped')::bigint skipped_count, count(*) filter (where status = 'cancelled')::bigint cancelled_count from public.campaign_recipients r where r.campaign_id = c.id and r.user_id = p_user_id) r on true
  left join lateral (select count(*)::bigint attributed_booking_count, coalesce(sum(round(coalesce(a.price, 0) * 100))::bigint, 0)::bigint booked_revenue_cents from public.appointments a where a.campaign_id = c.id and a.user_id = p_user_id and a.status <> 'cancelled') a on true
  left join lateral (select count(*) filter (where event_type = 'delivered')::bigint delivered_raw, count(*) filter (where event_type = 'opened')::bigint opens_raw, count(distinct campaign_recipient_id) filter (where event_type = 'opened')::bigint opens_unique, count(*) filter (where event_type = 'opened' and is_automated)::bigint opens_automated, count(*) filter (where event_type = 'opened' and privacy_limited)::bigint opens_privacy_limited, count(*) filter (where event_type = 'clicked')::bigint clicks_raw, count(distinct campaign_recipient_id) filter (where event_type = 'clicked')::bigint clicks_unique, count(*) filter (where event_type = 'clicked' and is_automated)::bigint clicks_automated, count(*) filter (where event_type = 'clicked' and privacy_limited)::bigint clicks_privacy_limited from public.campaign_delivery_events e where e.campaign_id = c.id and e.user_id = p_user_id) e on true
  where c.user_id = p_user_id and c.id = any(p_campaign_ids);
end;
$$;
insert into public.outreach_schema_versions (component, version, applied_at) values ('campaign_authoring', 'campaign_delivery_analytics_2026_07_18', now()) on conflict (component) do update set version = excluded.version, applied_at = excluded.applied_at;

-- Migration 202607200001_insight_snapshot_configurations.sql
create table if not exists public.insight_snapshot_configurations (
  id uuid primary key default gen_random_uuid(),
  configuration_version integer not null,
  is_active boolean not null default false,
  enabled boolean not null default true,
  pages jsonb not null,
  target_plan_tiers text[],
  rollout_percentage integer not null default 100,
  updated_by text not null default 'system',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint insight_snapshot_configurations_version_check check (configuration_version > 0),
  constraint insight_snapshot_configurations_pages_array_check check (jsonb_typeof(pages) = 'array'),
  constraint insight_snapshot_configurations_rollout_check check (rollout_percentage between 0 and 100),
  constraint insight_snapshot_configurations_plan_tiers_check check (target_plan_tiers is null or target_plan_tiers <@ array['basic', 'pro', 'premium']::text[]),
  constraint insight_snapshot_configurations_updated_by_check check (char_length(trim(updated_by)) between 1 and 255)
);
create unique index if not exists insight_snapshot_configurations_one_active_idx on public.insight_snapshot_configurations ((is_active)) where is_active;
create or replace function public.set_insight_snapshot_configuration_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;
drop trigger if exists set_insight_snapshot_configuration_updated_at on public.insight_snapshot_configurations;
create trigger set_insight_snapshot_configuration_updated_at before update on public.insight_snapshot_configurations for each row execute function public.set_insight_snapshot_configuration_updated_at();
alter table public.insight_snapshot_configurations enable row level security;
revoke all on table public.insight_snapshot_configurations from anon, authenticated;
grant select, insert, update, delete on table public.insight_snapshot_configurations to service_role;
insert into public.insight_snapshot_configurations (id, configuration_version, is_active, enabled, pages, target_plan_tiers, rollout_percentage, updated_by)
select '20260720-0000-4000-8000-000000000001'::uuid, 1, true, true, '[{"id":"business_performance","title":"Business Performance","layout":"grid_2x2","period_behavior":"selected_period","enabled":true,"metrics":[{"metric_id":"booked_revenue","enabled":true},{"metric_id":"appointments_booked","enabled":true},{"metric_id":"rebooking_rate","enabled":true},{"metric_id":"average_ticket","enabled":true}]}]'::jsonb, null, 100, 'system:initial-insights-configuration'
where not exists (select 1 from public.insight_snapshot_configurations where is_active)
on conflict (id) do nothing;

-- Migration 202607200002_insights_campaign_aggregate.sql
create or replace function public.get_insights_campaign_aggregate(p_user_id uuid, p_start_at timestamptz, p_end_at timestamptz)
returns table (has_campaign_history boolean, emails_sent bigint, appointments_booked bigint, attributed_revenue_minor bigint, top_campaign_id uuid, top_campaign_name text, top_campaign_status text, top_campaign_emails_sent bigint, top_campaign_appointments_booked bigint, top_campaign_attributed_revenue_minor bigint)
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and auth.uid() <> p_user_id then raise exception using errcode = '42501', message = 'campaign_owner_mismatch'; end if;
  return query
  with campaign_history as (
    select exists (select 1 from public.campaigns c where c.user_id = p_user_id) as has_campaign_history
  ), sent_by_campaign as (
    select r.campaign_id, count(*)::bigint as emails_sent from public.campaign_recipients r where r.user_id = p_user_id and r.sent_at >= p_start_at and r.sent_at < p_end_at group by r.campaign_id
  ), attributed_by_campaign as (
    select a.campaign_id, count(*)::bigint as appointments_booked, coalesce(sum(round(coalesce(a.price, 0) * 100))::bigint, 0)::bigint as attributed_revenue_minor from public.appointments a where a.user_id = p_user_id and a.campaign_id is not null and a.status <> 'cancelled' and a.campaign_attributed_at >= p_start_at and a.campaign_attributed_at < p_end_at group by a.campaign_id
  ), period_campaigns as (
    select campaign_id from sent_by_campaign union select campaign_id from attributed_by_campaign
  ), campaign_metrics as (
    select c.id, c.name, c.status, coalesce(sent.emails_sent, 0)::bigint as emails_sent, coalesce(attributed.appointments_booked, 0)::bigint as appointments_booked, coalesce(attributed.attributed_revenue_minor, 0)::bigint as attributed_revenue_minor from period_campaigns period_campaign join public.campaigns c on c.id = period_campaign.campaign_id and c.user_id = p_user_id left join sent_by_campaign sent on sent.campaign_id = c.id left join attributed_by_campaign attributed on attributed.campaign_id = c.id
  ), top_campaign as (
    select * from campaign_metrics order by attributed_revenue_minor desc, appointments_booked desc, emails_sent desc, id asc limit 1
  )
  select (select has_campaign_history from campaign_history), coalesce((select sum(emails_sent)::bigint from campaign_metrics), 0)::bigint, coalesce((select sum(appointments_booked)::bigint from campaign_metrics), 0)::bigint, coalesce((select sum(attributed_revenue_minor)::bigint from campaign_metrics), 0)::bigint, (select id from top_campaign), (select name from top_campaign), (select status from top_campaign), coalesce((select emails_sent from top_campaign), 0)::bigint, coalesce((select appointments_booked from top_campaign), 0)::bigint, coalesce((select attributed_revenue_minor from top_campaign), 0)::bigint;
end;
$$;
revoke all on function public.get_insights_campaign_aggregate(uuid, timestamptz, timestamptz) from public;
grant execute on function public.get_insights_campaign_aggregate(uuid, timestamptz, timestamptz) to authenticated, service_role;
revoke all on function public.get_campaign_reporting_summaries_v2(uuid, uuid[]) from public;
grant execute on function public.get_campaign_reporting_summaries_v2(uuid, uuid[]) to authenticated, service_role;

-- Migration 202607220001_app_content_foundation.sql
create or replace function public.app_content_placeholder_names_valid(values_to_check text[]) returns boolean language sql immutable as $$
  select coalesce(bool_and(value ~ '^[a-z][a-zA-Z0-9]*$'), true)
  from unnest(coalesce(values_to_check, '{}'::text[])) as value;
$$;
create or replace function public.app_content_placeholder_names_unique(values_to_check text[]) returns boolean language sql immutable as $$
  select coalesce(cardinality(values_to_check), 0) = (
    select count(distinct value)
    from unnest(coalesce(values_to_check, '{}'::text[])) as value
  );
$$;

create table if not exists public.app_content_definitions (
  key text primary key,
  namespace text not null,
  category text not null,
  description text not null,
  allowed_placeholders text[] not null default '{}'::text[],
  max_length integer not null default 500,
  multiline_allowed boolean not null default false,
  is_active boolean not null default true,
  fallback_required boolean not null default true,
  developer_notes text,
  created_by_admin_email text not null default 'system',
  updated_by_admin_email text not null default 'system',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint app_content_definitions_key_check check (key ~ '^[a-z][a-z0-9]*([.][a-z][a-z0-9_]*)+$'),
  constraint app_content_definitions_namespace_check check (namespace ~ '^[a-z][a-z0-9_]*$'),
  constraint app_content_definitions_category_check check (category in ('screen', 'section', 'empty_state', 'cta', 'upgrade', 'callout', 'dialog', 'onboarding')),
  constraint app_content_definitions_description_length_check check (char_length(trim(description)) between 1 and 500),
  constraint app_content_definitions_max_length_check check (max_length between 1 and 2000),
  constraint app_content_definitions_placeholder_names_check check (public.app_content_placeholder_names_valid(allowed_placeholders)),
  constraint app_content_definitions_placeholder_names_unique check (public.app_content_placeholder_names_unique(allowed_placeholders)),
  constraint app_content_definitions_created_by_length_check check (char_length(trim(created_by_admin_email)) between 1 and 255),
  constraint app_content_definitions_updated_by_length_check check (char_length(trim(updated_by_admin_email)) between 1 and 255)
);
create index if not exists app_content_definitions_namespace_active_idx on public.app_content_definitions(namespace, key) where is_active;

create table if not exists public.app_content_locale_state (
  locale text primary key,
  active_revision_id uuid,
  active_version bigint not null default 0,
  updated_by_admin_email text not null default 'system',
  updated_by_user_id uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint app_content_locale_state_locale_check check (locale ~ '^[a-z]{2,3}(-[A-Z]{2})?$'),
  constraint app_content_locale_state_active_version_check check (active_version >= 0),
  constraint app_content_locale_state_updated_by_length_check check (char_length(trim(updated_by_admin_email)) between 1 and 255)
);

create table if not exists public.app_content_drafts (
  definition_key text not null references public.app_content_definitions(key) on delete restrict,
  locale text not null references public.app_content_locale_state(locale) on delete restrict,
  value text not null,
  draft_version integer not null default 1,
  validation_status text not null default 'unvalidated',
  validation_errors jsonb,
  updated_by_admin_email text not null default 'system',
  updated_by_user_id uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (definition_key, locale),
  constraint app_content_drafts_value_not_blank_check check (char_length(trim(value)) >= 1),
  constraint app_content_drafts_draft_version_check check (draft_version > 0),
  constraint app_content_drafts_validation_status_check check (validation_status in ('unvalidated', 'valid', 'invalid')),
  constraint app_content_drafts_validation_errors_object_check check (validation_errors is null or jsonb_typeof(validation_errors) = 'object'),
  constraint app_content_drafts_updated_by_length_check check (char_length(trim(updated_by_admin_email)) between 1 and 255)
);
create index if not exists app_content_drafts_locale_updated_idx on public.app_content_drafts(locale, updated_at desc, definition_key);

create table if not exists public.app_content_revisions (
  id uuid primary key default gen_random_uuid(),
  locale text not null references public.app_content_locale_state(locale) on delete restrict,
  version bigint not null,
  kind text not null,
  source_revision_id uuid references public.app_content_revisions(id) on delete restrict,
  checksum text not null,
  published_by_admin_email text not null,
  published_by_user_id uuid references public.users(id) on delete set null,
  published_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint app_content_revisions_locale_version_unique unique (locale, version),
  constraint app_content_revisions_version_check check (version > 0),
  constraint app_content_revisions_kind_check check (kind in ('publish', 'rollback')),
  constraint app_content_revisions_checksum_check check (checksum ~ '^[a-f0-9]{64}$'),
  constraint app_content_revisions_published_by_length_check check (char_length(trim(published_by_admin_email)) between 1 and 255)
);
alter table public.app_content_locale_state add constraint app_content_locale_state_active_revision_fkey foreign key (active_revision_id) references public.app_content_revisions(id) on delete restrict;
create index if not exists app_content_revisions_locale_published_idx on public.app_content_revisions(locale, version desc);

create table if not exists public.app_content_revision_entries (
  revision_id uuid not null references public.app_content_revisions(id) on delete restrict,
  definition_key text not null references public.app_content_definitions(key) on delete restrict,
  value text not null,
  created_at timestamptz not null default now(),
  primary key (revision_id, definition_key),
  constraint app_content_revision_entries_value_not_blank_check check (char_length(trim(value)) >= 1)
);
create index if not exists app_content_revision_entries_definition_idx on public.app_content_revision_entries(definition_key, revision_id);

create table if not exists public.app_content_audit_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  definition_key text references public.app_content_definitions(key) on delete restrict,
  locale text references public.app_content_locale_state(locale) on delete restrict,
  revision_id uuid references public.app_content_revisions(id) on delete restrict,
  actor_user_id uuid references public.users(id) on delete set null,
  actor_admin_email text not null,
  previous_value text,
  new_value text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint app_content_audit_events_type_check check (event_type in ('definition_created', 'definition_updated', 'draft_updated', 'validated', 'published', 'rolled_back', 'archived')),
  constraint app_content_audit_events_actor_length_check check (char_length(trim(actor_admin_email)) between 1 and 255),
  constraint app_content_audit_events_metadata_object_check check (jsonb_typeof(metadata) = 'object')
);
create index if not exists app_content_audit_events_locale_created_idx on public.app_content_audit_events(locale, created_at desc, id);
create index if not exists app_content_audit_events_definition_created_idx on public.app_content_audit_events(definition_key, created_at desc, id);
create index if not exists app_content_audit_events_revision_idx on public.app_content_audit_events(revision_id, created_at desc, id);

create or replace function public.set_app_content_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;
create or replace function public.prevent_app_content_definition_key_update() returns trigger language plpgsql as $$ begin if new.key <> old.key then raise exception using errcode = '23514', message = 'app_content_definition_key_is_immutable'; end if; return new; end; $$;
create or replace function public.prevent_app_content_immutable_mutation() returns trigger language plpgsql as $$ begin raise exception using errcode = '23514', message = 'app_content_immutable_row'; end; $$;
drop trigger if exists app_content_definitions_set_updated_at on public.app_content_definitions;
create trigger app_content_definitions_set_updated_at before update on public.app_content_definitions for each row execute function public.set_app_content_updated_at();
drop trigger if exists app_content_definitions_prevent_key_update on public.app_content_definitions;
create trigger app_content_definitions_prevent_key_update before update on public.app_content_definitions for each row execute function public.prevent_app_content_definition_key_update();
drop trigger if exists app_content_locale_state_set_updated_at on public.app_content_locale_state;
create trigger app_content_locale_state_set_updated_at before update on public.app_content_locale_state for each row execute function public.set_app_content_updated_at();
drop trigger if exists app_content_drafts_set_updated_at on public.app_content_drafts;
create trigger app_content_drafts_set_updated_at before update on public.app_content_drafts for each row execute function public.set_app_content_updated_at();
drop trigger if exists app_content_revisions_immutable on public.app_content_revisions;
create trigger app_content_revisions_immutable before update or delete on public.app_content_revisions for each row execute function public.prevent_app_content_immutable_mutation();
drop trigger if exists app_content_revision_entries_immutable on public.app_content_revision_entries;
create trigger app_content_revision_entries_immutable before update or delete on public.app_content_revision_entries for each row execute function public.prevent_app_content_immutable_mutation();
drop trigger if exists app_content_audit_events_immutable on public.app_content_audit_events;
create trigger app_content_audit_events_immutable before update or delete on public.app_content_audit_events for each row execute function public.prevent_app_content_immutable_mutation();

alter table public.app_content_definitions enable row level security;
alter table public.app_content_locale_state enable row level security;
alter table public.app_content_drafts enable row level security;
alter table public.app_content_revisions enable row level security;
alter table public.app_content_revision_entries enable row level security;
alter table public.app_content_audit_events enable row level security;
revoke all on table public.app_content_definitions from public, anon, authenticated;
revoke all on table public.app_content_locale_state from public, anon, authenticated;
revoke all on table public.app_content_drafts from public, anon, authenticated;
revoke all on table public.app_content_revisions from public, anon, authenticated;
revoke all on table public.app_content_revision_entries from public, anon, authenticated;
revoke all on table public.app_content_audit_events from public, anon, authenticated;
grant select, insert, update, delete on table public.app_content_definitions to service_role;
grant select, insert, update, delete on table public.app_content_locale_state to service_role;
grant select, insert, update, delete on table public.app_content_drafts to service_role;
grant select, insert, update, delete on table public.app_content_revisions to service_role;
grant select, insert, update, delete on table public.app_content_revision_entries to service_role;
grant select, insert, update, delete on table public.app_content_audit_events to service_role;
revoke all on function public.app_content_placeholder_names_valid(text[]) from public;
revoke all on function public.app_content_placeholder_names_unique(text[]) from public;
revoke all on function public.set_app_content_updated_at() from public;
revoke all on function public.prevent_app_content_definition_key_update() from public;
revoke all on function public.prevent_app_content_immutable_mutation() from public;
grant execute on function public.app_content_placeholder_names_valid(text[]) to service_role;
grant execute on function public.app_content_placeholder_names_unique(text[]) to service_role;
grant execute on function public.set_app_content_updated_at() to service_role;
grant execute on function public.prevent_app_content_definition_key_update() to service_role;
grant execute on function public.prevent_app_content_immutable_mutation() to service_role;

-- Migration 202607220002_app_content_draft_audit.sql
create or replace function public.record_app_content_definition_audit() returns trigger language plpgsql as $$
begin
  insert into public.app_content_audit_events (event_type, definition_key, actor_admin_email, metadata)
  values (
    case when tg_op = 'INSERT' then 'definition_created' else 'definition_updated' end,
    new.key,
    case when tg_op = 'INSERT' then new.created_by_admin_email else new.updated_by_admin_email end,
    jsonb_build_object('namespace', new.namespace, 'category', new.category, 'is_active', new.is_active)
  );
  return new;
end;
$$;
create or replace function public.record_app_content_draft_audit() returns trigger language plpgsql as $$
begin
  insert into public.app_content_audit_events (event_type, definition_key, locale, actor_user_id, actor_admin_email, previous_value, new_value, metadata)
  values (
    'draft_updated', new.definition_key, new.locale, new.updated_by_user_id, new.updated_by_admin_email,
    case when tg_op = 'UPDATE' then old.value else null end, new.value,
    jsonb_build_object('draft_version', new.draft_version, 'validation_status', new.validation_status)
  );
  return new;
end;
$$;
drop trigger if exists app_content_definitions_audit on public.app_content_definitions;
create trigger app_content_definitions_audit after insert or update on public.app_content_definitions for each row execute function public.record_app_content_definition_audit();
drop trigger if exists app_content_drafts_audit on public.app_content_drafts;
create trigger app_content_drafts_audit after insert or update on public.app_content_drafts for each row execute function public.record_app_content_draft_audit();
revoke all on function public.record_app_content_definition_audit() from public;
revoke all on function public.record_app_content_draft_audit() from public;
grant execute on function public.record_app_content_definition_audit() to service_role;
grant execute on function public.record_app_content_draft_audit() to service_role;

-- Migration 202607220003_app_content_publication.sql
insert into public.app_content_locale_state (locale, active_version, updated_by_admin_email) values ('en-US', 0, 'system') on conflict (locale) do nothing;
create or replace function public.publish_app_content_locale(p_locale text, p_expected_active_version bigint, p_actor_user_id uuid, p_actor_admin_email text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_state public.app_content_locale_state%rowtype; v_revision_id uuid; v_checksum text; v_missing_keys text[]; v_invalid_entries jsonb; v_active_definition_count integer;
begin
  select * into v_state from public.app_content_locale_state where locale = p_locale for update;
  if not found then raise exception using errcode = 'P0002', message = 'app_content_locale_not_found'; end if;
  if v_state.active_version <> p_expected_active_version then raise exception using errcode = 'P0001', message = 'app_content_locale_version_conflict', detail = jsonb_build_object('current_active_version', v_state.active_version)::text; end if;
  select count(*) into v_active_definition_count from public.app_content_definitions where is_active;
  if v_active_definition_count = 0 then raise exception using errcode = 'P0001', message = 'app_content_publish_no_active_definitions'; end if;
  select array_agg(definition.key order by definition.key) into v_missing_keys from public.app_content_definitions definition left join public.app_content_drafts draft on draft.definition_key = definition.key and draft.locale = p_locale where definition.is_active and draft.definition_key is null;
  if v_missing_keys is not null then raise exception using errcode = 'P0001', message = 'app_content_publish_missing_drafts', detail = jsonb_build_object('missing_keys', v_missing_keys)::text; end if;
  select jsonb_agg(jsonb_build_object('key', definition.key, 'reason', invalid.reason) order by definition.key) into v_invalid_entries
  from public.app_content_definitions definition join public.app_content_drafts draft on draft.definition_key = definition.key and draft.locale = p_locale
  cross join lateral (select case
    when char_length(trim(draft.value)) = 0 then 'blank'
    when char_length(draft.value) > definition.max_length then 'length'
    when not definition.multiline_allowed and position(chr(10) in draft.value) > 0 then 'newline'
    when draft.value ~ '[<>]' then 'markup'
    when regexp_replace(draft.value, $placeholder$\{\{[a-z][a-zA-Z0-9]*\}\}$placeholder$, '', 'g') ~ '[{}]' then 'malformed_placeholder'
    when exists (select 1 from regexp_matches(draft.value, $placeholder$\{\{([a-z][a-zA-Z0-9]*)\}\}$placeholder$, 'g') as placeholder_match where not (placeholder_match[1] = any(definition.allowed_placeholders))) then 'unknown_placeholder'
    when regexp_replace(draft.value, chr(10), '', 'g') ~ '[[:cntrl:]]' then 'control_character'
    else null end as reason) invalid
  where definition.is_active and invalid.reason is not null;
  if v_invalid_entries is not null then raise exception using errcode = 'P0001', message = 'app_content_publish_invalid_drafts', detail = jsonb_build_object('invalid_entries', v_invalid_entries)::text; end if;
  select encode(digest(string_agg(definition.key || chr(31) || draft.value, chr(30) order by definition.key), 'sha256'), 'hex') into v_checksum from public.app_content_definitions definition join public.app_content_drafts draft on draft.definition_key = definition.key and draft.locale = p_locale where definition.is_active;
  insert into public.app_content_revisions (locale, version, kind, checksum, published_by_admin_email, published_by_user_id) values (p_locale, v_state.active_version + 1, 'publish', v_checksum, p_actor_admin_email, p_actor_user_id) returning id into v_revision_id;
  insert into public.app_content_revision_entries (revision_id, definition_key, value) select v_revision_id, definition.key, draft.value from public.app_content_definitions definition join public.app_content_drafts draft on draft.definition_key = definition.key and draft.locale = p_locale where definition.is_active order by definition.key;
  update public.app_content_locale_state set active_revision_id = v_revision_id, active_version = v_state.active_version + 1, updated_by_admin_email = p_actor_admin_email, updated_by_user_id = p_actor_user_id where locale = p_locale;
  insert into public.app_content_audit_events (event_type, locale, revision_id, actor_user_id, actor_admin_email, metadata) values ('published', p_locale, v_revision_id, p_actor_user_id, p_actor_admin_email, jsonb_build_object('version', v_state.active_version + 1, 'checksum', v_checksum));
  return jsonb_build_object('revision_id', v_revision_id, 'locale', p_locale, 'version', v_state.active_version + 1, 'checksum', v_checksum, 'published_at', now());
end;
$$;
create or replace function public.rollback_app_content_locale(p_locale text, p_target_revision_id uuid, p_expected_active_version bigint, p_actor_user_id uuid, p_actor_admin_email text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_state public.app_content_locale_state%rowtype; v_target public.app_content_revisions%rowtype; v_revision_id uuid; v_checksum text; v_missing_keys text[];
begin
  select * into v_state from public.app_content_locale_state where locale = p_locale for update;
  if not found then raise exception using errcode = 'P0002', message = 'app_content_locale_not_found'; end if;
  if v_state.active_version <> p_expected_active_version then raise exception using errcode = 'P0001', message = 'app_content_locale_version_conflict', detail = jsonb_build_object('current_active_version', v_state.active_version)::text; end if;
  select * into v_target from public.app_content_revisions where id = p_target_revision_id and locale = p_locale;
  if not found then raise exception using errcode = 'P0002', message = 'app_content_revision_not_found'; end if;
  select array_agg(definition.key order by definition.key) into v_missing_keys from public.app_content_definitions definition left join public.app_content_revision_entries entry on entry.revision_id = v_target.id and entry.definition_key = definition.key where definition.is_active and entry.definition_key is null;
  if v_missing_keys is not null then raise exception using errcode = 'P0001', message = 'app_content_rollback_missing_active_keys', detail = jsonb_build_object('missing_keys', v_missing_keys)::text; end if;
  select encode(digest(string_agg(entry.definition_key || chr(31) || entry.value, chr(30) order by entry.definition_key), 'sha256'), 'hex') into v_checksum from public.app_content_revision_entries entry join public.app_content_definitions definition on definition.key = entry.definition_key where entry.revision_id = v_target.id and definition.is_active;
  insert into public.app_content_revisions (locale, version, kind, source_revision_id, checksum, published_by_admin_email, published_by_user_id) values (p_locale, v_state.active_version + 1, 'rollback', v_target.id, v_checksum, p_actor_admin_email, p_actor_user_id) returning id into v_revision_id;
  insert into public.app_content_revision_entries (revision_id, definition_key, value) select v_revision_id, entry.definition_key, entry.value from public.app_content_revision_entries entry join public.app_content_definitions definition on definition.key = entry.definition_key where entry.revision_id = v_target.id and definition.is_active order by entry.definition_key;
  update public.app_content_locale_state set active_revision_id = v_revision_id, active_version = v_state.active_version + 1, updated_by_admin_email = p_actor_admin_email, updated_by_user_id = p_actor_user_id where locale = p_locale;
  insert into public.app_content_audit_events (event_type, locale, revision_id, actor_user_id, actor_admin_email, metadata) values ('rolled_back', p_locale, v_revision_id, p_actor_user_id, p_actor_admin_email, jsonb_build_object('version', v_state.active_version + 1, 'target_revision_id', v_target.id, 'checksum', v_checksum));
  return jsonb_build_object('revision_id', v_revision_id, 'source_revision_id', v_target.id, 'locale', p_locale, 'version', v_state.active_version + 1, 'checksum', v_checksum, 'published_at', now());
end;
$$;
revoke all on function public.publish_app_content_locale(text, bigint, uuid, text) from public;
revoke all on function public.publish_app_content_locale(text, bigint, uuid, text) from anon;
revoke all on function public.publish_app_content_locale(text, bigint, uuid, text) from authenticated;
revoke all on function public.rollback_app_content_locale(text, uuid, bigint, uuid, text) from public;
revoke all on function public.rollback_app_content_locale(text, uuid, bigint, uuid, text) from anon;
revoke all on function public.rollback_app_content_locale(text, uuid, bigint, uuid, text) from authenticated;
grant execute on function public.publish_app_content_locale(text, bigint, uuid, text) to service_role;
grant execute on function public.rollback_app_content_locale(text, uuid, bigint, uuid, text) to service_role;
