alter table public.availability
  add column if not exists client_audience text not null default 'all';

update public.availability
set client_audience = 'all'
where client_audience is null
   or client_audience not in ('all', 'new', 'returning');

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'availability_client_audience_check'
  ) then
    alter table public.availability
      add constraint availability_client_audience_check
      check (client_audience in ('all', 'new', 'returning'));
  end if;
end
$$;

create index if not exists availability_user_id_day_audience_idx
  on public.availability(user_id, day_of_week, client_audience);
