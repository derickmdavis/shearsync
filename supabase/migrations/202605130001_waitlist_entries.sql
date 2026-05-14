alter table public.users
  add column if not exists plan_tier text not null default 'basic',
  add column if not exists plan_status text not null default 'active',
  add column if not exists sms_monthly_limit integer not null default 0,
  add column if not exists sms_used_this_month integer not null default 0,
  add column if not exists plan_updated_at timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'users_plan_tier_check'
      and conrelid = 'public.users'::regclass
  ) then
    alter table public.users
      add constraint users_plan_tier_check
      check (plan_tier in ('basic', 'pro', 'premium'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'users_plan_status_check'
      and conrelid = 'public.users'::regclass
  ) then
    alter table public.users
      add constraint users_plan_status_check
      check (plan_status in ('trialing', 'active', 'past_due', 'cancelled'));
  end if;
end
$$;

create table if not exists public.waitlist_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id uuid null references public.clients(id) on delete set null,
  service_id uuid null references public.services(id) on delete set null,
  requested_date date not null,
  requested_time_preference text null,
  client_name text not null,
  client_email text null,
  client_phone text null,
  note text null,
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

create index if not exists waitlist_entries_user_id_idx
  on public.waitlist_entries(user_id);

create index if not exists waitlist_entries_user_date_idx
  on public.waitlist_entries(user_id, requested_date);

create index if not exists waitlist_entries_user_status_idx
  on public.waitlist_entries(user_id, status);

create index if not exists waitlist_entries_user_created_at_idx
  on public.waitlist_entries(user_id, created_at desc);

alter table public.waitlist_entries enable row level security;

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

