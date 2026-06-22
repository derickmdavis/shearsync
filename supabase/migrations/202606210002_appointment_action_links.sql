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

alter table public.appointment_action_links enable row level security;

drop policy if exists appointment_action_links_select_own on public.appointment_action_links;
create policy appointment_action_links_select_own
  on public.appointment_action_links
  for select
  using (auth.uid() = user_id);

drop policy if exists appointment_action_links_insert_own on public.appointment_action_links;
create policy appointment_action_links_insert_own
  on public.appointment_action_links
  for insert
  with check (auth.uid() = user_id);

drop policy if exists appointment_action_links_update_own on public.appointment_action_links;
create policy appointment_action_links_update_own
  on public.appointment_action_links
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
