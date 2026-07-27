alter table public.insight_snapshot_configurations
  drop constraint if exists insight_snapshot_configurations_plan_tiers_check,
  drop column if exists target_plan_tiers;
