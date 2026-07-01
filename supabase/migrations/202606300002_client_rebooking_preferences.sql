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

create index if not exists client_rebooking_preferences_user_id_idx
  on public.client_rebooking_preferences(user_id);
create index if not exists client_rebooking_preferences_client_id_idx
  on public.client_rebooking_preferences(client_id);

alter table public.client_rebooking_preferences enable row level security;

drop policy if exists client_rebooking_preferences_select_own on public.client_rebooking_preferences;
create policy client_rebooking_preferences_select_own
  on public.client_rebooking_preferences
  for select
  using (auth.uid() = user_id);

drop policy if exists client_rebooking_preferences_insert_own on public.client_rebooking_preferences;
create policy client_rebooking_preferences_insert_own
  on public.client_rebooking_preferences
  for insert
  with check (auth.uid() = user_id);

drop policy if exists client_rebooking_preferences_update_own on public.client_rebooking_preferences;
create policy client_rebooking_preferences_update_own
  on public.client_rebooking_preferences
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists client_rebooking_preferences_delete_own on public.client_rebooking_preferences;
create policy client_rebooking_preferences_delete_own
  on public.client_rebooking_preferences
  for delete
  using (auth.uid() = user_id);

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
