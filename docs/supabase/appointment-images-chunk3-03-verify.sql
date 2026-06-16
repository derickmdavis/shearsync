-- Chunk 3 verification queries.
-- Run after 01-storage and 02-schema. This script is read-only.

select
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
from storage.buckets
where id = 'appointment-images';

select
  column_name,
  data_type,
  is_nullable,
  column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'appointment_images'
order by ordinal_position;

select
  indexname,
  indexdef
from pg_indexes
where schemaname = 'public'
  and tablename = 'appointment_images'
order by indexname;

select
  policyname,
  cmd,
  qual,
  with_check
from pg_policies
where schemaname = 'public'
  and tablename = 'appointment_images'
order by policyname;

select
  c.relname as relation_name,
  c.relrowsecurity as rls_enabled
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname = 'appointment_images';

select
  table_name,
  view_definition
from information_schema.views
where table_schema = 'public'
  and table_name = 'user_storage_usage';
