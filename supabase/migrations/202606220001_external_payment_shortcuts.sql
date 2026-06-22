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

  if not exists (select 1 from pg_type where typname = 'appointment_payment_status') then
    create type public.appointment_payment_status as enum (
      'unpaid',
      'marked_paid',
      'partially_paid',
      'refunded',
      'voided'
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

create table if not exists public.appointment_payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  appointment_id uuid not null references public.appointments(id) on delete cascade,
  payment_method_id uuid references public.payment_methods(id) on delete set null,
  status public.appointment_payment_status not null default 'marked_paid',
  amount numeric(10, 2) not null default 0,
  tip_amount numeric(10, 2) not null default 0,
  total_recorded numeric(10, 2) generated always as (amount + tip_amount) stored,
  external_provider public.payment_provider,
  external_provider_label text,
  external_reference text,
  notes text,
  marked_paid_at timestamptz,
  marked_unpaid_at timestamptz,
  voided_at timestamptz,
  is_current boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint appointment_payments_amount_check
    check (amount >= 0 and amount <= 999999.99),
  constraint appointment_payments_tip_amount_check
    check (tip_amount >= 0 and tip_amount <= 999999.99),
  constraint appointment_payments_external_provider_label_length_check
    check (external_provider_label is null or char_length(external_provider_label) <= 120),
  constraint appointment_payments_external_reference_length_check
    check (external_reference is null or char_length(external_reference) <= 255),
  constraint appointment_payments_notes_length_check
    check (notes is null or char_length(notes) <= 2000),
  constraint appointment_payments_voided_current_check
    check (status <> 'voided' or is_current = false)
);

create unique index if not exists appointment_payments_current_appointment_idx
  on public.appointment_payments(appointment_id)
  where is_current = true;

create index if not exists appointment_payments_user_appointment_idx
  on public.appointment_payments(user_id, appointment_id, is_current);

create index if not exists appointment_payments_user_status_idx
  on public.appointment_payments(user_id, status, created_at desc);

create index if not exists appointment_payments_payment_method_id_idx
  on public.appointment_payments(payment_method_id);

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

drop trigger if exists set_appointment_payments_updated_at on public.appointment_payments;
create trigger set_appointment_payments_updated_at
  before update on public.appointment_payments
  for each row
  execute function public.set_external_payment_updated_at();

alter table public.payment_methods enable row level security;
alter table public.appointment_payments enable row level security;

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

drop policy if exists appointment_payments_select_own on public.appointment_payments;
create policy appointment_payments_select_own
  on public.appointment_payments
  for select
  using (auth.uid() = user_id);

drop policy if exists appointment_payments_insert_own on public.appointment_payments;
create policy appointment_payments_insert_own
  on public.appointment_payments
  for insert
  with check (auth.uid() = user_id);

drop policy if exists appointment_payments_update_own on public.appointment_payments;
create policy appointment_payments_update_own
  on public.appointment_payments
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
