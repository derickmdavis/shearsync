alter table public.appointment_images
  add column if not exists thumbnail_width integer,
  add column if not exists thumbnail_height integer;

alter table public.appointment_images
  drop constraint if exists appointment_images_width_check,
  drop constraint if exists appointment_images_height_check,
  drop constraint if exists appointment_images_thumbnail_width_check,
  drop constraint if exists appointment_images_thumbnail_height_check,
  drop constraint if exists appointment_images_ready_display_dimensions_check,
  drop constraint if exists appointment_images_ready_thumbnail_dimensions_check;

alter table public.appointment_images
  add constraint appointment_images_width_check
    check (width is null or (width > 0 and width <= 1600)) not valid,
  add constraint appointment_images_height_check
    check (height is null or (height > 0 and height <= 1600)) not valid,
  add constraint appointment_images_thumbnail_width_check
    check (thumbnail_width is null or (thumbnail_width > 0 and thumbnail_width <= 400)) not valid,
  add constraint appointment_images_thumbnail_height_check
    check (thumbnail_height is null or (thumbnail_height > 0 and thumbnail_height <= 400)) not valid,
  add constraint appointment_images_ready_display_dimensions_check
    check (upload_status <> 'ready' or (width is not null and height is not null)) not valid,
  add constraint appointment_images_ready_thumbnail_dimensions_check
    check (upload_status <> 'ready' or (thumbnail_width is not null and thumbnail_height is not null)) not valid;
