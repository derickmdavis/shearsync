begin;

alter table public.users
  add column if not exists account_status text not null default 'inactive',
  add column if not exists activated_at timestamptz,
  add column if not exists current_period_ends_at timestamptz,
  add column if not exists deactivated_at timestamptz,
  add column if not exists billing_provider text,
  add column if not exists billing_customer_id text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'users_account_status_check'
      and conrelid = 'public.users'::regclass
  ) then
    alter table public.users
      add constraint users_account_status_check
      check (account_status in ('active', 'inactive'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'users_billing_identity_check'
      and conrelid = 'public.users'::regclass
  ) then
    alter table public.users
      add constraint users_billing_identity_check
      check (
        (billing_provider is null and billing_customer_id is null)
        or (
          billing_provider is not null
          and billing_customer_id is not null
          and char_length(trim(billing_provider)) > 0
          and char_length(trim(billing_customer_id)) > 0
        )
      );
  end if;
end
$$;

update public.users
set
  account_status = case
    when plan_tier in ('pro', 'premium') and plan_status = 'active' then 'active'
    else 'inactive'
  end,
  activated_at = case
    when plan_tier in ('pro', 'premium') and plan_status = 'active'
      then coalesce(activated_at, plan_started_at, plan_updated_at, created_at, now())
    else activated_at
  end,
  deactivated_at = case
    when not (plan_tier in ('pro', 'premium') and plan_status = 'active')
      then coalesce(deactivated_at, plan_updated_at, created_at, now())
    else deactivated_at
  end;

create index if not exists users_account_status_idx on public.users (account_status);
create unique index if not exists users_billing_provider_customer_unique_idx
  on public.users (billing_provider, billing_customer_id)
  where billing_provider is not null and billing_customer_id is not null;

commit;
