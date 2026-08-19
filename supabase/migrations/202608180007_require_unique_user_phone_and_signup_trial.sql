begin;

-- Keep account phone numbers in one canonical form so uniqueness cannot be
-- bypassed by formatting differences such as "(303) 555-1234" and
-- "+1 303 555 1234".
create or replace function public.normalize_user_phone_number(value text)
returns text
language plpgsql
immutable
as $$
declare
  cleaned text;
  digits text;
begin
  cleaned := regexp_replace(btrim(coalesce(value, '')), '[^0-9+]', '', 'g');

  if cleaned = ''
    or length(cleaned) - length(replace(cleaned, '+', '')) > 1
    or (position('+' in cleaned) > 1) then
    return null;
  end if;

  digits := replace(cleaned, '+', '');

  if left(cleaned, 1) = '+' then
    if length(digits) between 10 and 15 and left(digits, 1) <> '0' then
      return '+' || digits;
    end if;
    return null;
  end if;

  if length(digits) = 10 then
    return '+1' || digits;
  end if;

  if length(digits) = 11 and left(digits, 1) = '1' then
    return '+' || digits;
  end if;

  return null;
end;
$$;

-- Normalize genuine legacy phone numbers first.
update public.users
set phone_number = public.normalize_user_phone_number(phone_number)
where public.normalize_user_phone_number(phone_number) is not null
  and phone_number is distinct from public.normalize_user_phone_number(phone_number);

-- Legacy profiles predate mandatory phone capture. Assign each missing or
-- invalid value a unique, non-routable +999 placeholder instead of a random
-- real phone number. New accounts cannot receive one: the auth trigger below
-- still rejects signups without a supplied valid phone number.
with invalid_users as (
  select
    id,
    row_number() over (order by id) as placeholder_sequence
  from public.users
  where public.normalize_user_phone_number(phone_number) is null
)
update public.users as users
set phone_number = '+999' || lpad(invalid_users.placeholder_sequence::text, 12, '0')
from invalid_users
where users.id = invalid_users.id;

do $$
declare
  duplicate_phone_numbers text[];
begin
  select array_agg(phone_number order by phone_number)
  into duplicate_phone_numbers
  from (
    select phone_number
    from public.users
    group by phone_number
    having count(*) > 1
  ) duplicates;

  if duplicate_phone_numbers is not null then
    raise exception using
      errcode = '23505',
      message = 'Cannot make user phone numbers unique: duplicate canonical phone numbers exist',
      detail = format('Remediate public.users.phone_number duplicates: %s', array_to_string(duplicate_phone_numbers, ', '));
  end if;
end
$$;

alter table public.users
  alter column phone_number set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'users_phone_number_unique'
      and conrelid = 'public.users'::regclass
  ) then
    alter table public.users
      add constraint users_phone_number_unique unique (phone_number);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'users_phone_number_e164_check'
      and conrelid = 'public.users'::regclass
  ) then
    alter table public.users
      add constraint users_phone_number_e164_check
      check (phone_number ~ '^\+[1-9][0-9]{9,14}$');
  end if;
end
$$;

create or replace function public.normalize_public_user_phone_number()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.phone_number := public.normalize_user_phone_number(new.phone_number);

  if new.phone_number is null then
    raise exception using
      errcode = '23514',
      message = 'phone_number is required and must be a valid E.164 phone number';
  end if;

  return new;
end;
$$;

drop trigger if exists users_normalize_phone_number on public.users;
create trigger users_normalize_phone_number
  before insert or update of phone_number on public.users
  for each row
  execute function public.normalize_public_user_phone_number();

create or replace function public.handle_new_auth_user_booking_bootstrap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  user_email text := lower(nullif(trim(coalesce(new.email, '')), ''));
  fallback_email text := new.id::text || '@auth.local';
  metadata jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  phone_number text := public.normalize_user_phone_number(metadata->>'phone_number');
  display_name text;
  slug_source text;
  provisioned_at timestamptz := now();
begin
  if phone_number is null then
    raise exception using
      errcode = '23514',
      message = 'phone_number is required to create an account';
  end if;

  display_name := nullif(trim(coalesce(
    metadata->>'business_name',
    metadata->>'full_name',
    metadata->>'name',
    split_part(coalesce(user_email, ''), '@', 1),
    'My Booking Page'
  )), '');

  display_name := coalesce(display_name, 'My Booking Page');
  slug_source := coalesce(metadata->>'business_name', metadata->>'full_name', metadata->>'name', user_email, display_name);

  insert into public.users (
    id,
    email,
    full_name,
    phone_number,
    business_name,
    account_status,
    activated_at,
    current_period_ends_at,
    deactivated_at
  )
  values (
    new.id,
    coalesce(user_email, fallback_email),
    nullif(trim(coalesce(metadata->>'full_name', metadata->>'name')), ''),
    phone_number,
    nullif(trim(metadata->>'business_name'), ''),
    'active',
    provisioned_at,
    provisioned_at + interval '15 days',
    null
  )
  on conflict (id) do nothing;

  insert into public.stylists (
    user_id,
    slug,
    display_name,
    booking_enabled
  )
  values (
    new.id,
    public.available_booking_slug(slug_source),
    display_name,
    false
  )
  on conflict (user_id) do nothing;

  insert into public.booking_rules (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

commit;
