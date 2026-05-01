alter table public.clients
  add column if not exists total_spend numeric(10, 2) default 0,
  add column if not exists last_visit_at timestamptz;
