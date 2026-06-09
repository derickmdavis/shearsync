alter table public.users
  add column if not exists location_label text,
  add column if not exists avatar_image_id text,
  add column if not exists plan_started_at timestamptz default now();

alter table public.users
  alter column timezone set default 'America/Denver',
  alter column plan_updated_at set default now();

alter table public.clients
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_reason text;

alter table public.appointments
  add column if not exists service_id uuid references public.services(id) on delete set null,
  add column if not exists appointment_time_range tstzrange;

create index if not exists appointments_service_id_idx
  on public.appointments(service_id);

update public.appointments
set appointment_time_range = tstzrange(
  appointment_date,
  appointment_date + (duration_minutes * interval '1 minute'),
  '[)'
)
where appointment_time_range is null
  and appointment_date is not null
  and duration_minutes is not null;

create index if not exists appointments_time_range_gist_idx
  on public.appointments using gist (appointment_time_range);

alter table public.services
  add column if not exists visible boolean not null default true;

update public.appointments
set status = 'scheduled'
where status = 'booked';

update public.appointments
set booking_source = 'internal'
where booking_source is null;

alter table public.appointments
  alter column status set default 'scheduled',
  alter column booking_source set default 'internal',
  alter column booking_source set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.appointments'::regclass
      and conname = 'appointments_booking_source_check'
  ) then
    alter table public.appointments
      add constraint appointments_booking_source_check
      check (booking_source in ('public', 'internal'));
  end if;
end
$$;

update public.reminders
set status = 'open'
where status = 'pending';

update public.reminders r
set client_id = a.client_id
from public.appointments a
where r.client_id is null
  and r.appointment_id = a.id
  and a.client_id is not null;

do $$
begin
  if exists (
    select 1
    from public.reminders
    where client_id is null
  ) then
    raise exception 'Cannot require reminders.client_id: some rows still have null client_id.';
  end if;
end
$$;

alter table public.reminders
  alter column status set default 'open',
  alter column client_id set not null;

update public.activity_events
set dedupe_key = 'legacy:' || id::text
where dedupe_key is null;

update public.activity_events ae
set appointment_id = null
where appointment_id is not null
  and not exists (
    select 1
    from public.appointments a
    where a.id = ae.appointment_id
  );

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'activity_events'
      and column_name = 'stylist_id'
  )
  and not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'activity_events'
      and column_name = 'user_id'
  ) then
    alter table public.activity_events
      rename column stylist_id to user_id;
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'appointment_email_events'
      and column_name = 'stylist_id'
  )
  and not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'appointment_email_events'
      and column_name = 'user_id'
  ) then
    alter table public.appointment_email_events
      rename column stylist_id to user_id;
  end if;
end
$$;

do $$
begin
  if exists (
    select 1
    from public.activity_events
    where client_id is null
  ) then
    raise exception 'Cannot require activity_events.client_id: some rows still have null client_id.';
  end if;

  if exists (
    select 1
    from public.activity_events ae
    where not exists (
      select 1
      from public.clients c
      where c.id = ae.client_id
    )
  ) then
    raise exception 'Cannot add activity_events client FK: some client_id values do not exist in public.clients.';
  end if;

  if exists (
    select 1
    from public.activity_events ae
    where not exists (
      select 1
      from public.users u
      where u.id = ae.user_id
    )
  ) then
    raise exception 'Cannot add activity_events user FK: some user_id values do not exist in public.users.';
  end if;
end
$$;

alter table public.activity_events
  alter column client_id set not null,
  alter column dedupe_key set not null;

alter table public.activity_events
  drop constraint if exists activity_events_stylist_id_fkey,
  drop constraint if exists activity_events_user_id_fkey,
  drop constraint if exists activity_events_client_id_fkey,
  drop constraint if exists activity_events_appointment_id_fkey;

alter table public.activity_events
  add constraint activity_events_user_id_fkey
    foreign key (user_id)
    references public.users(id)
    on delete cascade
    not valid,
  add constraint activity_events_client_id_fkey
    foreign key (client_id)
    references public.clients(id)
    not valid,
  add constraint activity_events_appointment_id_fkey
    foreign key (appointment_id)
    references public.appointments(id)
    on delete set null
    not valid;

alter table public.activity_events validate constraint activity_events_user_id_fkey;
alter table public.activity_events validate constraint activity_events_client_id_fkey;
alter table public.activity_events validate constraint activity_events_appointment_id_fkey;

drop index if exists public.activity_events_stylist_occurred_at_idx;
drop index if exists public.activity_events_stylist_dedupe_key_idx;

create index if not exists activity_events_user_occurred_at_idx
  on public.activity_events(user_id, occurred_at desc, id desc);

create unique index if not exists activity_events_user_dedupe_key_idx
  on public.activity_events(user_id, dedupe_key);

alter table public.appointment_email_events
  drop constraint if exists appointment_email_events_stylist_id_fkey,
  drop constraint if exists appointment_email_events_user_id_fkey,
  drop constraint if exists appointment_email_events_client_id_fkey,
  drop constraint if exists appointment_email_events_appointment_id_fkey;

alter table public.appointment_email_events
  add constraint appointment_email_events_user_id_fkey
    foreign key (user_id)
    references public.users(id)
    on delete cascade
    not valid,
  add constraint appointment_email_events_client_id_fkey
    foreign key (client_id)
    references public.clients(id)
    not valid,
  add constraint appointment_email_events_appointment_id_fkey
    foreign key (appointment_id)
    references public.appointments(id)
    not valid;

alter table public.appointment_email_events validate constraint appointment_email_events_user_id_fkey;
alter table public.appointment_email_events validate constraint appointment_email_events_client_id_fkey;
alter table public.appointment_email_events validate constraint appointment_email_events_appointment_id_fkey;

drop index if exists public.appointment_email_events_stylist_status_idx;

create index if not exists appointment_email_events_user_status_idx
  on public.appointment_email_events(user_id, status, created_at);

drop policy if exists activity_events_select_own on public.activity_events;
create policy activity_events_select_own
  on public.activity_events
  for select
  using (auth.uid() = user_id);

drop policy if exists appointment_email_events_select_own on public.appointment_email_events;
create policy appointment_email_events_select_own
  on public.appointment_email_events
  for select
  using (auth.uid() = user_id);
