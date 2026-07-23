-- Atomic, complete-locale publication and rollback for server-driven app copy.

insert into public.app_content_locale_state (locale, active_version, updated_by_admin_email)
values ('en-US', 0, 'system')
on conflict (locale) do nothing;

create or replace function public.publish_app_content_locale(
  p_locale text,
  p_expected_active_version bigint,
  p_actor_user_id uuid,
  p_actor_admin_email text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state public.app_content_locale_state%rowtype;
  v_revision_id uuid;
  v_checksum text;
  v_missing_keys text[];
  v_invalid_entries jsonb;
  v_active_definition_count integer;
begin
  select * into v_state
  from public.app_content_locale_state
  where locale = p_locale
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'app_content_locale_not_found';
  end if;

  if v_state.active_version <> p_expected_active_version then
    raise exception using errcode = 'P0001', message = 'app_content_locale_version_conflict',
      detail = jsonb_build_object('current_active_version', v_state.active_version)::text;
  end if;

  select count(*) into v_active_definition_count
  from public.app_content_definitions
  where is_active;

  if v_active_definition_count = 0 then
    raise exception using errcode = 'P0001', message = 'app_content_publish_no_active_definitions';
  end if;

  select array_agg(definition.key order by definition.key)
  into v_missing_keys
  from public.app_content_definitions definition
  left join public.app_content_drafts draft
    on draft.definition_key = definition.key
   and draft.locale = p_locale
  where definition.is_active
    and draft.definition_key is null;

  if v_missing_keys is not null then
    raise exception using errcode = 'P0001', message = 'app_content_publish_missing_drafts',
      detail = jsonb_build_object('missing_keys', v_missing_keys)::text;
  end if;

  select jsonb_agg(jsonb_build_object('key', definition.key, 'reason', invalid.reason) order by definition.key)
  into v_invalid_entries
  from public.app_content_definitions definition
  join public.app_content_drafts draft
    on draft.definition_key = definition.key
   and draft.locale = p_locale
  cross join lateral (
    select case
      when char_length(trim(draft.value)) = 0 then 'blank'
      when char_length(draft.value) > definition.max_length then 'length'
      when not definition.multiline_allowed and position(chr(10) in draft.value) > 0 then 'newline'
      when draft.value ~ '[<>]' then 'markup'
      when regexp_replace(draft.value, $placeholder$\{\{[a-z][a-zA-Z0-9]*\}\}$placeholder$, '', 'g') ~ '[{}]' then 'malformed_placeholder'
      when exists (
        select 1
        from regexp_matches(draft.value, $placeholder$\{\{([a-z][a-zA-Z0-9]*)\}\}$placeholder$, 'g') as placeholder_match
        where not (placeholder_match[1] = any(definition.allowed_placeholders))
      ) then 'unknown_placeholder'
      when regexp_replace(draft.value, chr(10), '', 'g') ~ '[[:cntrl:]]' then 'control_character'
      else null
    end as reason
  ) invalid
  where definition.is_active
    and invalid.reason is not null;

  if v_invalid_entries is not null then
    raise exception using errcode = 'P0001', message = 'app_content_publish_invalid_drafts',
      detail = jsonb_build_object('invalid_entries', v_invalid_entries)::text;
  end if;

  select encode(
    digest(
      string_agg(definition.key || chr(31) || draft.value, chr(30) order by definition.key),
      'sha256'
    ),
    'hex'
  )
  into v_checksum
  from public.app_content_definitions definition
  join public.app_content_drafts draft
    on draft.definition_key = definition.key
   and draft.locale = p_locale
  where definition.is_active;

  insert into public.app_content_revisions (
    locale, version, kind, checksum, published_by_admin_email, published_by_user_id
  ) values (
    p_locale, v_state.active_version + 1, 'publish', v_checksum, p_actor_admin_email, p_actor_user_id
  ) returning id into v_revision_id;

  insert into public.app_content_revision_entries (revision_id, definition_key, value)
  select v_revision_id, definition.key, draft.value
  from public.app_content_definitions definition
  join public.app_content_drafts draft
    on draft.definition_key = definition.key
   and draft.locale = p_locale
  where definition.is_active
  order by definition.key;

  update public.app_content_locale_state
  set
    active_revision_id = v_revision_id,
    active_version = v_state.active_version + 1,
    updated_by_admin_email = p_actor_admin_email,
    updated_by_user_id = p_actor_user_id
  where locale = p_locale;

  insert into public.app_content_audit_events (
    event_type, locale, revision_id, actor_user_id, actor_admin_email, metadata
  ) values (
    'published', p_locale, v_revision_id, p_actor_user_id, p_actor_admin_email,
    jsonb_build_object('version', v_state.active_version + 1, 'checksum', v_checksum)
  );

  return jsonb_build_object(
    'revision_id', v_revision_id,
    'locale', p_locale,
    'version', v_state.active_version + 1,
    'checksum', v_checksum,
    'published_at', now()
  );
end;
$$;

create or replace function public.rollback_app_content_locale(
  p_locale text,
  p_target_revision_id uuid,
  p_expected_active_version bigint,
  p_actor_user_id uuid,
  p_actor_admin_email text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state public.app_content_locale_state%rowtype;
  v_target public.app_content_revisions%rowtype;
  v_revision_id uuid;
  v_checksum text;
  v_missing_keys text[];
begin
  select * into v_state
  from public.app_content_locale_state
  where locale = p_locale
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'app_content_locale_not_found';
  end if;

  if v_state.active_version <> p_expected_active_version then
    raise exception using errcode = 'P0001', message = 'app_content_locale_version_conflict',
      detail = jsonb_build_object('current_active_version', v_state.active_version)::text;
  end if;

  select * into v_target
  from public.app_content_revisions
  where id = p_target_revision_id
    and locale = p_locale;

  if not found then
    raise exception using errcode = 'P0002', message = 'app_content_revision_not_found';
  end if;

  select array_agg(definition.key order by definition.key)
  into v_missing_keys
  from public.app_content_definitions definition
  left join public.app_content_revision_entries entry
    on entry.revision_id = v_target.id
   and entry.definition_key = definition.key
  where definition.is_active
    and entry.definition_key is null;

  if v_missing_keys is not null then
    raise exception using errcode = 'P0001', message = 'app_content_rollback_missing_active_keys',
      detail = jsonb_build_object('missing_keys', v_missing_keys)::text;
  end if;

  select encode(
    digest(string_agg(entry.definition_key || chr(31) || entry.value, chr(30) order by entry.definition_key), 'sha256'),
    'hex'
  )
  into v_checksum
  from public.app_content_revision_entries entry
  join public.app_content_definitions definition on definition.key = entry.definition_key
  where entry.revision_id = v_target.id
    and definition.is_active;

  insert into public.app_content_revisions (
    locale, version, kind, source_revision_id, checksum, published_by_admin_email, published_by_user_id
  ) values (
    p_locale, v_state.active_version + 1, 'rollback', v_target.id, v_checksum, p_actor_admin_email, p_actor_user_id
  ) returning id into v_revision_id;

  insert into public.app_content_revision_entries (revision_id, definition_key, value)
  select v_revision_id, entry.definition_key, entry.value
  from public.app_content_revision_entries entry
  join public.app_content_definitions definition on definition.key = entry.definition_key
  where entry.revision_id = v_target.id
    and definition.is_active
  order by entry.definition_key;

  update public.app_content_locale_state
  set
    active_revision_id = v_revision_id,
    active_version = v_state.active_version + 1,
    updated_by_admin_email = p_actor_admin_email,
    updated_by_user_id = p_actor_user_id
  where locale = p_locale;

  insert into public.app_content_audit_events (
    event_type, locale, revision_id, actor_user_id, actor_admin_email, metadata
  ) values (
    'rolled_back', p_locale, v_revision_id, p_actor_user_id, p_actor_admin_email,
    jsonb_build_object('version', v_state.active_version + 1, 'target_revision_id', v_target.id, 'checksum', v_checksum)
  );

  return jsonb_build_object(
    'revision_id', v_revision_id,
    'source_revision_id', v_target.id,
    'locale', p_locale,
    'version', v_state.active_version + 1,
    'checksum', v_checksum,
    'published_at', now()
  );
end;
$$;

revoke all on function public.publish_app_content_locale(text, bigint, uuid, text) from public;
revoke all on function public.rollback_app_content_locale(text, uuid, bigint, uuid, text) from public;
grant execute on function public.publish_app_content_locale(text, bigint, uuid, text) to service_role;
grant execute on function public.rollback_app_content_locale(text, uuid, bigint, uuid, text) to service_role;
