alter table public.stylists
  add column if not exists intelligent_scheduling_enabled boolean not null default true;

update public.stylists
set intelligent_scheduling_enabled = true
where intelligent_scheduling_enabled is null;
