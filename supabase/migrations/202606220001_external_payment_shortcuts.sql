create extension if not exists pgcrypto;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'payment_provider') then
    create type public.payment_provider as enum (
      'venmo',
      'paypal',
      'square',
      'cash_app',
      'zelle',
      'apple_pay',
      'google_pay',
      'cash',
      'other'
    );
  end if;
end
$$;

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'payment-method-qrs',
  'payment-method-qrs',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set
  name = excluded.name,
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.payment_methods (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  provider public.payment_provider not null,
  display_name text not null,
  payment_url text,
  qr_image_url text,
  qr_image_path text,
  instructions text,
  is_default boolean not null default false,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_methods_display_name_length_check
    check (char_length(trim(display_name)) between 1 and 80),
  constraint payment_methods_payment_url_length_check
    check (payment_url is null or char_length(payment_url) <= 2048),
  constraint payment_methods_qr_image_url_length_check
    check (qr_image_url is null or char_length(qr_image_url) <= 2048),
  constraint payment_methods_qr_image_path_length_check
    check (qr_image_path is null or char_length(qr_image_path) <= 500),
  constraint payment_methods_qr_image_path_owner_check
    check (
      qr_image_path is null
      or (
        qr_image_path ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|jpg|webp)$'
        and split_part(qr_image_path, '/', 1) = user_id::text
      )
    ),
  constraint payment_methods_instructions_length_check
    check (instructions is null or char_length(instructions) <= 500),
  constraint payment_methods_sort_order_check
    check (sort_order >= 0),
  constraint payment_methods_external_target_check
    check (
      provider in ('cash', 'other')
      or payment_url is not null
      or qr_image_url is not null
      or qr_image_path is not null
    )
);

create unique index if not exists payment_methods_user_default_active_idx
  on public.payment_methods(user_id)
  where is_default = true and is_active = true;

create index if not exists payment_methods_user_active_sort_idx
  on public.payment_methods(user_id, is_active, is_default desc, sort_order, created_at);

create index if not exists payment_methods_user_provider_idx
  on public.payment_methods(user_id, provider);

create or replace function public.set_external_payment_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_payment_methods_updated_at on public.payment_methods;
create trigger set_payment_methods_updated_at
  before update on public.payment_methods
  for each row
  execute function public.set_external_payment_updated_at();

alter table public.payment_methods enable row level security;

drop policy if exists payment_methods_select_own on public.payment_methods;
create policy payment_methods_select_own
  on public.payment_methods
  for select
  using (auth.uid() = user_id);

drop policy if exists payment_methods_insert_own on public.payment_methods;
create policy payment_methods_insert_own
  on public.payment_methods
  for insert
  with check (auth.uid() = user_id);

drop policy if exists payment_methods_update_own on public.payment_methods;
create policy payment_methods_update_own
  on public.payment_methods
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
