-- Server-driven application-content foundation.
-- This migration creates storage and protection only. Draft validation,
-- publication RPCs, and client/admin HTTP routes follow in later changes.

create or replace function public.app_content_placeholder_names_valid(values_to_check text[])
returns boolean
language sql
immutable
as $$
  select coalesce(
    bool_and(value ~ '^[a-z][a-zA-Z0-9]*$'),
    true
  )
  from unnest(coalesce(values_to_check, '{}'::text[])) as value;
$$;

create or replace function public.app_content_placeholder_names_unique(values_to_check text[])
returns boolean
language sql
immutable
as $$
  select coalesce(cardinality(values_to_check), 0) = (
    select count(distinct value)
    from unnest(coalesce(values_to_check, '{}'::text[])) as value
  );
$$;

create table if not exists public.app_content_definitions (
  key text primary key,
  namespace text not null,
  category text not null,
  description text not null,
  allowed_placeholders text[] not null default '{}'::text[],
  max_length integer not null default 500,
  multiline_allowed boolean not null default false,
  is_active boolean not null default true,
  fallback_required boolean not null default true,
  developer_notes text,
  created_by_admin_email text not null default 'system',
  updated_by_admin_email text not null default 'system',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint app_content_definitions_key_check
    check (key ~ '^[a-z][a-z0-9]*([.][a-z][a-z0-9_]*)+$'),
  constraint app_content_definitions_namespace_check
    check (namespace ~ '^[a-z][a-z0-9_]*$'),
  constraint app_content_definitions_category_check
    check (category in ('screen', 'section', 'empty_state', 'cta', 'upgrade', 'callout', 'dialog', 'onboarding')),
  constraint app_content_definitions_description_length_check
    check (char_length(trim(description)) between 1 and 500),
  constraint app_content_definitions_max_length_check
    check (max_length between 1 and 2000),
  constraint app_content_definitions_placeholder_names_check
    check (public.app_content_placeholder_names_valid(allowed_placeholders)),
  constraint app_content_definitions_placeholder_names_unique
    check (public.app_content_placeholder_names_unique(allowed_placeholders)),
  constraint app_content_definitions_created_by_length_check
    check (char_length(trim(created_by_admin_email)) between 1 and 255),
  constraint app_content_definitions_updated_by_length_check
    check (char_length(trim(updated_by_admin_email)) between 1 and 255)
);

create index if not exists app_content_definitions_namespace_active_idx
  on public.app_content_definitions(namespace, key)
  where is_active;

create table if not exists public.app_content_locale_state (
  locale text primary key,
  active_revision_id uuid,
  active_version bigint not null default 0,
  updated_by_admin_email text not null default 'system',
  updated_by_user_id uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint app_content_locale_state_locale_check
    check (locale ~ '^[a-z]{2,3}(-[A-Z]{2})?$'),
  constraint app_content_locale_state_active_version_check
    check (active_version >= 0),
  constraint app_content_locale_state_updated_by_length_check
    check (char_length(trim(updated_by_admin_email)) between 1 and 255)
);

create table if not exists public.app_content_drafts (
  definition_key text not null references public.app_content_definitions(key) on delete restrict,
  locale text not null references public.app_content_locale_state(locale) on delete restrict,
  value text not null,
  draft_version integer not null default 1,
  validation_status text not null default 'unvalidated',
  validation_errors jsonb,
  updated_by_admin_email text not null default 'system',
  updated_by_user_id uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (definition_key, locale),
  constraint app_content_drafts_value_not_blank_check
    check (char_length(trim(value)) >= 1),
  constraint app_content_drafts_draft_version_check
    check (draft_version > 0),
  constraint app_content_drafts_validation_status_check
    check (validation_status in ('unvalidated', 'valid', 'invalid')),
  constraint app_content_drafts_validation_errors_object_check
    check (validation_errors is null or jsonb_typeof(validation_errors) = 'object'),
  constraint app_content_drafts_updated_by_length_check
    check (char_length(trim(updated_by_admin_email)) between 1 and 255)
);

create index if not exists app_content_drafts_locale_updated_idx
  on public.app_content_drafts(locale, updated_at desc, definition_key);

create table if not exists public.app_content_revisions (
  id uuid primary key default gen_random_uuid(),
  locale text not null references public.app_content_locale_state(locale) on delete restrict,
  version bigint not null,
  kind text not null,
  source_revision_id uuid references public.app_content_revisions(id) on delete restrict,
  checksum text not null,
  published_by_admin_email text not null,
  published_by_user_id uuid references public.users(id) on delete set null,
  published_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint app_content_revisions_locale_version_unique unique (locale, version),
  constraint app_content_revisions_version_check check (version > 0),
  constraint app_content_revisions_kind_check check (kind in ('publish', 'rollback')),
  constraint app_content_revisions_checksum_check check (checksum ~ '^[a-f0-9]{64}$'),
  constraint app_content_revisions_published_by_length_check
    check (char_length(trim(published_by_admin_email)) between 1 and 255)
);

alter table public.app_content_locale_state
  add constraint app_content_locale_state_active_revision_fkey
  foreign key (active_revision_id)
  references public.app_content_revisions(id)
  on delete restrict;

create index if not exists app_content_revisions_locale_published_idx
  on public.app_content_revisions(locale, version desc);

