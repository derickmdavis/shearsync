-- Chunk 3: Appointment Images Storage bucket
-- Run in the Supabase SQL editor before the table script.
--
-- This creates/updates a private bucket for backend-generated signed upload
-- and read URLs. Do not add broad storage.objects policies for this bucket
-- unless the API design changes to allow direct authenticated Storage access.

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
