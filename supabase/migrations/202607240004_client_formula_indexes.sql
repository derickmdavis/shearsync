-- Formula query and ordering indexes. Safe to run independently or after prior formula migrations.

create index if not exists client_formulas_user_client_history_idx
  on public.client_formulas(user_id, client_id, formula_date desc, created_at desc, id desc)
  where deleted_at is null;

create index if not exists client_formulas_client_created_at_idx
  on public.client_formulas(client_id, created_at desc)
  where deleted_at is null;

create index if not exists client_formula_sections_formula_sort_order_idx
  on public.client_formula_sections(formula_id, sort_order);

create index if not exists client_formula_photos_formula_sort_order_idx
  on public.client_formula_photos(formula_id, sort_order);

create index if not exists client_formulas_appointment_id_idx
  on public.client_formulas(appointment_id)
  where appointment_id is not null;
