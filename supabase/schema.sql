create table if not exists public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique not null,
  full_name text,
  phone_number text,
  business_name text,
  timezone text not null default 'UTC',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  first_name text not null,
  last_name text not null,
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
  total_spend numeric(10, 2),
  last_visit_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.appointments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  appointment_date timestamptz not null,
  service_name text not null,
  duration_minutes integer not null,
  price numeric(10, 2) default 0,
  notes text,
  status text not null default 'scheduled',
  booking_source text not null default 'internal' check (booking_source in ('public', 'internal')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.photos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  file_path text not null,
  photo_type text default 'other',
  caption text,
  created_at timestamptz default now()
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
  stylist_id uuid not null references public.users(id) on delete cascade,
  client_id uuid references public.clients(id) on delete set null,
  appointment_id uuid references public.appointments(id) on delete set null,
  activity_type text not null,
  title text not null,
  description text,
  occurred_at timestamptz not null default now(),
  metadata jsonb,
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  check (activity_type in ('booking_created', 'appointment_cancelled', 'appointment_rescheduled', 'reminder_sent'))
);

create table if not exists public.stylists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.users(id) on delete cascade,
  slug text unique not null,
  display_name text not null,
  bio text,
  cover_photo_url text,
  booking_enabled boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.booking_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.users(id) on delete cascade,
  lead_time_hours integer not null default 0,
  same_day_booking_allowed boolean not null default false,
  same_day_booking_cutoff time not null default '17:00:00',
  max_booking_window_days integer not null default 30,
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

create index if not exists clients_user_id_idx on public.clients(user_id);
create index if not exists clients_user_phone_normalized_idx on public.clients(user_id, phone_normalized);
create index if not exists appointments_user_id_date_idx on public.appointments(user_id, appointment_date);
create unique index if not exists appointments_user_id_appointment_date_active_idx
  on public.appointments(user_id, appointment_date)
  where status <> 'cancelled';
create index if not exists photos_user_id_client_id_idx on public.photos(user_id, client_id);
create index if not exists reminders_user_id_due_date_idx on public.reminders(user_id, due_date);
create index if not exists reminders_user_id_sent_at_idx on public.reminders(user_id, sent_at);
create index if not exists booking_rules_user_id_idx on public.booking_rules(user_id);
create index if not exists services_user_id_active_idx on public.services(user_id, is_active);
create index if not exists services_user_id_sort_order_idx on public.services(user_id, sort_order);
create index if not exists availability_user_id_day_idx on public.availability(user_id, day_of_week);
create index if not exists availability_user_id_day_audience_idx on public.availability(user_id, day_of_week, client_audience);
create index if not exists activity_events_stylist_occurred_at_idx on public.activity_events(stylist_id, occurred_at desc, id desc);
create index if not exists activity_events_appointment_id_idx on public.activity_events(appointment_id);
create index if not exists activity_events_client_id_idx on public.activity_events(client_id);
create index if not exists activity_events_activity_type_idx on public.activity_events(activity_type);
create unique index if not exists activity_events_stylist_dedupe_key_idx on public.activity_events(stylist_id, dedupe_key);

alter table public.users enable row level security;
alter table public.clients enable row level security;
alter table public.appointments enable row level security;
alter table public.photos enable row level security;
alter table public.reminders enable row level security;
alter table public.activity_events enable row level security;
alter table public.stylists enable row level security;
alter table public.booking_rules enable row level security;
alter table public.services enable row level security;
alter table public.availability enable row level security;

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
      using (auth.uid() = stylist_id);
  end if;
end
$$;
