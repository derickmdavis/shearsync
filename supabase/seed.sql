-- Focused CRM/demo seed.
--
-- Preserves auth logins and stylist/business configuration. This script does
-- not insert, update, or delete auth.users, auth.identities, public.users,
-- public.stylists, public.services, public.availability, public.booking_rules,
-- or public.stylist_off_days.
--
-- It resets only client/appointment-adjacent demo data for the target user:
-- clients, appointments, photos, reminders, waitlist entries, activity events,
-- and appointment email events.
--
-- Change this value if you want to reseed a different stylist account.

begin;

create temporary table seed_target (
  user_id uuid primary key
) on commit drop;

insert into seed_target (user_id)
values ('d87fb2aa-e129-450c-ad09-a7853a891590');

do $$
begin
  if not exists (
    select 1
    from public.users u
    join seed_target st on st.user_id = u.id
  ) then
    raise exception 'Seed target user does not exist in public.users. Update seed_target.user_id before running this seed.';
  end if;
end
$$;

create or replace function pg_temp.seed_uuid(seed_key text)
returns uuid
language sql
immutable
as $function$
  select (
    substr(md5(seed_key), 1, 8) || '-' ||
    substr(md5(seed_key), 9, 4) || '-' ||
    substr(md5(seed_key), 13, 4) || '-' ||
    substr(md5(seed_key), 17, 4) || '-' ||
    substr(md5(seed_key), 21, 12)
  )::uuid;
$function$;

create temporary table seed_services on commit drop as
select
  row_number() over (
    order by
      coalesce(sort_order, 999),
      duration_minutes,
      name,
      id
  ) as service_no,
  id,
  name,
  duration_minutes,
  coalesce(price, 0)::numeric(10, 2) as price
from public.services
where user_id in (select user_id from seed_target)
  and coalesce(is_active, true) = true
  and coalesce(visible, true) = true;

do $$
begin
  if not exists (select 1 from seed_services) then
    raise exception 'Seed target user has no active visible services. Create at least one service before running this seed.';
  end if;
end
$$;

delete from public.appointment_email_events
where user_id in (select user_id from seed_target);

delete from public.activity_events
where user_id in (select user_id from seed_target);

delete from public.reminders
where user_id in (select user_id from seed_target);

delete from public.photos
where user_id in (select user_id from seed_target);

delete from public.waitlist_entries
where user_id in (select user_id from seed_target);

delete from public.appointments
where user_id in (select user_id from seed_target);

delete from public.clients
where user_id in (select user_id from seed_target);

with name_seed as (
  select
    gs.idx,
    (array[
      'Maya', 'Jordan', 'Avery', 'Sofia', 'Riley', 'Camila', 'Harper', 'Isabella',
      'Quinn', 'Elena', 'Nora', 'Taylor', 'Leah', 'Morgan', 'Chloe', 'Sam',
      'Amara', 'Peyton', 'Gia', 'Rowan', 'Lina', 'Skylar', 'Naomi', 'Eden',
      'Iris', 'Drew', 'Sienna', 'Casey', 'Maeve', 'Alexis', 'Jules', 'Emery',
      'Tessa', 'Reese', 'Ana', 'Blair', 'Dani', 'Kira', 'Liv', 'Noelle'
    ])[((gs.idx - 1) % 40) + 1] as first_name,
    (array[
      'Lopez', 'Kim', 'Patel', 'Nguyen', 'Brooks', 'Rivera', 'Ellis', 'Morgan',
      'Anderson', 'Carter', 'Singh', 'Reed', 'Henderson', 'Price', 'Bennett',
      'Foster', 'Diaz', 'Wallace', 'Martinez', 'Murphy', 'Kowalski', 'James',
      'Russell', 'Cole', 'Parker', 'Hayes', 'Morris', 'Watson', 'Griffin',
      'Flores', 'Santos', 'Gray', 'Cooper', 'Mills', 'Bishop', 'Stone',
      'Knight', 'Hughes', 'Wells', 'Porter'
    ])[((gs.idx - 1) % 40) + 1] as last_name
  from generate_series(1, 80) as gs(idx)
),
client_seed as (
  select
    idx,
    case when idx > 40 then first_name || ' ' || chr(64 + ((idx - 40) % 26) + 1) else first_name end as first_name,
    last_name,
    lower(regexp_replace(first_name || '.' || last_name || idx, '[^a-zA-Z0-9.]', '', 'g')) as handle,
    to_char((date '1980-01-01' + ((idx * 137) % 8500))::date, 'DD/MM') as birthday,
    case
      when idx % 11 = 0 then array['new-client']
      when idx % 10 = 0 then array['vip', 'extensions']
      when idx % 7 = 0 then array['blonding', 'color']
      when idx % 5 = 0 then array['cut', 'low-maintenance']
      when idx % 3 = 0 then array['color']
      else array['regular']
    end as tags,
    (array['instagram', 'referral', 'walk-in', 'existing-client', 'other'])[(idx % 5) + 1] as source,
    (array['text', 'email', 'text', 'call', 'instagram'])[(idx % 5) + 1] as preferred_contact_method
  from name_seed
)
insert into public.clients (
  id,
  user_id,
  first_name,
  last_name,
  preferred_name,
  phone,
  phone_normalized,
  email,
  instagram,
  birthday,
  notes,
  preferred_contact_method,
  tags,
  source,
  reminder_consent,
  total_spend,
  last_visit_at
)
select
  pg_temp.seed_uuid('client-' || client_seed.idx),
  seed_target.user_id,
  client_seed.first_name,
  client_seed.last_name,
  split_part(client_seed.first_name, ' ', 1),
  '(555) 301-' || lpad(client_seed.idx::text, 4, '0'),
  '+1555301' || lpad(client_seed.idx::text, 4, '0'),
  client_seed.handle || '@example.com',
  '@' || client_seed.handle,
  client_seed.birthday,
  case
    when client_seed.idx % 11 = 0 then 'Newer client profile seeded for approval, intake, and waitlist flows.'
    else 'Seeded demo client with realistic service history, preferences, and appointment activity.'
  end,
  client_seed.preferred_contact_method,
  client_seed.tags,
  client_seed.source,
  client_seed.idx % 6 <> 0,
  0,
  null
