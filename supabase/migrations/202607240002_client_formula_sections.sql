-- Ordered, normalized content sections for client formulas.

create table if not exists public.client_formula_sections (
  id uuid primary key default gen_random_uuid(),
  formula_id uuid not null references public.client_formulas(id) on delete cascade,
  type text not null,
  custom_label text,
  content text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint client_formula_sections_type_check
    check (type in ('formula', 'application', 'processing', 'result', 'aftercare', 'custom')),
  constraint client_formula_sections_custom_label_check
    check (
      (type = 'custom' and custom_label is not null and char_length(trim(custom_label)) between 1 and 120)
      or (type <> 'custom' and custom_label is null)
    ),
  constraint client_formula_sections_content_length_check
    check (char_length(trim(content)) between 1 and 5000),
  constraint client_formula_sections_sort_order_check
    check (sort_order >= 0)
);

create index if not exists client_formula_sections_formula_sort_order_idx
  on public.client_formula_sections(formula_id, sort_order);

alter table public.client_formula_sections enable row level security;
