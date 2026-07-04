create table if not exists public.birthday_reminder_settings (
  user_id uuid primary key references public.users(id) on delete cascade,
  approval_required boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists birthday_reminder_settings_user_id_idx
  on public.birthday_reminder_settings(user_id);

alter table public.birthday_reminder_settings enable row level security;

drop policy if exists birthday_reminder_settings_select_own on public.birthday_reminder_settings;
create policy birthday_reminder_settings_select_own
  on public.birthday_reminder_settings
  for select
  using (auth.uid() = user_id);

drop policy if exists birthday_reminder_settings_insert_own on public.birthday_reminder_settings;
create policy birthday_reminder_settings_insert_own
  on public.birthday_reminder_settings
  for insert
  with check (auth.uid() = user_id);

drop policy if exists birthday_reminder_settings_update_own on public.birthday_reminder_settings;
create policy birthday_reminder_settings_update_own
  on public.birthday_reminder_settings
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create or replace function public.set_birthday_reminder_settings_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_birthday_reminder_settings_updated_at
  on public.birthday_reminder_settings;

create trigger set_birthday_reminder_settings_updated_at
  before update on public.birthday_reminder_settings
  for each row
  execute function public.set_birthday_reminder_settings_updated_at();

alter table public.birthday_reminders
  drop constraint if exists birthday_reminders_status_check;

alter table public.birthday_reminders
  add constraint birthday_reminders_status_check
  check (
    status in (
      'pending_approval',
      'queued',
      'sending',
      'sent',
      'cancelled',
      'skipped',
      'failed'
    )
  );

drop index if exists public.birthday_reminders_active_client_year_idx;

create unique index birthday_reminders_active_client_year_idx
  on public.birthday_reminders(user_id, client_id, birthday_occurrence_date)
  where status in ('pending_approval', 'queued', 'sending', 'failed');
