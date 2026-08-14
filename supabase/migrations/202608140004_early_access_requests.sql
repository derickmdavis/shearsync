-- Public marketing-site early-access / waitlist submissions. The API writes to
-- this table with the service-role client; RLS prevents direct browser access.

create table if not exists public.early_access_requests (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  email text not null,
  phone text,
  status text not null default 'new',
  source text not null default 'homepage_waitlist',
  utm_source text,
  utm_medium text,
  utm_campaign text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint early_access_requests_full_name_check check (char_length(trim(full_name)) between 2 and 120),
  constraint early_access_requests_email_check check (char_length(trim(email)) between 3 and 254),
  constraint early_access_requests_phone_length_check check (phone is null or char_length(phone) <= 40),
  constraint early_access_requests_status_check check (status in ('new', 'contacted', 'invited', 'joined', 'archived')),
  constraint early_access_requests_source_check check (char_length(trim(source)) between 1 and 100),
  constraint early_access_requests_utm_source_length_check check (utm_source is null or char_length(utm_source) <= 100),
  constraint early_access_requests_utm_medium_length_check check (utm_medium is null or char_length(utm_medium) <= 100),
  constraint early_access_requests_utm_campaign_length_check check (utm_campaign is null or char_length(utm_campaign) <= 150),
  constraint early_access_requests_notes_length_check check (notes is null or char_length(notes) <= 1000)
);

-- The endpoint is idempotent by email. This also handles manual records whose
-- email casing differs.
create unique index if not exists early_access_requests_email_lower_uidx
  on public.early_access_requests (lower(email));
create index if not exists early_access_requests_status_created_at_idx
  on public.early_access_requests (status, created_at desc);

alter table public.early_access_requests enable row level security;

create or replace function public.set_early_access_requests_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists early_access_requests_set_updated_at on public.early_access_requests;
create trigger early_access_requests_set_updated_at
  before update on public.early_access_requests
  for each row execute function public.set_early_access_requests_updated_at();
