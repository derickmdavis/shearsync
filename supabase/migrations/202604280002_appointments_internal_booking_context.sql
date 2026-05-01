alter table public.appointments
  add column if not exists booking_source text not null default 'internal'
    check (booking_source in ('public', 'internal'));
