alter table public.client_formulas add column if not exists purge_after timestamptz;
create index if not exists client_formulas_purge_after_idx on public.client_formulas(purge_after) where deleted_at is not null and purge_after is not null;
