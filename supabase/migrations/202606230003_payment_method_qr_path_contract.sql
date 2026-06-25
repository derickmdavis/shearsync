do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'payment_methods_qr_image_path_owner_check'
      and conrelid = 'public.payment_methods'::regclass
  ) then
    alter table public.payment_methods
      add constraint payment_methods_qr_image_path_owner_check
      check (
        qr_image_path is null
        or (
          qr_image_path ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|jpg|webp)$'
          and split_part(qr_image_path, '/', 1) = user_id::text
        )
      )
      not valid;
  end if;
end
$$;
