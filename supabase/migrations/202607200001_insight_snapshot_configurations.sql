create table if not exists public.insight_snapshot_configurations (
  id uuid primary key default gen_random_uuid(),
  configuration_version integer not null,
  is_active boolean not null default false,
  enabled boolean not null default true,
  pages jsonb not null,
  target_plan_tiers text[],
  rollout_percentage integer not null default 100,
  updated_by text not null default 'system',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint insight_snapshot_configurations_version_check check (configuration_version > 0),
  constraint insight_snapshot_configurations_pages_array_check check (jsonb_typeof(pages) = 'array'),
  constraint insight_snapshot_configurations_rollout_check check (rollout_percentage between 0 and 100),
  constraint insight_snapshot_configurations_plan_tiers_check check (
    target_plan_tiers is null
    or target_plan_tiers <@ array['basic', 'pro', 'premium']::text[]
  ),
  constraint insight_snapshot_configurations_updated_by_check check (char_length(trim(updated_by)) between 1 and 255)
);

create unique index if not exists insight_snapshot_configurations_one_active_idx
  on public.insight_snapshot_configurations ((is_active))
  where is_active;

create or replace function public.set_insight_snapshot_configuration_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_insight_snapshot_configuration_updated_at on public.insight_snapshot_configurations;
create trigger set_insight_snapshot_configuration_updated_at
  before update on public.insight_snapshot_configurations
  for each row
  execute function public.set_insight_snapshot_configuration_updated_at();

alter table public.insight_snapshot_configurations enable row level security;
revoke all on table public.insight_snapshot_configurations from anon, authenticated;
grant select, insert, update, delete on table public.insight_snapshot_configurations to service_role;

insert into public.insight_snapshot_configurations (
  id,
  configuration_version,
  is_active,
  enabled,
  pages,
  target_plan_tiers,
  rollout_percentage,
  updated_by
)
select
  '20260720-0000-4000-8000-000000000001'::uuid,
  1,
  true,
  true,
  '[
    {
      "id": "business_performance",
      "title": "Business Performance",
      "layout": "grid_2x2",
      "period_behavior": "selected_period",
      "enabled": true,
      "metrics": [
        { "metric_id": "booked_revenue", "enabled": true },
        { "metric_id": "appointments_booked", "enabled": true },
        { "metric_id": "rebooking_rate", "enabled": true },
        { "metric_id": "average_ticket", "enabled": true }
      ]
    }
  ]'::jsonb,
  null,
  100,
  'system:initial-insights-configuration'
where not exists (
  select 1 from public.insight_snapshot_configurations where is_active
)
on conflict (id) do nothing;
