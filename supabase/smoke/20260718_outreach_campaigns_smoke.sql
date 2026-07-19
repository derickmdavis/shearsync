-- Run manually in the Supabase SQL editor after migrations 001-009.
-- This is read-only and fails fast with a descriptive exception.

begin;

do $$
declare
  missing_tables text[];
  missing_indexes text[];
  invalid_template_count integer;
  marker_version text;
begin
  select array_agg(required_table order by required_table)
  into missing_tables
  from unnest(array[
    'campaign_templates',
    'campaigns',
    'campaign_runs',
    'campaign_audience_selections',
    'campaign_recipients',
    'campaign_idempotency_records',
    'campaign_delivery_events',
    'outreach_schema_versions'
  ]) as required_table
  where to_regclass('public.' || required_table) is null;

  if missing_tables is not null then
    raise exception 'Missing outreach tables: %', missing_tables;
  end if;

  select version into marker_version
  from public.outreach_schema_versions
  where component = 'campaign_authoring';

  if marker_version is distinct from 'campaign_delivery_analytics_2026_07_18' then
    raise exception 'Unexpected campaign_authoring schema marker: %', marker_version;
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'create_campaign_draft'
      and pg_get_function_identity_arguments(p.oid) = 'p_user_id uuid, p_timezone text, p_template_id uuid'
  ) then
    raise exception 'create_campaign_draft(uuid, text, uuid) is missing';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'claim_campaign_recipients'
  ) or not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'finalize_campaign_runs'
  ) then
    raise exception 'Campaign delivery functions are missing';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_campaign_reporting_summaries'
  ) then
    raise exception 'Campaign reporting function is missing';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_campaign_reporting_summaries_v2'
  ) then
    raise exception 'Campaign analytics reporting function is missing';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'submit_campaign'
  ) or not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'cancel_campaign_submission'
  ) then
    raise exception 'Campaign submission, cancellation, or delivery functions are missing';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_campaign_draft'
  ) then
    raise exception 'update_campaign_draft is missing';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.campaigns'::regclass
      and tgname = 'campaigns_create_initial_run'
      and not tgisinternal
  ) then
    raise exception 'Campaign initial-run trigger is missing';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.campaign_runs'::regclass
      and tgname = 'campaign_runs_require_initial'
      and not tgisinternal
  ) then
    raise exception 'Campaign initial-run constraint trigger is missing';
  end if;

  select array_agg(required_index order by required_index)
  into missing_indexes
  from unnest(array[
    'campaign_runs_due_idx',
    'campaign_runs_user_status_idx',
    'campaign_recipients_run_status_idx',
    'campaign_recipients_user_status_idx'
  ]) as required_index
  where to_regclass('public.' || required_index) is null;

  if missing_indexes is not null then
    raise exception 'Missing campaign query indexes: %', missing_indexes;
  end if;

  if exists (
    select 1
    from unnest(array[
      'campaigns',
      'campaign_runs',
      'campaign_audience_selections',
      'campaign_recipients',
      'campaign_idempotency_records',
      'campaign_delivery_events',
      'outreach_schema_versions'
    ]) as required_rls_table
    join pg_class c on c.oid = ('public.' || required_rls_table)::regclass
    where not c.relrowsecurity
  ) then
    raise exception 'RLS is not enabled on every campaign-owned/readiness table';
  end if;

  select count(*) into invalid_template_count
  from public.campaign_templates
  where id in (
    '10000000-0000-4000-8000-000000000001'::uuid,
    '10000000-0000-4000-8000-000000000002'::uuid,
    '10000000-0000-4000-8000-000000000003'::uuid
  )
  -- Use chr(92) rather than a SQL string containing a backslash: the latter
  -- depends on the current standard_conforming_strings setting.
  and (
    position(chr(92) || 'n' in message) > 0
    or position(chr(10) || chr(10) in message) = 0
  );

  if invalid_template_count <> 0 then
    raise exception '% seeded campaign template(s) contain escaped or missing paragraph newlines', invalid_template_count;
  end if;

  if (select count(*) from public.campaign_templates where id in (
    '10000000-0000-4000-8000-000000000001'::uuid,
    '10000000-0000-4000-8000-000000000002'::uuid,
    '10000000-0000-4000-8000-000000000003'::uuid
  )) <> 3 then
    raise exception 'One or more version-1 campaign templates are missing';
  end if;

  raise notice 'PASS: outreach campaign migrations 002-009 are ready';
end
$$;

rollback;
