create table if not exists public.client_formula_images (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references public.users(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade, formula_id uuid not null references public.client_formulas(id) on delete cascade,
  bucket text not null default 'appointment-images' check (bucket = 'appointment-images'), storage_path text not null unique, thumbnail_path text unique,
  original_filename text, content_type text not null check (content_type in ('image/jpeg', 'image/png', 'image/webp')),
  file_size_bytes bigint not null check (file_size_bytes > 0 and file_size_bytes <= 2097152), thumbnail_size_bytes bigint check (thumbnail_size_bytes is null or (thumbnail_size_bytes > 0 and thumbnail_size_bytes <= 307200)),
  width integer check (width is null or (width > 0 and width <= 1600)), height integer check (height is null or (height > 0 and height <= 1600)),
  thumbnail_width integer check (thumbnail_width is null or (thumbnail_width > 0 and thumbnail_width <= 400)), thumbnail_height integer check (thumbnail_height is null or (thumbnail_height > 0 and thumbnail_height <= 400)),
  image_role text not null default 'formula' check (image_role in ('formula', 'reference', 'inspiration', 'general')), caption text check (caption is null or char_length(caption) <= 1000),
  upload_status text not null default 'pending' check (upload_status in ('pending', 'ready', 'failed', 'expired')), upload_expires_at timestamptz, finalized_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.client_formula_photos (
  id uuid primary key default gen_random_uuid(), formula_id uuid not null references public.client_formulas(id) on delete cascade,
  formula_image_id uuid references public.client_formula_images(id) on delete cascade, appointment_image_id uuid references public.appointment_images(id) on delete cascade,
  photo_type text, sort_order integer not null default 0 check (sort_order >= 0), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint client_formula_photos_exactly_one_image_check check ((formula_image_id is not null)::integer + (appointment_image_id is not null)::integer = 1),
  constraint client_formula_photos_formula_image_unique unique (formula_id, formula_image_id), constraint client_formula_photos_appointment_image_unique unique (formula_id, appointment_image_id)
);
create index if not exists client_formula_images_formula_id_idx on public.client_formula_images(formula_id);
create index if not exists client_formula_photos_formula_sort_order_idx on public.client_formula_photos(formula_id, sort_order);
alter table public.client_formula_images enable row level security;
alter table public.client_formula_photos enable row level security;