from client_seed
cross join seed_target;

with client_rows as (
  select
    row_number() over (order by first_name, last_name, id) as client_no,
    id as client_id
  from public.clients
  where user_id in (select user_id from seed_target)
),
service_count as (
  select count(*)::integer as total from seed_services
),
past_seed as (
  select
    (row_number() over (order by client_rows.client_no, visit.visit_no))::integer as appointment_no,
    client_rows.client_no,
    client_rows.client_id,
    visit.visit_no,
    ((client_rows.client_no + visit.visit_no - 2) % service_count.total) + 1 as service_no
  from client_rows
  cross join lateral generate_series(1, 1 + (client_rows.client_no % 3)) as visit(visit_no)
  cross join service_count
),
past_appointments as (
  select
    pg_temp.seed_uuid('past-appointment-' || past_seed.appointment_no) as id,
    seed_target.user_id,
    past_seed.client_id,
    seed_services.id as service_id,
    (
      date_trunc('day', now() at time zone 'America/Denver')::date
      - (12 + past_seed.appointment_no)::integer
      + (array['09:00:00', '12:00:00', '15:00:00'])[((past_seed.appointment_no - 1) % 3) + 1]::time
    ) at time zone 'America/Denver' as appointment_date,
    seed_services.name as service_name,
    seed_services.duration_minutes,
    seed_services.price,
    case when past_seed.appointment_no % 4 = 0 then 'public' else 'internal' end as booking_source
  from past_seed
  join seed_services on seed_services.service_no = past_seed.service_no
  cross join seed_target
)
insert into public.appointments (
  id,
  user_id,
  client_id,
  service_id,
  appointment_date,
  service_name,
  duration_minutes,
  price,
  notes,
  status,
  booking_source,
  appointment_time_range
)
select
  id,
  user_id,
  client_id,
  service_id,
  appointment_date,
  service_name,
  duration_minutes,
  price,
  'Seeded completed appointment for revenue, retention, and client-history metrics.',
  'completed',
  booking_source,
  tstzrange(appointment_date, appointment_date + (duration_minutes * interval '1 minute'), '[)')
from past_appointments;

with client_rows as (
  select
    row_number() over (order by first_name, last_name, id) as client_no,
    id as client_id
  from public.clients
  where user_id in (select user_id from seed_target)
),
service_count as (
  select count(*)::integer as total from seed_services
),
future_slots as (
  select
    (row_number() over (order by day_offset, slot_no))::integer as appointment_no,
    day_offset::integer,
    slot_no::integer,
    (array['08:00:00', '12:00:00', '16:00:00'])[slot_no]::time as start_time
  from generate_series(1, 42) as days(day_offset)
  cross join generate_series(1, 3) as slots(slot_no)
),
future_appointments as (
  select
    pg_temp.seed_uuid('future-appointment-' || future_slots.appointment_no) as id,
    seed_target.user_id,
    client_rows.client_id,
    seed_services.id as service_id,
    (
      date_trunc('day', now() at time zone 'America/Denver')::date
      + future_slots.day_offset::integer
      + future_slots.start_time
    ) at time zone 'America/Denver' as appointment_date,
    seed_services.name as service_name,
    seed_services.duration_minutes,
    seed_services.price,
    case
      when future_slots.appointment_no % 17 = 0 then 'pending'
      else 'scheduled'
    end as status,
    case
      when future_slots.appointment_no % 3 = 0 then 'internal'
      else 'public'
    end as booking_source
  from future_slots
  join client_rows on client_rows.client_no = ((future_slots.appointment_no - 1) % 80) + 1
  cross join service_count
  join seed_services on seed_services.service_no = ((future_slots.appointment_no - 1) % service_count.total) + 1
  cross join seed_target
)
insert into public.appointments (
  id,
  user_id,
  client_id,
  service_id,
  appointment_date,
  service_name,
  duration_minutes,
  price,
  notes,
  status,
  booking_source,
  appointment_time_range
)
select
  id,
  user_id,
  client_id,
  service_id,
  appointment_date,
  service_name,
  duration_minutes,
  price,
  case
    when status = 'pending' then 'Seeded public booking awaiting approval.'
    else 'Seeded upcoming appointment for calendar density, revenue forecasting, and automation demos.'
  end,
  status,
  booking_source,
  tstzrange(appointment_date, appointment_date + (duration_minutes * interval '1 minute'), '[)')
