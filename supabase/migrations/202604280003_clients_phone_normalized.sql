alter table public.clients
  add column if not exists phone_normalized text;

create index if not exists clients_user_phone_normalized_idx
  on public.clients(user_id, phone_normalized);
