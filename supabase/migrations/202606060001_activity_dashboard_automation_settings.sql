create table if not exists public.automation_settings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  key text not null,
  enabled boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint automation_settings_key_check
    check (key in ('rebook_nudges', 'appointment_reminders', 'no_show_follow_up', 'waitlist_match')),
  constraint automation_settings_user_key_unique unique (user_id, key)
);

create index if not exists automation_settings_user_id_idx on public.automation_settings(user_id);

alter table public.automation_settings enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'automation_settings'
      and policyname = 'automation_settings_select_own'
  ) then
    create policy automation_settings_select_own
      on public.automation_settings
      for select
      using (auth.uid() = user_id);
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'automation_settings'
      and policyname = 'automation_settings_insert_own'
  ) then
    create policy automation_settings_insert_own
      on public.automation_settings
      for insert
      with check (auth.uid() = user_id);
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'automation_settings'
      and policyname = 'automation_settings_update_own'
  ) then
    create policy automation_settings_update_own
      on public.automation_settings
      for update
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;
end
$$;
