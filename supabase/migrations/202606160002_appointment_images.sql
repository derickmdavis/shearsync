insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'appointment-images',
  'appointment-images',
  false,
  2097152,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set
  name = excluded.name,
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create extension if not exists pgcrypto;

create table if not exists public.appointment_images (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  client_id uuid references public.clients(id) on delete set null,
  appointment_id uuid not null references public.appointments(id) on delete cascade,
  bucket text not null default 'appointment-images',
  storage_path text not null,
  thumbnail_path text,
  original_filename text,
  content_type text not null,
  file_size_bytes bigint not null,
  thumbnail_size_bytes bigint,
  width integer,
  height integer,
  thumbnail_width integer,
  thumbnail_height integer,
  image_role text not null default 'general',
  image_source text not null default 'stylist',
  captured_at timestamptz,
  label text,
  tags text[] not null default '{}',
  uploaded_by_user_id uuid references public.users(id) on delete set null,
  public_upload_token_id uuid,
  caption text,
  sort_order integer not null default 0,
  cache_version integer not null default 1,
  upload_status text not null default 'ready',
  upload_expires_at timestamptz,
  finalized_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint appointment_images_bucket_check
    check (bucket = 'appointment-images'),
  constraint appointment_images_content_type_check
    check (content_type in ('image/jpeg', 'image/png', 'image/webp')),
  constraint appointment_images_file_size_check
    check (file_size_bytes > 0 and file_size_bytes <= 2097152),
  constraint appointment_images_thumbnail_size_check
    check (thumbnail_size_bytes is null or (thumbnail_size_bytes > 0 and thumbnail_size_bytes <= 307200)),
  constraint appointment_images_width_check
    check (width is null or (width > 0 and width <= 1600)),
  constraint appointment_images_height_check
    check (height is null or (height > 0 and height <= 1600)),
  constraint appointment_images_thumbnail_width_check
    check (thumbnail_width is null or (thumbnail_width > 0 and thumbnail_width <= 400)),
  constraint appointment_images_thumbnail_height_check
    check (thumbnail_height is null or (thumbnail_height > 0 and thumbnail_height <= 400)),
  constraint appointment_images_ready_display_dimensions_check
    check (upload_status <> 'ready' or (width is not null and height is not null)),
  constraint appointment_images_ready_thumbnail_dimensions_check
    check (upload_status <> 'ready' or (thumbnail_width is not null and thumbnail_height is not null)),
  constraint appointment_images_role_check
    check (image_role in ('before', 'after', 'inspiration', 'reference', 'formula', 'progress', 'general')),
  constraint appointment_images_source_check
    check (image_source in ('stylist', 'client')),
  constraint appointment_images_upload_status_check
    check (upload_status in ('pending', 'ready', 'failed', 'expired')),
  constraint appointment_images_pending_expires_check
    check (upload_status <> 'pending' or upload_expires_at is not null),
  constraint appointment_images_ready_finalized_check
    check (upload_status <> 'ready' or finalized_at is not null),
  constraint appointment_images_upload_expires_after_created_check
    check (upload_expires_at is null or upload_expires_at > created_at),
  constraint appointment_images_label_length_check
    check (label is null or char_length(trim(label)) between 1 and 120),
  constraint appointment_images_caption_length_check
    check (caption is null or char_length(caption) <= 1000),
  constraint appointment_images_tags_count_check
    check (array_length(tags, 1) is null or array_length(tags, 1) <= 10),
  constraint appointment_images_sort_order_check
    check (sort_order >= 0),
  constraint appointment_images_cache_version_check
    check (cache_version >= 1),
  constraint appointment_images_storage_path_unique
    unique (bucket, storage_path)
);

create unique index if not exists appointment_images_thumbnail_path_unique_idx
  on public.appointment_images(bucket, thumbnail_path)
  where thumbnail_path is not null;

create index if not exists appointment_images_appointment_id_idx
  on public.appointment_images(appointment_id);

create index if not exists appointment_images_client_id_idx
  on public.appointment_images(client_id);

create index if not exists appointment_images_user_id_idx
  on public.appointment_images(user_id);

create index if not exists appointment_images_user_appointment_sort_idx
  on public.appointment_images(user_id, appointment_id, sort_order, created_at desc);

create index if not exists appointment_images_user_client_idx
  on public.appointment_images(user_id, client_id);

create index if not exists appointment_images_user_created_idx
  on public.appointment_images(user_id, created_at desc);

create index if not exists appointment_images_user_status_expires_idx
  on public.appointment_images(user_id, upload_status, upload_expires_at);

create or replace function public.set_appointment_images_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_appointment_images_updated_at on public.appointment_images;
create trigger set_appointment_images_updated_at
  before update on public.appointment_images
  for each row
  execute function public.set_appointment_images_updated_at();

alter table public.appointment_images enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'appointment_images'
      and policyname = 'appointment_images_select_own'
  ) then
    create policy appointment_images_select_own
      on public.appointment_images
      for select
      using (auth.uid() = user_id);
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'appointment_images'
      and policyname = 'appointment_images_insert_own'
  ) then
    create policy appointment_images_insert_own
      on public.appointment_images
      for insert
      with check (auth.uid() = user_id);
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'appointment_images'
      and policyname = 'appointment_images_update_own'
  ) then
    create policy appointment_images_update_own
      on public.appointment_images
      for update
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'appointment_images'
      and policyname = 'appointment_images_delete_own'
  ) then
    create policy appointment_images_delete_own
      on public.appointment_images
      for delete
      using (auth.uid() = user_id);
  end if;
end
$$;

create or replace view public.user_storage_usage
with (security_invoker = true)
as
select
  user_id,
  count(*) filter (where upload_status = 'ready') as appointment_image_count,
  coalesce(
    sum(file_size_bytes + coalesce(thumbnail_size_bytes, 0))
      filter (where upload_status = 'ready'),
    0
  )::bigint as appointment_image_bytes
from public.appointment_images
group by user_id;
