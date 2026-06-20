update storage.buckets
set file_size_limit = 2097152
where id = 'appointment-images';

alter table public.appointment_images
  drop constraint if exists appointment_images_file_size_check,
  drop constraint if exists appointment_images_thumbnail_size_check,
  add constraint appointment_images_file_size_check
    check (file_size_bytes > 0 and file_size_bytes <= 2097152),
  add constraint appointment_images_thumbnail_size_check
    check (thumbnail_size_bytes is null or (thumbnail_size_bytes > 0 and thumbnail_size_bytes <= 307200));
