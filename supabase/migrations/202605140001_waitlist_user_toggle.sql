alter table public.users
  add column if not exists waitlist_enabled boolean not null default true;
