-- Correct template bodies created by migration 003 and add a concrete readiness
-- marker. This migration is safe for databases where 003 has already run.

update public.campaign_templates
set message = case id
  when '10000000-0000-4000-8000-000000000001'::uuid then
    E'Hi {{first_name}},\n\nI would love to see you again. Choose a time that works for you below.'
  when '10000000-0000-4000-8000-000000000002'::uuid then
    E'Hi {{first_name}},\n\nI have something special available for a limited time. Book your next visit below.'
  when '10000000-0000-4000-8000-000000000003'::uuid then
    E'Hi {{first_name}},\n\nIf someone comes to mind, you can share your personal referral link below.'
  else message
end
where id in (
  '10000000-0000-4000-8000-000000000001'::uuid,
  '10000000-0000-4000-8000-000000000002'::uuid,
  '10000000-0000-4000-8000-000000000003'::uuid
);

create table if not exists public.outreach_schema_versions (
  component text primary key,
  version text not null,
  applied_at timestamptz not null default now(),
  constraint outreach_schema_versions_component_not_blank check (btrim(component) <> ''),
  constraint outreach_schema_versions_version_not_blank check (btrim(version) <> '')
);

alter table public.outreach_schema_versions enable row level security;

insert into public.outreach_schema_versions (component, version, applied_at)
values ('campaign_authoring', 'outreach_corrective_pass_2026_07_18', now())
on conflict (component) do update
set version = excluded.version,
    applied_at = excluded.applied_at;

revoke all on table public.outreach_schema_versions from anon, authenticated;
grant select on table public.outreach_schema_versions to service_role;