create table if not exists public.app_content_revision_entries (
  revision_id uuid not null references public.app_content_revisions(id) on delete restrict,
  definition_key text not null references public.app_content_definitions(key) on delete restrict,
  value text not null,
  created_at timestamptz not null default now(),
  primary key (revision_id, definition_key),
  constraint app_content_revision_entries_value_not_blank_check
    check (char_length(trim(value)) >= 1)
);

create index if not exists app_content_revision_entries_definition_idx
  on public.app_content_revision_entries(definition_key, revision_id);

create table if not exists public.app_content_audit_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  definition_key text references public.app_content_definitions(key) on delete restrict,
  locale text references public.app_content_locale_state(locale) on delete restrict,
  revision_id uuid references public.app_content_revisions(id) on delete restrict,
  actor_user_id uuid references public.users(id) on delete set null,
  actor_admin_email text not null,
  previous_value text,
  new_value text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint app_content_audit_events_type_check
    check (event_type in ('definition_created', 'definition_updated', 'draft_updated', 'validated', 'published', 'rolled_back', 'archived')),
  constraint app_content_audit_events_actor_length_check
    check (char_length(trim(actor_admin_email)) between 1 and 255),
  constraint app_content_audit_events_metadata_object_check
    check (jsonb_typeof(metadata) = 'object')
);

create index if not exists app_content_audit_events_locale_created_idx
  on public.app_content_audit_events(locale, created_at desc, id);
create index if not exists app_content_audit_events_definition_created_idx
  on public.app_content_audit_events(definition_key, created_at desc, id);
create index if not exists app_content_audit_events_revision_idx
  on public.app_content_audit_events(revision_id, created_at desc, id);

create or replace function public.set_app_content_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.prevent_app_content_definition_key_update()
returns trigger
language plpgsql
as $$
begin
  if new.key <> old.key then
    raise exception using errcode = '23514', message = 'app_content_definition_key_is_immutable';
  end if;
  return new;
end;
$$;

create or replace function public.prevent_app_content_immutable_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception using errcode = '23514', message = 'app_content_immutable_row';
end;
$$;

drop trigger if exists app_content_definitions_set_updated_at on public.app_content_definitions;
create trigger app_content_definitions_set_updated_at
  before update on public.app_content_definitions
  for each row execute function public.set_app_content_updated_at();
drop trigger if exists app_content_definitions_prevent_key_update on public.app_content_definitions;
create trigger app_content_definitions_prevent_key_update
  before update on public.app_content_definitions
  for each row execute function public.prevent_app_content_definition_key_update();

drop trigger if exists app_content_locale_state_set_updated_at on public.app_content_locale_state;
create trigger app_content_locale_state_set_updated_at
  before update on public.app_content_locale_state
  for each row execute function public.set_app_content_updated_at();

drop trigger if exists app_content_drafts_set_updated_at on public.app_content_drafts;
create trigger app_content_drafts_set_updated_at
  before update on public.app_content_drafts
  for each row execute function public.set_app_content_updated_at();

drop trigger if exists app_content_revisions_immutable on public.app_content_revisions;
create trigger app_content_revisions_immutable
  before update or delete on public.app_content_revisions
  for each row execute function public.prevent_app_content_immutable_mutation();
drop trigger if exists app_content_revision_entries_immutable on public.app_content_revision_entries;
create trigger app_content_revision_entries_immutable
  before update or delete on public.app_content_revision_entries
  for each row execute function public.prevent_app_content_immutable_mutation();
drop trigger if exists app_content_audit_events_immutable on public.app_content_audit_events;
create trigger app_content_audit_events_immutable
  before update or delete on public.app_content_audit_events
  for each row execute function public.prevent_app_content_immutable_mutation();

alter table public.app_content_definitions enable row level security;
alter table public.app_content_locale_state enable row level security;
alter table public.app_content_drafts enable row level security;
alter table public.app_content_revisions enable row level security;
alter table public.app_content_revision_entries enable row level security;
alter table public.app_content_audit_events enable row level security;

revoke all on table public.app_content_definitions from public, anon, authenticated;
revoke all on table public.app_content_locale_state from public, anon, authenticated;
revoke all on table public.app_content_drafts from public, anon, authenticated;
revoke all on table public.app_content_revisions from public, anon, authenticated;
revoke all on table public.app_content_revision_entries from public, anon, authenticated;
revoke all on table public.app_content_audit_events from public, anon, authenticated;

grant select, insert, update, delete on table public.app_content_definitions to service_role;
grant select, insert, update, delete on table public.app_content_locale_state to service_role;
grant select, insert, update, delete on table public.app_content_drafts to service_role;
grant select, insert, update, delete on table public.app_content_revisions to service_role;
grant select, insert, update, delete on table public.app_content_revision_entries to service_role;
grant select, insert, update, delete on table public.app_content_audit_events to service_role;

revoke all on function public.app_content_placeholder_names_valid(text[]) from public;
revoke all on function public.app_content_placeholder_names_unique(text[]) from public;
revoke all on function public.set_app_content_updated_at() from public;
revoke all on function public.prevent_app_content_definition_key_update() from public;
revoke all on function public.prevent_app_content_immutable_mutation() from public;
grant execute on function public.app_content_placeholder_names_valid(text[]) to service_role;
grant execute on function public.app_content_placeholder_names_unique(text[]) to service_role;
grant execute on function public.set_app_content_updated_at() to service_role;
grant execute on function public.prevent_app_content_definition_key_update() to service_role;
grant execute on function public.prevent_app_content_immutable_mutation() to service_role;
