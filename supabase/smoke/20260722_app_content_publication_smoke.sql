-- Run manually after migrations 001 through 003. This check is read-only.

begin;

do $$
begin
  if not exists (
    select 1 from public.app_content_locale_state
    where locale = 'en-US' and active_version = 0 and active_revision_id is null
  ) then
    raise exception 'The initial en-US app-content locale state is missing or invalid';
  end if;

  if not exists (
    select 1
    from pg_proc procedure_row
    join pg_namespace namespace_row on namespace_row.oid = procedure_row.pronamespace
    where namespace_row.nspname = 'public'
      and procedure_row.proname = 'publish_app_content_locale'
      and pg_get_function_identity_arguments(procedure_row.oid) = 'p_locale text, p_expected_active_version bigint, p_actor_user_id uuid, p_actor_admin_email text'
  ) then
    raise exception 'publish_app_content_locale(text, bigint, uuid, text) is missing';
  end if;

  if not exists (
    select 1
    from pg_proc procedure_row
    join pg_namespace namespace_row on namespace_row.oid = procedure_row.pronamespace
    where namespace_row.nspname = 'public'
      and procedure_row.proname = 'rollback_app_content_locale'
      and pg_get_function_identity_arguments(procedure_row.oid) = 'p_locale text, p_target_revision_id uuid, p_expected_active_version bigint, p_actor_user_id uuid, p_actor_admin_email text'
  ) then
    raise exception 'rollback_app_content_locale(text, uuid, bigint, uuid, text) is missing';
  end if;

  if not has_function_privilege('service_role', 'public.publish_app_content_locale(text, bigint, uuid, text)', 'execute')
    or has_function_privilege('anon', 'public.publish_app_content_locale(text, bigint, uuid, text)', 'execute')
    or has_function_privilege('authenticated', 'public.publish_app_content_locale(text, bigint, uuid, text)', 'execute')
    or not has_function_privilege('service_role', 'public.rollback_app_content_locale(text, uuid, bigint, uuid, text)', 'execute')
    or has_function_privilege('anon', 'public.rollback_app_content_locale(text, uuid, bigint, uuid, text)', 'execute')
    or has_function_privilege('authenticated', 'public.rollback_app_content_locale(text, uuid, bigint, uuid, text)', 'execute') then
    raise exception 'Unexpected app-content publication function privileges';
  end if;

  raise notice 'PASS: app-content publication migration is ready';
end
$$;

rollback;
