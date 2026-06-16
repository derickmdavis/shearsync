alter table public.clients
  add column if not exists purge_after timestamptz;

create index if not exists clients_user_active_updated_at_idx
  on public.clients(user_id, updated_at desc, id)
  where deleted_at is null;

create index if not exists clients_purge_after_idx
  on public.clients(purge_after)
  where purge_after is not null;