from future_appointments;

update public.clients c
set
  total_spend = coalesce(metrics.total_spend, 0),
  last_visit_at = metrics.last_visit_at
from (
  select
    client_id,
    sum(price) filter (where status = 'completed') as total_spend,
    max(appointment_date) filter (where status = 'completed') as last_visit_at
  from public.appointments
  where user_id in (select user_id from seed_target)
  group by client_id
) metrics
where c.id = metrics.client_id;

with client_rows as (
  select
    row_number() over (order by first_name, last_name, id) as client_no,
    id as client_id,
    lower(first_name || '-' || last_name) as slug_name
  from public.clients
  where user_id in (select user_id from seed_target)
),
photo_seed as (
  select
    row_number() over (order by client_no, photo_type) as photo_no,
    client_no,
    client_id,
    photo_type
  from client_rows
  join lateral (
    values
      ('before'),
      ('after')
  ) as photo_types(photo_type) on client_rows.client_no <= 18
)
insert into public.photos (
  id,
  user_id,
  client_id,
  file_path,
  photo_type,
  caption
)
select
  pg_temp.seed_uuid('photo-' || photo_seed.photo_no),
  seed_target.user_id,
  photo_seed.client_id,
  'seed/photos/client-' || lpad(photo_seed.client_no::text, 2, '0') || '-' || photo_seed.photo_type || '.jpg',
  photo_seed.photo_type,
  initcap(photo_seed.photo_type) || ' photo seeded for appointment detail demos.'
from photo_seed
cross join seed_target;

with upcoming as (
  select
    row_number() over (order by appointment_date, id) as reminder_no,
    id as appointment_id,
    client_id,
    appointment_date,
    service_name
  from public.appointments
  where user_id in (select user_id from seed_target)
    and appointment_date >= now()
  order by appointment_date, id
  limit 36
)
insert into public.reminders (
  id,
  user_id,
  client_id,
  appointment_id,
  title,
  due_date,
  status,
  channel,
  reminder_type,
  notes
)
select
  pg_temp.seed_uuid('reminder-' || upcoming.reminder_no),
  seed_target.user_id,
  upcoming.client_id,
  upcoming.appointment_id,
  case
    when upcoming.reminder_no <= 24 then 'Confirm ' || upcoming.service_name
    else 'Follow up after ' || upcoming.service_name
  end,
  case
    when upcoming.reminder_no <= 24 then upcoming.appointment_date - interval '24 hours'
    else upcoming.appointment_date + interval '21 days'
  end,
  'open',
  case when upcoming.reminder_no % 3 = 0 then 'email' else 'sms' end,
  case when upcoming.reminder_no <= 24 then 'appointment_reminder' else 'follow_up' end,
  'Seeded reminder tied to refreshed appointment data.'
from upcoming
cross join seed_target;

with client_rows as (
  select
    row_number() over (order by first_name, last_name, id) as client_no,
    id as client_id,
    first_name || ' ' || last_name as client_name,
    email,
    phone
  from public.clients
  where user_id in (select user_id from seed_target)
),
service_count as (
  select count(*)::integer as total from seed_services
),
waitlist_seed as (
  select
    (row_number() over (order by gs.waitlist_no))::integer as waitlist_no,
    (44 + (gs.waitlist_no % 12))::integer as day_offset,
    (((gs.waitlist_no - 1) % 80) + 1)::integer as client_no,
    (((gs.waitlist_no - 1) % service_count.total) + 1)::integer as service_no
  from generate_series(1, 18) as gs(waitlist_no)
  cross join service_count
)
insert into public.waitlist_entries (
  id,
  user_id,
  client_id,
  service_id,
  requested_date,
  requested_time_preference,
  client_name,
  client_email,
  client_phone,
  note,
  status,
  source
)
select
  pg_temp.seed_uuid('waitlist-' || waitlist_seed.waitlist_no),
  seed_target.user_id,
  client_rows.client_id,
  seed_services.id,
  (date_trunc('day', now() at time zone 'America/Denver')::date + waitlist_seed.day_offset::integer),
  (array['morning', 'afternoon', 'anytime'])[((waitlist_seed.waitlist_no - 1) % 3) + 1],
  client_rows.client_name,
  client_rows.email,
  client_rows.phone,
  'Seeded waitlist request for a busy future week.',
  'active',
  case when waitlist_seed.waitlist_no % 4 = 0 then 'public_booking' else 'stylist_created' end
