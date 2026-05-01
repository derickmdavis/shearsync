alter table public.services
  add column if not exists category text,
  add column if not exists is_default boolean not null default false,
  add column if not exists sort_order integer;

with ranked_services as (
  select
    id,
    row_number() over (
      partition by user_id
      order by coalesce(sort_order, 2147483647), created_at, id
    ) as next_sort_order
  from public.services
)
update public.services
set sort_order = ranked_services.next_sort_order
from ranked_services
where public.services.id = ranked_services.id
  and public.services.sort_order is null;

alter table public.services
  alter column sort_order set not null,
  alter column sort_order set default 1;

create index if not exists services_user_id_sort_order_idx on public.services(user_id, sort_order);
