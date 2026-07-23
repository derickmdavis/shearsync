-- Run manually in the Supabase SQL editor after
-- 202607220001_app_content_foundation.sql. This check is read-only.

begin;

do $$
declare
  missing_tables text[];
  missing_indexes text[];
  missing_triggers text[];
  rls_disabled_tables text[];
begin
  select array_agg(required_table order by required_table)
  into missing_tables
  from unnest(array[
    'app_content_definitions',
    'app_content_locale_state',
    'app_content_drafts',
    'app_content_revisions',
    'app_content_revision_entries',
    'app_content_audit_events'
  ]) as required_table
  where to_regclass('public.' || required_table) is null;

  if missing_tables is not null then
    raise exception 'Missing app-content tables: %', missing_tables;
  end if;

  select array_agg(required_table order by required_table)
  into rls_disabled_tables
  from unnest(array[
    'app_content_definitions',
    'app_content_locale_state',
    'app_content_drafts',
    'app_content_revisions',
    'app_content_revision_entries',
    'app_content_audit_events'
  ]) as required_table
  join pg_class relation on relation.oid = ('public.' || required_table)::regclass
  where not relation.relrowsecurity;

  if rls_disabled_tables is not null then
    raise exception 'RLS is not enabled for app-content tables: %', rls_disabled_tables;
  end if;

  select array_agg(required_index order by required_index)
  into missing_indexes
  from unnest(array[
    'app_content_definitions_namespace_active_idx',
    'app_content_drafts_locale_updated_idx',
    'app_content_revisions_locale_published_idx',
    'app_content_revision_entries_definition_idx',
    'app_content_audit_events_locale_created_idx',
    'app_content_audit_events_definition_created_idx',
    'app_content_audit_events_revision_idx'
  ]) as required_index
  where to_regclass('public.' || required_index) is null;

  if missing_indexes is not null then
    raise exception 'Missing app-content indexes: %', missing_indexes;
  end if;

  select array_agg(required_trigger order by required_trigger)
  into missing_triggers
  from unnest(array[
    'app_content_definitions_prevent_key_update',
    'app_content_revisions_immutable',
    'app_content_revision_entries_immutable',
    'app_content_audit_events_immutable'
  ]) as required_trigger
  where not exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgname = required_trigger
      and not trigger_row.tgisinternal
  );

  if missing_triggers is not null then
    raise exception 'Missing app-content immutability triggers: %', missing_triggers;
  end if;

  if has_table_privilege('authenticated', 'public.app_content_definitions', 'select')
    or has_table_privilege('anon', 'public.app_content_definitions', 'select')
    or not has_table_privilege('service_role', 'public.app_content_definitions', 'select') then
    raise exception 'Unexpected app-content definitions table privileges';
  end if;

  if has_table_privilege('authenticated', 'public.app_content_drafts', 'select')
    or has_table_privilege('anon', 'public.app_content_revisions', 'select')
    or not has_table_privilege('service_role', 'public.app_content_audit_events', 'insert') then
    raise exception 'Unexpected app-content draft/revision/audit table privileges';
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'app_content_locale_state_active_revision_fkey'
      and conrelid = 'public.app_content_locale_state'::regclass
  ) then
    raise exception 'The active revision foreign key is missing';
  end if;

  raise notice 'PASS: app-content foundation migration is ready';
end
$$;

rollback;
