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

create index if not exists stylist_off_days_user_id_idx
  on public.stylist_off_days(user_id);

create index if not exists stylist_off_days_user_date_idx
  on public.stylist_off_days(user_id, date);

alter table public.stylist_off_days enable row level security;

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
