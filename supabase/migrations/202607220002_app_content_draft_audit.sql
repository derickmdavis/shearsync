-- Draft and definition mutations are audited at the database boundary so
-- service-role writes cannot bypass the append-only audit trail.

create or replace function public.record_app_content_definition_audit()
returns trigger
language plpgsql
as $$
begin
  insert into public.app_content_audit_events (
    event_type,
    definition_key,
    actor_admin_email,
    metadata
  ) values (
    case when tg_op = 'INSERT' then 'definition_created' else 'definition_updated' end,
    new.key,
    case when tg_op = 'INSERT' then new.created_by_admin_email else new.updated_by_admin_email end,
    jsonb_build_object(
      'namespace', new.namespace,
      'category', new.category,
      'is_active', new.is_active
    )
  );
  return new;
end;
$$;

create or replace function public.record_app_content_draft_audit()
returns trigger
language plpgsql
as $$
begin
  insert into public.app_content_audit_events (
    event_type,
    definition_key,
    locale,
    actor_user_id,
    actor_admin_email,
    previous_value,
    new_value,
    metadata
  ) values (
    'draft_updated',
    new.definition_key,
    new.locale,
    new.updated_by_user_id,
    new.updated_by_admin_email,
    case when tg_op = 'UPDATE' then old.value else null end,
    new.value,
    jsonb_build_object(
      'draft_version', new.draft_version,
      'validation_status', new.validation_status
    )
  );
  return new;
end;
$$;

drop trigger if exists app_content_definitions_audit on public.app_content_definitions;
create trigger app_content_definitions_audit
  after insert or update on public.app_content_definitions
  for each row execute function public.record_app_content_definition_audit();

drop trigger if exists app_content_drafts_audit on public.app_content_drafts;
create trigger app_content_drafts_audit
  after insert or update on public.app_content_drafts
  for each row execute function public.record_app_content_draft_audit();

revoke all on function public.record_app_content_definition_audit() from public;
revoke all on function public.record_app_content_draft_audit() from public;
grant execute on function public.record_app_content_definition_audit() to service_role;
grant execute on function public.record_app_content_draft_audit() to service_role;
