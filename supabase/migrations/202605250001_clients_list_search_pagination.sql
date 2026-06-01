create extension if not exists pg_trgm;

create index if not exists clients_user_updated_at_idx
  on public.clients(user_id, updated_at desc, id);

create index if not exists clients_user_name_idx
  on public.clients(user_id, last_name, first_name, id);

create index if not exists clients_user_total_spend_idx
  on public.clients(user_id, total_spend desc, id);

create index if not exists clients_user_last_visit_at_idx
  on public.clients(user_id, last_visit_at desc, id);

create index if not exists clients_user_first_name_trgm_idx
  on public.clients using gin (first_name gin_trgm_ops);

create index if not exists clients_user_last_name_trgm_idx
  on public.clients using gin (last_name gin_trgm_ops);

create index if not exists clients_user_preferred_name_trgm_idx
  on public.clients using gin (preferred_name gin_trgm_ops);

create index if not exists clients_user_email_trgm_idx
  on public.clients using gin (email gin_trgm_ops);

create index if not exists clients_user_phone_trgm_idx
  on public.clients using gin (phone gin_trgm_ops);

create index if not exists clients_user_phone_normalized_trgm_idx
  on public.clients using gin (phone_normalized gin_trgm_ops);

create index if not exists clients_user_instagram_trgm_idx
  on public.clients using gin (instagram gin_trgm_ops);

create index if not exists clients_user_notes_trgm_idx
  on public.clients using gin (notes gin_trgm_ops);

create index if not exists clients_tags_gin_idx
  on public.clients using gin (tags);
