-- SMS is capped per account, and the counter is advanced only for provider
-- sends. These fields predate the SMS outbox; initialize every account with
-- the shared 500-message limit before the worker starts enforcing it.
alter table public.users
  add column if not exists sms_usage_period_started_at date;

update public.users
set sms_monthly_limit = 500,
    sms_used_this_month = least(greatest(coalesce(sms_used_this_month, 0), 0), 500),
    sms_usage_period_started_at = coalesce(
      sms_usage_period_started_at,
      date_trunc('month', now() at time zone 'UTC')::date
    );

alter table public.users
  alter column sms_monthly_limit set default 500,
  alter column sms_usage_period_started_at set default date_trunc('month', now() at time zone 'UTC')::date,
  alter column sms_usage_period_started_at set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'users_sms_monthly_limit_check'
      and conrelid = 'public.users'::regclass
  ) then
    alter table public.users
      add constraint users_sms_monthly_limit_check
      check (sms_monthly_limit between 0 and 500);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'users_sms_used_this_month_check'
      and conrelid = 'public.users'::regclass
  ) then
    alter table public.users
      add constraint users_sms_used_this_month_check
      check (sms_used_this_month >= 0);
  end if;
end;
$$;

alter table public.sms_messages
  add column if not exists sms_usage_counted_at timestamptz,
  add column if not exists sms_usage_counted_month date;

create or replace function public.reserve_sms_monthly_usage(
  p_message_id uuid,
  p_lease_token uuid
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_used integer;
  v_limit integer;
  v_period date;
  v_current_period date := date_trunc('month', now() at time zone 'UTC')::date;
begin
  select user_id
    into v_user_id
  from public.sms_messages
  where id = p_message_id
    and status = 'sending'
    and lease_token = p_lease_token
    and sms_usage_counted_at is null
  for update;

  if not found then
    return 'not_claimed';
  end if;

  select sms_used_this_month, sms_monthly_limit, sms_usage_period_started_at
    into v_used, v_limit, v_period
  from public.users
  where id = v_user_id
  for update;

  if not found then
    return 'not_available';
  end if;

  if v_period < v_current_period then
    update public.users
    set sms_used_this_month = 1,
        sms_usage_period_started_at = v_current_period
    where id = v_user_id;
  elsif v_used >= v_limit then
    return 'limit_reached';
  else
    update public.users
    set sms_used_this_month = v_used + 1
    where id = v_user_id;
  end if;

  update public.sms_messages
  set sms_usage_counted_at = now(),
      sms_usage_counted_month = v_current_period
  where id = p_message_id;

  return 'allowed';
end;
$$;

create or replace function public.release_sms_monthly_usage(
  p_message_id uuid,
  p_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_counted_month date;
  v_current_period date := date_trunc('month', now() at time zone 'UTC')::date;
begin
  select user_id, sms_usage_counted_month
    into v_user_id, v_counted_month
  from public.sms_messages
  where id = p_message_id
    and lease_token = p_lease_token
    and sms_usage_counted_at is not null
  for update;

  if not found then
    return false;
  end if;

  update public.sms_messages
  set sms_usage_counted_at = null,
      sms_usage_counted_month = null
  where id = p_message_id;

  if v_counted_month = v_current_period then
    update public.users
    set sms_used_this_month = greatest(0, sms_used_this_month - 1)
    where id = v_user_id
      and sms_usage_period_started_at = v_current_period;
  end if;

  return true;
end;
$$;

revoke all on function public.reserve_sms_monthly_usage(uuid, uuid) from public, anon, authenticated;
revoke all on function public.release_sms_monthly_usage(uuid, uuid) from public, anon, authenticated;
grant execute on function public.reserve_sms_monthly_usage(uuid, uuid) to service_role;
grant execute on function public.release_sms_monthly_usage(uuid, uuid) to service_role;
