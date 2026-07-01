alter table public.clients
  add column if not exists is_vip boolean not null default false;

update public.clients
set is_vip = true
where tags && array['VIP', 'vip'];

create index if not exists clients_user_is_vip_idx
  on public.clients(user_id, is_vip, id);
