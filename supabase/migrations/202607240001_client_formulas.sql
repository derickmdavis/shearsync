-- Client formula parent records. This migration is additive and safe to run independently.

create table if not exists public.client_formulas (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  appointment_id uuid references public.appointments(id) on delete set null,
  service_id uuid references public.services(id) on delete set null,
  title text not null,
  formula_date date not null,
  service_name_snapshot text not null,
  processing_notes text,
  result_notes text,
  created_by uuid not null references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint client_formulas_title_length_check
    check (char_length(trim(title)) between 1 and 160),
  constraint client_formulas_service_name_snapshot_length_check
    check (char_length(trim(service_name_snapshot)) between 1 and 160),
  constraint client_formulas_processing_notes_length_check
    check (processing_notes is null or char_length(processing_notes) <= 5000),
  constraint client_formulas_result_notes_length_check
    check (result_notes is null or char_length(result_notes) <= 5000)
);

create index if not exists client_formulas_user_client_history_idx
  on public.client_formulas(user_id, client_id, formula_date desc, created_at desc, id desc)
  where deleted_at is null;
create index if not exists client_formulas_client_created_at_idx
  on public.client_formulas(client_id, created_at desc)
  where deleted_at is null;
create index if not exists client_formulas_appointment_id_idx
  on public.client_formulas(appointment_id)
  where appointment_id is not null;
create index if not exists client_formulas_service_id_idx
  on public.client_formulas(service_id)
  where service_id is not null;

alter table public.client_formulas enable row level security;
