create or replace function public.normalize_booking_slug(value text)
returns text
language sql
immutable
as $$
  select trim(both '-' from regexp_replace(lower(coalesce(value, '')), '[^a-z0-9]+', '-', 'g'));
$$;

create or replace function public.available_booking_slug(base_slug text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_base text := coalesce(nullif(public.normalize_booking_slug(base_slug), ''), 'stylist');
  candidate text;
  suffix integer := 0;
begin
  loop
    candidate := case
      when suffix = 0 then normalized_base
      else normalized_base || '-' || (suffix + 1)::text
    end;

    if not exists (
      select 1
      from public.stylists
      where slug = candidate
    ) then
      return candidate;
    end if;

    suffix := suffix + 1;

    if suffix >= 100 then
      return normalized_base || '-' || replace(gen_random_uuid()::text, '-', '');
    end if;
  end loop;
end;
$$;

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
  display_name text;
  slug_source text;
begin
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
    business_name
  )
  values (
    new.id,
    coalesce(user_email, fallback_email),
    nullif(trim(coalesce(metadata->>'full_name', metadata->>'name')), ''),
    nullif(trim(metadata->>'business_name'), '')
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

drop trigger if exists auth_user_booking_bootstrap on auth.users;

create trigger auth_user_booking_bootstrap
  after insert on auth.users
  for each row
  execute function public.handle_new_auth_user_booking_bootstrap();

insert into public.stylists (
  user_id,
  slug,
  display_name,
  booking_enabled
)
select
  users.id,
  public.available_booking_slug(coalesce(users.business_name, users.full_name, users.email, 'stylist')),
  coalesce(nullif(trim(coalesce(users.business_name, users.full_name, split_part(users.email, '@', 1))), ''), 'My Booking Page'),
  false
from public.users
where not exists (
  select 1
  from public.stylists
  where stylists.user_id = users.id
);

insert into public.booking_rules (user_id)
select users.id
from public.users
where not exists (
  select 1
  from public.booking_rules
  where booking_rules.user_id = users.id
);
