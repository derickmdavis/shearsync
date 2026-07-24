-- Additive styling semantics for formula cards. Legacy type/custom_label remain supported.

alter table public.client_formulas
  alter column service_name_snapshot drop not null,
  add column if not exists title_source text not null default 'user';

alter table public.client_formulas
  drop constraint if exists client_formulas_title_source_check;
alter table public.client_formulas
  add constraint client_formulas_title_source_check
  check (title_source in ('user', 'service_fallback', 'date_fallback'));

alter table public.client_formula_sections
  add column if not exists section_kind text,
  add column if not exists display_label text;

alter table public.client_formula_sections
  drop constraint if exists client_formula_sections_section_kind_check;
alter table public.client_formula_sections
  add constraint client_formula_sections_section_kind_check
  check (section_kind is null or section_kind in ('root', 'lightener', 'toner', 'gloss', 'color', 'mid_lengths', 'ends', 'custom'));

alter table public.client_formula_sections
  drop constraint if exists client_formula_sections_display_label_length_check;
alter table public.client_formula_sections
  add constraint client_formula_sections_display_label_length_check
  check (display_label is null or char_length(trim(display_label)) between 1 and 120);

update public.client_formula_sections
set
  section_kind = 'custom',
  display_label = coalesce(nullif(trim(custom_label), ''), 'Formula')
where section_kind is null;
