-- Run manually after 202607220001_app_content_foundation.sql and
-- 202607220002_app_content_draft_audit.sql. This check is read-only.

begin;

do $$
declare
  missing_triggers text[];
begin
  select array_agg(required_trigger order by required_trigger)
  into missing_triggers
  from unnest(array[
    'app_content_definitions_audit',
    'app_content_drafts_audit'
  ]) as required_trigger
  where not exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgname = required_trigger
      and not trigger_row.tgisinternal
  );

  if missing_triggers is not null then
    raise exception 'Missing app-content audit triggers: %', missing_triggers;
  end if;

  if not exists (
    select 1
    from pg_proc procedure_row
    join pg_namespace namespace_row on namespace_row.oid = procedure_row.pronamespace
    where namespace_row.nspname = 'public'
      and procedure_row.proname = 'record_app_content_definition_audit'
  ) or not exists (
    select 1
    from pg_proc procedure_row
    join pg_namespace namespace_row on namespace_row.oid = procedure_row.pronamespace
    where namespace_row.nspname = 'public'
      and procedure_row.proname = 'record_app_content_draft_audit'
  ) then
    raise exception 'App-content audit functions are missing';
  end if;

  if not has_table_privilege('service_role', 'public.app_content_drafts', 'update')
    or has_table_privilege('authenticated', 'public.app_content_audit_events', 'insert') then
    raise exception 'Unexpected app-content draft/audit privileges';
  end if;

  raise notice 'PASS: app-content draft-management migration is ready';
end
$$;

rollback;
