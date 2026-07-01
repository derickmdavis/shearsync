alter table public.clients
  add column if not exists avatar_image_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'clients_avatar_image_id_fkey'
  ) then
    alter table public.clients
      add constraint clients_avatar_image_id_fkey
      foreign key (avatar_image_id)
      references public.appointment_images(id)
      on delete set null;
  end if;
end $$;

create index if not exists clients_avatar_image_id_idx
  on public.clients(avatar_image_id);