from waitlist_seed
join client_rows on client_rows.client_no = waitlist_seed.client_no
join seed_services on seed_services.service_no = waitlist_seed.service_no
cross join seed_target;

with event_rows as (
  select
    row_number() over (order by appointment_date, id) as event_no,
    id as appointment_id,
    client_id,
    service_name,
    appointment_date,
    status,
    booking_source
  from public.appointments
  where user_id in (select user_id from seed_target)
    and appointment_date >= now()
  order by appointment_date, id
  limit 80
)
insert into public.activity_events (
  id,
  user_id,
  client_id,
  appointment_id,
  activity_type,
  title,
  description,
  occurred_at,
  metadata,
  dedupe_key
)
select
  pg_temp.seed_uuid('activity-booking-' || event_rows.event_no),
  seed_target.user_id,
  event_rows.client_id,
  event_rows.appointment_id,
  'booking_created',
  'New booking for ' || event_rows.service_name,
  'Seeded activity event from refreshed appointment data.',
  now() - (event_rows.event_no || ' hours')::interval,
  jsonb_build_object(
    'service_name', event_rows.service_name,
    'appointment_start_time', event_rows.appointment_date,
    'current_appointment_status', event_rows.status,
    'booking_source', event_rows.booking_source
  ),
  'seed-booking-created-' || event_rows.event_no
from event_rows
cross join seed_target;

with event_rows as (
  select
    row_number() over (order by requested_date, id) as event_no,
    id,
    client_id,
    client_name,
    requested_date,
    requested_time_preference
  from public.waitlist_entries
  where user_id in (select user_id from seed_target)
    and client_id is not null
  limit 18
)
insert into public.activity_events (
  id,
  user_id,
  client_id,
  appointment_id,
  activity_type,
  title,
  description,
  occurred_at,
  metadata,
  dedupe_key
)
select
  pg_temp.seed_uuid('activity-waitlist-' || event_rows.event_no),
  seed_target.user_id,
  event_rows.client_id,
  null,
  'waitlist_joined',
  event_rows.client_name || ' joined the waitlist',
  'Seeded waitlist activity tied to a real client.',
  now() - ((event_rows.event_no + 80) || ' hours')::interval,
  jsonb_build_object(
    'client_name', event_rows.client_name,
    'requested_date', event_rows.requested_date,
    'requested_time_preference', event_rows.requested_time_preference,
    'source', 'stylist_created'
  ),
  'seed-waitlist-joined-' || event_rows.event_no
from event_rows
cross join seed_target;

with email_rows as (
  select
    row_number() over (order by a.appointment_date, a.id) as email_no,
    a.id as appointment_id,
    a.client_id,
    c.email as recipient_email,
    a.service_name,
    a.appointment_date,
    a.status
  from public.appointments a
  join public.clients c on c.id = a.client_id
  where a.user_id in (select user_id from seed_target)
    and a.appointment_date >= now()
    and c.email is not null
  order by a.appointment_date, a.id
  limit 36
)
insert into public.appointment_email_events (
  id,
  user_id,
  client_id,
  appointment_id,
  email_type,
  recipient_email,
  status,
  idempotency_key,
  provider,
  template_data,
  sent_at
)
select
  pg_temp.seed_uuid('appointment-email-' || email_rows.email_no),
  seed_target.user_id,
  email_rows.client_id,
  email_rows.appointment_id,
  case when email_rows.status = 'pending' then 'appointment_pending' else 'appointment_scheduled' end,
  email_rows.recipient_email,
  case when email_rows.email_no % 5 = 0 then 'sent' else 'queued' end,
  'seed-email-' || email_rows.email_no,
  case when email_rows.email_no % 5 = 0 then 'demo' else null end,
  jsonb_build_object(
    'service_name', email_rows.service_name,
    'appointment_start_time', email_rows.appointment_date,
    'status', email_rows.status
  ),
  case when email_rows.email_no % 5 = 0 then now() - (email_rows.email_no || ' minutes')::interval else null end
from email_rows
cross join seed_target;

commit;
