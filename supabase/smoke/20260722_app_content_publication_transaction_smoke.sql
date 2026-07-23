-- Run manually after migrations 001-003. It temporarily writes test rows,
-- verifies publication/rollback behavior, then rolls everything back.

begin;

do $$
declare
  first_publish jsonb;
  second_publish jsonb;
  rollback_publish jsonb;
  first_revision_id uuid;
  active_revision_id uuid;
  active_version bigint;
  active_value text;
  stale_publish_rejected boolean := false;
  invalid_publish_rejected boolean := false;
begin
  if exists (
    select 1 from public.app_content_locale_state
    where locale = 'en-US' and (active_version <> 0 or active_revision_id is not null)
  ) then
    raise exception 'Run this transactional smoke test only before creating real app-content publications';
  end if;

  insert into public.app_content_definitions (
    key, namespace, category, description, max_length, multiline_allowed,
    created_by_admin_email, updated_by_admin_email
  ) values (
    'smoke.content.title', 'smoke', 'screen', 'Transactional publication smoke-test key.', 80, false,
    'smoke@example.invalid', 'smoke@example.invalid'
  );

  insert into public.app_content_drafts (
    definition_key, locale, value, draft_version, validation_status, updated_by_admin_email
  ) values (
    'smoke.content.title', 'en-US', 'First value', 1, 'valid', 'smoke@example.invalid'
  );

  first_publish := public.publish_app_content_locale('en-US', 0, null, 'smoke@example.invalid');
  first_revision_id := (first_publish ->> 'revision_id')::uuid;

  update public.app_content_drafts
  set value = 'Second value', draft_version = 2, updated_by_admin_email = 'smoke@example.invalid'
  where definition_key = 'smoke.content.title' and locale = 'en-US';
  second_publish := public.publish_app_content_locale('en-US', 1, null, 'smoke@example.invalid');

  begin
    perform public.publish_app_content_locale('en-US', 1, null, 'smoke@example.invalid');
  exception when others then
    stale_publish_rejected := sqlerrm like '%app_content_locale_version_conflict%';
  end;

  if not stale_publish_rejected then
    raise exception 'A stale publication attempt was not rejected';
  end if;

  update public.app_content_drafts
  set value = '<invalid>', draft_version = 3, updated_by_admin_email = 'smoke@example.invalid'
  where definition_key = 'smoke.content.title' and locale = 'en-US';
  begin
    perform public.publish_app_content_locale('en-US', 2, null, 'smoke@example.invalid');
  exception when others then
    invalid_publish_rejected := sqlerrm like '%app_content_publish_invalid_drafts%';
  end;

  if not invalid_publish_rejected then
    raise exception 'An invalid publication attempt was not rejected';
  end if;

  select state.active_revision_id, state.active_version into active_revision_id, active_version
  from public.app_content_locale_state state where state.locale = 'en-US';
  if active_revision_id <> (second_publish ->> 'revision_id')::uuid or active_version <> 2 then
    raise exception 'Invalid publication changed the active revision pointer';
  end if;

  rollback_publish := public.rollback_app_content_locale('en-US', first_revision_id, 2, null, 'smoke@example.invalid');
  select entry.value into active_value
  from public.app_content_locale_state state
  join public.app_content_revision_entries entry on entry.revision_id = state.active_revision_id
  where state.locale = 'en-US' and entry.definition_key = 'smoke.content.title';

  if active_value <> 'First value' or (rollback_publish ->> 'version')::bigint <> 3 then
    raise exception 'Rollback did not create a higher revision with the selected historic value';
  end if;

  begin
    update public.app_content_revisions
    set checksum = repeat('0', 64)
    where id = first_revision_id;
    raise exception 'Published revisions must be immutable';
  exception when others then
    if sqlerrm not like '%app_content_immutable_row%' then raise; end if;
  end;

  raise notice 'PASS: app-content publication transaction smoke test is ready';
end
$$;

rollback;
