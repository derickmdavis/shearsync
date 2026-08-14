begin;

-- Account access is now represented by account_status and its billing audit
-- fields. These legacy tier fields are no longer read by application code.
alter table public.users
  drop column if exists plan_tier,
  drop column if exists plan_status,
  drop column if exists plan_started_at,
  drop column if exists plan_updated_at;

commit;
