-- Focused CRM/demo seed.
--
-- Preserves auth logins and stylist/business configuration. This script does
-- not insert, update, or delete auth.users, auth.identities, public.users,
-- public.stylists, public.services, public.availability, public.booking_rules,
-- or public.stylist_off_days.
--
-- It resets only client/appointment-adjacent demo data for the target user:
-- clients, appointments, photos, reminders, waitlist entries, activity events,
-- referral attribution, automation queues, communication events, and appointment
-- email events.
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

delete from public.thank_you_emails
where user_id in (select user_id from seed_target);

delete from public.rebook_nudges
where user_id in (select user_id from seed_target);

delete from public.birthday_reminders
where user_id in (select user_id from seed_target);

delete from public.client_rebooking_preferences
where user_id in (select user_id from seed_target);

delete from public.communication_events
where user_id in (select user_id from seed_target);

delete from public.client_communication_preferences
where user_id in (select user_id from seed_target);

delete from public.referral_events
where user_id in (select user_id from seed_target);

delete from public.client_referral_links
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

delete from public.automation_settings
where user_id in (select user_id from seed_target);

do $$
begin
  if to_regclass('public.product_events') is not null then
    delete from public.product_events
    where account_user_id in (select user_id from seed_target);
  end if;

  if to_regclass('public.notification_events') is not null then
    delete from public.notification_events
    where account_user_id in (select user_id from seed_target);
  end if;

  if to_regclass('public.booking_error_events') is not null then
    delete from public.booking_error_events
    where account_user_id in (select user_id from seed_target);
  end if;
end
$$;

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
metric_slots as (
  select *
  from (
    values
      (1, -45, '18:00:00'::time, 'completed', 'public', 'Prior-month completed public booking for trend comparisons.'),
      (2, -38, '18:30:00'::time, 'completed', 'internal', 'Prior-month completed internal booking for revenue comparisons.'),
      (3, -31, '19:00:00'::time, 'no_show', 'public', 'Prior-month no-show for attendance metrics.'),
      (4, -24, '18:00:00'::time, 'cancelled', 'public', 'Cancelled appointment that creates a future waitlist opening.'),
      (5, -18, '18:30:00'::time, 'completed', 'public', 'Recent completed public booking for monthly metrics.'),
      (6, -12, '19:00:00'::time, 'completed', 'internal', 'Recent completed internal booking for monthly metrics.'),
      (7, -8, '18:00:00'::time, 'no_show', 'public', 'Recent no-show for no-show follow-up metrics.'),
      (8, -5, '18:30:00'::time, 'cancelled', 'public', 'Recent cancellation for activity and booking health metrics.'),
      (9, -2, '19:00:00'::time, 'completed', 'public', 'Very recent completed appointment for thank-you automation demos.'),
      (10, 0, '18:00:00'::time, 'scheduled', 'internal', 'Today scheduled appointment for calendar density.'),
      (11, 0, '19:30:00'::time, 'pending', 'public', 'Today pending public booking for approval demos.'),
      (12, 2, '18:00:00'::time, 'scheduled', 'public', 'Upcoming scheduled public booking for reminder demos.'),
      (13, 4, '18:30:00'::time, 'scheduled', 'internal', 'Upcoming scheduled internal booking for reminder demos.'),
      (14, 6, '19:00:00'::time, 'pending', 'public', 'Upcoming pending public booking for approval demos.'),
      (15, 8, '18:00:00'::time, 'cancelled', 'public', 'Future cancellation intentionally matching a waitlist request.'),
      (16, 10, '18:30:00'::time, 'scheduled', 'public', 'Upcoming scheduled public booking for forecast metrics.'),
      (17, 12, '19:00:00'::time, 'scheduled', 'internal', 'Upcoming scheduled internal booking for forecast metrics.'),
      (18, 14, '18:00:00'::time, 'cancelled', 'public', 'Future cancellation intentionally matching a waitlist request.'),
      (19, 18, '18:30:00'::time, 'scheduled', 'public', 'Upcoming scheduled public booking for forecast metrics.'),
      (20, 25, '19:00:00'::time, 'scheduled', 'public', 'Farther upcoming booking for booking-window demos.')
  ) as slots(slot_no, day_offset, start_time, status, booking_source, notes)
),
metric_appointments as (
  select
    pg_temp.seed_uuid('metric-appointment-' || metric_slots.slot_no) as id,
    seed_target.user_id,
    client_rows.client_id,
    seed_services.id as service_id,
    (
      date_trunc('day', now() at time zone 'America/Denver')::date
      + metric_slots.day_offset::integer
      + metric_slots.start_time
    ) at time zone 'America/Denver' as appointment_date,
    seed_services.name as service_name,
    seed_services.duration_minutes,
    seed_services.price,
    metric_slots.status,
    metric_slots.booking_source,
    metric_slots.notes
  from metric_slots
  join client_rows on client_rows.client_no = ((metric_slots.slot_no + 19) % 80) + 1
  cross join service_count
  join seed_services on seed_services.service_no = ((metric_slots.slot_no - 1) % service_count.total) + 1
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
  notes,
  status,
  booking_source,
  tstzrange(appointment_date, appointment_date + (duration_minutes * interval '1 minute'), '[)')
from metric_appointments;

insert into public.automation_settings (
  id,
  user_id,
  key,
  enabled
)
select
  pg_temp.seed_uuid('automation-setting-' || settings.key),
  seed_target.user_id,
  settings.key,
  settings.enabled
from (
  values
    ('rebook_nudges', true),
    ('appointment_reminders', true),
    ('email_confirmations', true),
    ('no_show_follow_up', true),
    ('waitlist_match', true),
    ('birthday_reminders', true),
    ('thank_you_emails', true)
) as settings(key, enabled)
cross join seed_target
on conflict (user_id, key) do update
set
  enabled = excluded.enabled,
  updated_at = now();

with link_seed as (
  select
    referrer_no,
    pg_temp.seed_uuid('referral-link-' || referrer_no) as referral_link_id,
    ('rf_seedref' || lpad(referrer_no::text, 4, '0')) as referral_code,
    case
      when referrer_no in (3, 4, 5) then 'email_campaign'
      when referrer_no in (6, 7) then 'thank_you_email'
      else 'client_share'
    end as source
  from generate_series(1, 16) as referrers(referrer_no)
),
client_rows as (
  select
    row_number() over (order by first_name, last_name, id) as client_no,
    id as client_id
  from public.clients
  where user_id in (select user_id from seed_target)
)
insert into public.client_referral_links (
  id,
  user_id,
  client_id,
  referral_code,
  referral_url,
  status,
  source,
  created_at,
  updated_at
)
select
  link_seed.referral_link_id,
  seed_target.user_id,
  client_rows.client_id,
  link_seed.referral_code,
  'https://app.shearsync.test/r/' || link_seed.referral_code,
  'active',
  link_seed.source,
  now() - ((link_seed.referrer_no * 2) || ' days')::interval,
  now() - ((link_seed.referrer_no * 2) || ' days')::interval
from link_seed
join client_rows on client_rows.client_no = link_seed.referrer_no
cross join seed_target;

with attribution_seed as (
  select
    attribution_no,
    ((attribution_no - 1) % 12) + 1 as referrer_no,
    40 + attribution_no as referred_no,
    now() - ((attribution_no % 18) || ' days')::interval as attributed_at,
    case
      when attribution_no <= 5 then pg_temp.seed_uuid('email-campaign-summer-gloss')
      when attribution_no <= 8 then pg_temp.seed_uuid('email-campaign-rebook-reminder')
      else null::uuid
    end as campaign_id
  from generate_series(1, 18) as attributions(attribution_no)
),
client_rows as (
  select
    row_number() over (order by first_name, last_name, id) as client_no,
    id as client_id
  from public.clients
  where user_id in (select user_id from seed_target)
),
resolved as (
  select
    attribution_seed.*,
    referrer.client_id as referrer_client_id,
    referred.client_id as referred_client_id,
    links.id as referral_link_id,
    links.referral_code
  from attribution_seed
  join client_rows referrer on referrer.client_no = attribution_seed.referrer_no
  join client_rows referred on referred.client_no = attribution_seed.referred_no
  join public.client_referral_links links
    on links.user_id in (select user_id from seed_target)
   and links.client_id = referrer.client_id
)
update public.clients c
set
  source = 'referral',
  original_referral_link_id = resolved.referral_link_id,
  original_referred_by_client_id = resolved.referrer_client_id,
  original_referral_code = resolved.referral_code,
  original_acquisition_source = 'client_referral_link',
  original_referral_attributed_at = resolved.attributed_at
from resolved
where c.id = resolved.referred_client_id;

with attribution_seed as (
  select
    attribution_no,
    ((attribution_no - 1) % 12) + 1 as referrer_no,
    40 + attribution_no as referred_no,
    now() - ((attribution_no % 18) || ' days')::interval as attributed_at
  from generate_series(1, 18) as attributions(attribution_no)
),
client_rows as (
  select
    row_number() over (order by first_name, last_name, id) as client_no,
    id as client_id
  from public.clients
  where user_id in (select user_id from seed_target)
),
resolved as (
  select
    attribution_seed.*,
    referrer.client_id as referrer_client_id,
    referred.client_id as referred_client_id,
    links.id as referral_link_id,
    links.referral_code
  from attribution_seed
  join client_rows referrer on referrer.client_no = attribution_seed.referrer_no
  join client_rows referred on referred.client_no = attribution_seed.referred_no
  join public.client_referral_links links
    on links.user_id in (select user_id from seed_target)
   and links.client_id = referrer.client_id
),
appointment_targets as (
  select
    resolved.*,
    appointment_target.id as appointment_id
  from resolved
  join lateral (
    select a.id
    from public.appointments a
    where a.user_id in (select user_id from seed_target)
      and a.client_id = resolved.referred_client_id
      and a.status <> 'cancelled'
    order by
      case when a.appointment_date >= date_trunc('month', now()) then 0 else 1 end,
      a.appointment_date desc,
      a.id
    limit 1
  ) appointment_target on true
)
update public.appointments a
set
  referral_link_id = appointment_targets.referral_link_id,
  referred_by_client_id = appointment_targets.referrer_client_id,
  referral_code_used = appointment_targets.referral_code,
  referral_attributed_at = appointment_targets.attributed_at,
  acquisition_source = 'client_referral_link'
from appointment_targets
where a.id = appointment_targets.appointment_id;

with link_rows as (
  select
    row_number() over (order by created_at, id) as link_no,
    id,
    user_id,
    client_id,
    referral_code,
    source,
    created_at
  from public.client_referral_links
  where user_id in (select user_id from seed_target)
),
opened_events as (
  select
    link_rows.*,
    open_no,
    case
      when link_rows.source = 'email_campaign' then pg_temp.seed_uuid('email-campaign-summer-gloss')
      else null::uuid
    end as campaign_id
  from link_rows
  join lateral generate_series(1, case when link_rows.link_no <= 8 then 4 else 2 end) as opens(open_no) on true
),
attributed_appointments as (
  select
    row_number() over (order by referral_attributed_at, id) as attribution_no,
    id,
    user_id,
    client_id,
    referral_link_id,
    referred_by_client_id,
    referral_code_used,
    referral_attributed_at,
    status,
    price
  from public.appointments
  where user_id in (select user_id from seed_target)
    and referral_link_id is not null
)
insert into public.referral_events (
  id,
  referral_link_id,
  user_id,
  referred_by_client_id,
  referred_client_id,
  appointment_id,
  event_type,
  source,
  campaign_id,
  metadata,
  created_at
)
select
  pg_temp.seed_uuid('referral-opened-' || opened_events.link_no || '-' || opened_events.open_no),
  opened_events.id,
  opened_events.user_id,
  opened_events.client_id,
  null,
  null,
  'opened',
  opened_events.source,
  opened_events.campaign_id,
  jsonb_build_object(
    'source', opened_events.source,
    'referral_code', opened_events.referral_code,
    'expires_at', now() + interval '30 days'
  ),
  greatest(opened_events.created_at, now() - ((opened_events.link_no + opened_events.open_no) || ' days')::interval)
from opened_events
union all
select
  pg_temp.seed_uuid('referral-booking-attributed-' || attributed_appointments.attribution_no),
  attributed_appointments.referral_link_id,
  attributed_appointments.user_id,
  attributed_appointments.referred_by_client_id,
  attributed_appointments.client_id,
  attributed_appointments.id,
  'booking_attributed',
  'client_referral_link',
  null,
  jsonb_build_object(
    'booked_client_id', attributed_appointments.client_id,
    'is_existing_client', false,
    'referral_code_used', attributed_appointments.referral_code_used
  ),
  attributed_appointments.referral_attributed_at
from attributed_appointments
union all
select
  pg_temp.seed_uuid('referral-appointment-completed-' || attributed_appointments.attribution_no),
  attributed_appointments.referral_link_id,
  attributed_appointments.user_id,
  attributed_appointments.referred_by_client_id,
  attributed_appointments.client_id,
  attributed_appointments.id,
  'appointment_completed',
  'client_referral_link',
  null,
  jsonb_build_object(
    'status', attributed_appointments.status,
    'price', attributed_appointments.price,
    'referral_code_used', attributed_appointments.referral_code_used
  ),
  attributed_appointments.referral_attributed_at + interval '2 hours'
from attributed_appointments
where attributed_appointments.status = 'completed';

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

with cancelled_openings as (
  select
    row_number() over (order by a.appointment_date, a.id) as match_no,
    a.id as appointment_id,
    a.client_id,
    a.service_id,
    a.service_name,
    a.appointment_date
  from public.appointments a
  where a.user_id in (select user_id from seed_target)
    and a.status = 'cancelled'
    and a.appointment_date >= now()
  order by a.appointment_date, a.id
  limit 4
),
client_rows as (
  select
    row_number() over (order by first_name, last_name, id) as client_no,
    id as client_id,
    first_name || ' ' || last_name as client_name,
    email,
    phone
  from public.clients
  where user_id in (select user_id from seed_target)
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
  source,
  created_at,
  updated_at
)
select
  pg_temp.seed_uuid('waitlist-opening-match-' || cancelled_openings.match_no),
  seed_target.user_id,
  client_rows.client_id,
  cancelled_openings.service_id,
  (cancelled_openings.appointment_date at time zone 'America/Denver')::date,
  'anytime',
  client_rows.client_name,
  client_rows.email,
  client_rows.phone,
  'Seeded waitlist request that intentionally matches a cancelled appointment opening.',
  'active',
  'public_booking',
  now() - ((cancelled_openings.match_no + 2) || ' hours')::interval,
  now() - ((cancelled_openings.match_no + 2) || ' hours')::interval
from cancelled_openings
join client_rows on client_rows.client_no = cancelled_openings.match_no + 30
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

with client_rows as (
  select
    row_number() over (order by first_name, last_name, id) as client_no,
    id as client_id,
    email,
    lower(email) as email_normalized,
    phone,
    phone_normalized
  from public.clients
  where user_id in (select user_id from seed_target)
)
insert into public.client_communication_preferences (
  id,
  user_id,
  client_id,
  email,
  email_normalized,
  phone,
  phone_normalized,
  email_transactional_enabled,
  email_reminders_enabled,
  email_marketing_enabled,
  email_rebooking_enabled,
  opted_out_all_email,
  email_opted_out_at,
  email_opt_out_source,
  sms_transactional_enabled,
  sms_reminders_enabled,
  sms_marketing_enabled,
  sms_rebooking_enabled,
  opted_out_all_sms,
  sms_opted_in_at,
  sms_opt_in_source,
  sms_opt_in_text
)
select
  pg_temp.seed_uuid('communication-preference-' || client_rows.client_no),
  seed_target.user_id,
  client_rows.client_id,
  client_rows.email,
  client_rows.email_normalized,
  client_rows.phone,
  client_rows.phone_normalized,
  true,
  client_rows.client_no % 13 <> 0,
  client_rows.client_no % 9 <> 0,
  client_rows.client_no % 11 <> 0,
  client_rows.client_no % 17 = 0,
  case when client_rows.client_no % 17 = 0 then now() - interval '7 days' else null end,
  case when client_rows.client_no % 17 = 0 then 'unsubscribe_link' else null end,
  true,
  client_rows.client_no % 4 <> 0,
  client_rows.client_no % 8 <> 0,
  client_rows.client_no % 6 <> 0,
  client_rows.client_no % 19 = 0,
  case when client_rows.client_no % 19 <> 0 then now() - interval '30 days' else null end,
  case when client_rows.client_no % 19 <> 0 then 'booking_page' else null end,
  case when client_rows.client_no % 19 <> 0 then 'I agree to receive appointment texts from this stylist.' else null end
from client_rows
cross join seed_target;

with client_rows as (
  select
    row_number() over (order by first_name, last_name, id) as client_no,
    id as client_id
  from public.clients
  where user_id in (select user_id from seed_target)
)
insert into public.client_rebooking_preferences (
  id,
  user_id,
  client_id,
  preferred_interval_days,
  source
)
select
  pg_temp.seed_uuid('client-rebooking-preference-' || client_rows.client_no),
  seed_target.user_id,
  client_rows.client_id,
  (array[42, 56, 70, 84, 98])[((client_rows.client_no - 1) % 5) + 1],
  'manual'
from client_rows
cross join seed_target
where client_rows.client_no <= 24;

with ranked_completed as (
  select
    row_number() over (order by a.appointment_date desc, a.id) as row_no,
    a.id as appointment_id,
    a.client_id,
    c.email as recipient_email,
    a.service_name,
    a.appointment_date
  from public.appointments a
  join public.clients c on c.id = a.client_id
  where a.user_id in (select user_id from seed_target)
    and a.status = 'completed'
    and c.email is not null
  order by a.appointment_date desc, a.id
  limit 16
)
insert into public.rebook_nudges (
  id,
  user_id,
  client_id,
  last_appointment_id,
  recipient_email,
  status,
  approval_required,
  send_after,
  rebook_interval_days,
  subject_snapshot,
  custom_message_block_snapshot,
  template_data,
  approved_at,
  approved_by,
  cancelled_at,
  cancelled_reason,
  sent_at,
  error
)
select
  pg_temp.seed_uuid('rebook-nudge-' || ranked_completed.row_no),
  seed_target.user_id,
  ranked_completed.client_id,
  ranked_completed.appointment_id,
  ranked_completed.recipient_email,
  case
    when ranked_completed.row_no in (1, 2, 3, 4, 5, 6) then 'queued'
    when ranked_completed.row_no in (7, 8, 9) then 'sent'
    when ranked_completed.row_no = 10 then 'failed'
    when ranked_completed.row_no = 11 then 'pending_approval'
    else 'cancelled'
  end,
  ranked_completed.row_no = 11,
  case
    when ranked_completed.row_no <= 6 then now() + (ranked_completed.row_no || ' days')::interval
    else now() - (ranked_completed.row_no || ' days')::interval
  end,
  (array[42, 56, 70, 84])[((ranked_completed.row_no - 1) % 4) + 1],
  'Time for your next ' || ranked_completed.service_name || '?',
  'Seeded rebook nudge for automation queue and customers-reached metrics.',
  jsonb_build_object(
    'client_id', ranked_completed.client_id,
    'service_name', ranked_completed.service_name,
    'last_appointment_at', ranked_completed.appointment_date
  ),
  case when ranked_completed.row_no = 11 then null when ranked_completed.row_no > 6 then now() - interval '10 days' else null end,
  case when ranked_completed.row_no > 6 and ranked_completed.row_no <> 11 then seed_target.user_id else null end,
  case when ranked_completed.row_no > 11 then now() - interval '5 days' else null end,
  case when ranked_completed.row_no > 11 then 'Seeded cancellation for automation status coverage.' else null end,
  case when ranked_completed.row_no in (7, 8, 9) then now() - (ranked_completed.row_no || ' days')::interval else null end,
  case when ranked_completed.row_no = 10 then 'Seeded provider failure for automation health.' else null end
from ranked_completed
cross join seed_target;

with birthday_rows as (
  select
    row_number() over (order by c.first_name, c.last_name, c.id) as row_no,
    c.id as client_id,
    c.first_name || ' ' || c.last_name as client_name,
    c.email as recipient_email,
    c.birthday
  from public.clients c
  where c.user_id in (select user_id from seed_target)
    and c.email is not null
    and c.birthday is not null
  order by c.first_name, c.last_name, c.id
  limit 14
)
insert into public.birthday_reminders (
  id,
  user_id,
  client_id,
  recipient_email,
  birthday,
  birthday_occurrence_date,
  scheduled_send_at,
  status,
  subject_snapshot,
  custom_message_block_snapshot,
  template_data,
  cancelled_at,
  cancelled_reason,
  sent_at,
  error
)
select
  pg_temp.seed_uuid('birthday-reminder-' || birthday_rows.row_no),
  seed_target.user_id,
  birthday_rows.client_id,
  birthday_rows.recipient_email,
  birthday_rows.birthday,
  make_date(
    extract(year from now())::integer,
    substring(birthday_rows.birthday from 4 for 2)::integer,
    least(substring(birthday_rows.birthday from 1 for 2)::integer, 28)
  ),
  case
    when birthday_rows.row_no <= 6 then now() + (birthday_rows.row_no || ' days')::interval
    else now() - (birthday_rows.row_no || ' days')::interval
  end,
  case
    when birthday_rows.row_no <= 6 then 'queued'
    when birthday_rows.row_no in (7, 8, 9, 10) then 'sent'
    when birthday_rows.row_no = 11 then 'failed'
    when birthday_rows.row_no = 12 then 'pending_approval'
    else 'cancelled'
  end,
  'Happy birthday from ShearSync',
  'Seeded birthday reminder for automation and email metrics.',
  jsonb_build_object(
    'client_name', birthday_rows.client_name,
    'birthday', birthday_rows.birthday
  ),
  case when birthday_rows.row_no > 12 then now() - interval '3 days' else null end,
  case when birthday_rows.row_no > 12 then 'Seeded cancellation for status coverage.' else null end,
  case when birthday_rows.row_no in (7, 8, 9, 10) then now() - (birthday_rows.row_no || ' days')::interval else null end,
  case when birthday_rows.row_no = 11 then 'Seeded provider failure for automation health.' else null end
from birthday_rows
cross join seed_target;

with completed_rows as (
  select
    row_number() over (order by a.appointment_date desc, a.id) as row_no,
    a.id as appointment_id,
    a.client_id,
    c.email as recipient_email,
    c.first_name || ' ' || c.last_name as client_name,
    a.service_name,
    a.appointment_date,
    links.id as referral_link_id,
    links.referral_code,
    links.referral_url
  from public.appointments a
  join public.clients c on c.id = a.client_id
  left join public.client_referral_links links
    on links.user_id = a.user_id
   and links.client_id = a.client_id
   and links.status = 'active'
  where a.user_id in (select user_id from seed_target)
    and a.status = 'completed'
    and c.email is not null
  order by a.appointment_date desc, a.id
  limit 14
)
insert into public.thank_you_emails (
  id,
  user_id,
  client_id,
  appointment_id,
  referral_link_id,
  recipient_email,
  status,
  approval_required,
  send_after,
  referral_code_snapshot,
  referral_url_snapshot,
  qr_code_url_snapshot,
  subject_snapshot,
  custom_message_block_snapshot,
  template_data,
  approved_at,
  approved_by,
  cancelled_at,
  cancelled_reason,
  sent_at,
  error
)
select
  pg_temp.seed_uuid('thank-you-email-' || completed_rows.row_no),
  seed_target.user_id,
  completed_rows.client_id,
  completed_rows.appointment_id,
  completed_rows.referral_link_id,
  completed_rows.recipient_email,
  case
    when completed_rows.row_no <= 5 then 'queued'
    when completed_rows.row_no in (6, 7, 8, 9) then 'sent'
    when completed_rows.row_no = 10 then 'failed'
    when completed_rows.row_no = 11 then 'pending_approval'
    else 'cancelled'
  end,
  completed_rows.row_no = 11,
  case
    when completed_rows.row_no <= 5 then now() + (completed_rows.row_no || ' hours')::interval
    else now() - (completed_rows.row_no || ' hours')::interval
  end,
  completed_rows.referral_code,
  completed_rows.referral_url,
  case when completed_rows.referral_url is not null then 'data:image/png;base64,seeded-referral-qr' else null end,
  'Thank you for visiting',
  'Seeded thank-you email with referral snapshot coverage.',
  jsonb_build_object(
    'client_name', completed_rows.client_name,
    'service_name', completed_rows.service_name,
    'appointment_start_time', completed_rows.appointment_date,
    'referral_url', completed_rows.referral_url,
    'referral_code', completed_rows.referral_code
  ),
  case when completed_rows.row_no in (6, 7, 8, 9) then now() - interval '1 day' else null end,
  case when completed_rows.row_no in (6, 7, 8, 9) then seed_target.user_id else null end,
  case when completed_rows.row_no > 11 then now() - interval '6 hours' else null end,
  case when completed_rows.row_no > 11 then 'Seeded cancellation for status coverage.' else null end,
  case when completed_rows.row_no in (6, 7, 8, 9) then now() - (completed_rows.row_no || ' hours')::interval else null end,
  case when completed_rows.row_no = 10 then 'Seeded provider failure for automation health.' else null end
from completed_rows
cross join seed_target;

with automation_email_rows as (
  select
    'rebook-nudge' as source_type,
    row_number() over (order by rn.created_at, rn.id) as source_no,
    rn.id as source_id,
    rn.user_id,
    rn.client_id,
    rn.last_appointment_id as appointment_id,
    rn.recipient_email,
    'rebooking_prompt' as email_type,
    rn.status as source_status,
    rn.template_data,
    rn.sent_at
  from public.rebook_nudges rn
  where rn.user_id in (select user_id from seed_target)
    and rn.status in ('queued', 'sending', 'sent', 'failed', 'skipped')
  union all
  select
    'birthday-reminder',
    row_number() over (order by br.created_at, br.id),
    br.id,
    br.user_id,
    br.client_id,
    null,
    br.recipient_email,
    'birthday_reminder',
    br.status,
    br.template_data,
    br.sent_at
  from public.birthday_reminders br
  where br.user_id in (select user_id from seed_target)
    and br.status in ('queued', 'sending', 'sent', 'failed', 'skipped')
  union all
  select
    'thank-you-email',
    row_number() over (order by tye.created_at, tye.id),
    tye.id,
    tye.user_id,
    tye.client_id,
    tye.appointment_id,
    tye.recipient_email,
    'thank_you_email',
    tye.status,
    tye.template_data,
    tye.sent_at
  from public.thank_you_emails tye
  where tye.user_id in (select user_id from seed_target)
    and tye.status in ('queued', 'sending', 'sent', 'failed', 'skipped')
),
inserted_events as (
  insert into public.appointment_email_events (
    id,
    user_id,
    client_id,
    appointment_id,
    rebook_nudge_id,
    birthday_reminder_id,
    thank_you_email_id,
    email_type,
    recipient_email,
    status,
    idempotency_key,
    provider,
    provider_message_id,
    template_data,
    error,
    attempt_count,
    last_attempt_at,
    sent_at,
    created_at,
    updated_at
  )
  select
    pg_temp.seed_uuid('automation-email-' || automation_email_rows.source_type || '-' || automation_email_rows.source_no),
    automation_email_rows.user_id,
    automation_email_rows.client_id,
    automation_email_rows.appointment_id,
    case when automation_email_rows.source_type = 'rebook-nudge' then automation_email_rows.source_id else null end,
    case when automation_email_rows.source_type = 'birthday-reminder' then automation_email_rows.source_id else null end,
    case when automation_email_rows.source_type = 'thank-you-email' then automation_email_rows.source_id else null end,
    automation_email_rows.email_type,
    automation_email_rows.recipient_email,
    automation_email_rows.source_status,
    'seed-' || automation_email_rows.source_type || '-email-' || automation_email_rows.source_no,
    case when automation_email_rows.source_status = 'sent' then 'demo' else null end,
    case when automation_email_rows.source_status = 'sent' then 'seed-message-' || automation_email_rows.source_no else null end,
    automation_email_rows.template_data,
    case when automation_email_rows.source_status = 'failed' then 'Seeded provider failure.' else null end,
    case when automation_email_rows.source_status in ('sent', 'failed') then 1 else 0 end,
    case when automation_email_rows.source_status in ('sent', 'failed') then coalesce(automation_email_rows.sent_at, now() - interval '1 hour') else null end,
    automation_email_rows.sent_at,
    case when automation_email_rows.source_status = 'queued' then now() - interval '30 minutes' else now() - interval '2 hours' end,
    now()
  from automation_email_rows
  returning id, rebook_nudge_id, birthday_reminder_id, thank_you_email_id
)
update public.rebook_nudges rn
set email_event_id = inserted_events.id
from inserted_events
where rn.id = inserted_events.rebook_nudge_id;

update public.birthday_reminders br
set email_event_id = email_events.id
from public.appointment_email_events email_events
where br.id = email_events.birthday_reminder_id
  and br.user_id in (select user_id from seed_target);

update public.thank_you_emails tye
set email_event_id = email_events.id
from public.appointment_email_events email_events
where tye.id = email_events.thank_you_email_id
  and tye.user_id in (select user_id from seed_target);

with sent_email_rows as (
  select
    row_number() over (order by sent_at nulls last, created_at, id) as row_no,
    user_id,
    client_id,
    email_type,
    recipient_email,
    status,
    sent_at,
    created_at
  from public.appointment_email_events
  where user_id in (select user_id from seed_target)
    and status in ('sent', 'failed', 'skipped')
  order by sent_at nulls last, created_at, id
  limit 40
)
insert into public.communication_events (
  id,
  user_id,
  client_id,
  channel,
  message_type,
  to_address,
  to_normalized,
  provider,
  provider_message_id,
  status,
  error_code,
  error_message,
  metadata,
  created_at
)
select
  pg_temp.seed_uuid('communication-event-email-' || sent_email_rows.row_no),
  sent_email_rows.user_id,
  sent_email_rows.client_id,
  'email',
  case sent_email_rows.email_type
    when 'appointment_reminder' then 'appointment_reminder'
    when 'appointment_cancelled' then 'appointment_cancelled'
    when 'appointment_rescheduled' then 'appointment_rescheduled'
    when 'rebooking_prompt' then 'rebooking_prompt'
    when 'birthday_reminder' then 'birthday_reminder'
    when 'thank_you_email' then 'marketing'
    else 'appointment_confirmation'
  end,
  sent_email_rows.recipient_email,
  lower(sent_email_rows.recipient_email),
  'demo',
  case when sent_email_rows.status = 'sent' then 'seed-provider-message-' || sent_email_rows.row_no else null end,
  case
    when sent_email_rows.status = 'sent' then 'delivered'
    when sent_email_rows.status = 'failed' then 'failed'
    else 'skipped_opted_out'
  end,
  case when sent_email_rows.status = 'failed' then 'seed_provider_failure' else null end,
  case when sent_email_rows.status = 'failed' then 'Seeded provider failure for communication health.' else null end,
  jsonb_build_object(
    'email_type', sent_email_rows.email_type,
    'source', 'seed'
  ),
  coalesce(sent_email_rows.sent_at, sent_email_rows.created_at)
from sent_email_rows;

with marketing_rows as (
  select
    row_number() over (order by links.created_at, links.id) as row_no,
    links.user_id,
    links.client_id,
    clients.email,
    links.referral_code
  from public.client_referral_links links
  join public.clients clients on clients.id = links.client_id
  where links.user_id in (select user_id from seed_target)
    and links.source = 'email_campaign'
)
insert into public.communication_events (
  id,
  user_id,
  client_id,
  channel,
  message_type,
  to_address,
  to_normalized,
  provider,
  provider_message_id,
  status,
  metadata,
  created_at
)
select
  pg_temp.seed_uuid('communication-event-campaign-' || marketing_rows.row_no),
  marketing_rows.user_id,
  marketing_rows.client_id,
  'email',
  'marketing',
  marketing_rows.email,
  lower(marketing_rows.email),
  'demo',
  'seed-campaign-message-' || marketing_rows.row_no,
  'delivered',
  jsonb_build_object(
    'campaign_id', pg_temp.seed_uuid('email-campaign-summer-gloss'),
    'campaign_name', 'Summer gloss referral push',
    'referral_code', marketing_rows.referral_code,
    'source', 'email_campaign'
  ),
  now() - (marketing_rows.row_no || ' days')::interval
from marketing_rows;

do $$
begin
  if to_regclass('public.product_events') is not null then
    insert into public.product_events (
      id,
      environment,
      account_user_id,
      actor_user_id,
      client_id,
      appointment_id,
      event_type,
      event_source,
      stylist_slug,
      dedupe_key,
      metadata,
      created_at
    )
    select
      pg_temp.seed_uuid('product-event-referral-link-created-' || row_number() over (order by links.created_at, links.id)),
      'local',
      links.user_id,
      links.user_id,
      links.client_id,
      null,
      'referral_link_created',
      'backend',
      stylists.slug,
      'seed-referral-link-created-' || links.id,
      jsonb_build_object('referral_link_id', links.id, 'source', links.source),
      links.created_at
    from public.client_referral_links links
    left join public.stylists stylists on stylists.user_id = links.user_id
    where links.user_id in (select user_id from seed_target)
    union all
    select
      pg_temp.seed_uuid('product-event-referral-click-' || row_number() over (order by events.created_at, events.id)),
      'local',
      events.user_id,
      null,
      events.referred_by_client_id,
      null,
      'referral_link_clicked',
      'public_booking',
      stylists.slug,
      'seed-referral-link-clicked-' || events.id,
      jsonb_build_object('referral_link_id', events.referral_link_id, 'source', events.source),
      events.created_at
    from public.referral_events events
    left join public.stylists stylists on stylists.user_id = events.user_id
    where events.user_id in (select user_id from seed_target)
      and events.event_type = 'opened'
    union all
    select
      pg_temp.seed_uuid('product-event-public-booking-' || row_number() over (order by appointments.created_at, appointments.id)),
      'local',
      appointments.user_id,
      null,
      appointments.client_id,
      appointments.id,
      case when appointments.referral_link_id is not null then 'referral_booking_submitted' else 'public_booking_submitted' end,
      'public_booking',
      stylists.slug,
      'seed-public-booking-' || appointments.id,
      jsonb_build_object(
        'status', appointments.status,
        'has_referral', appointments.referral_link_id is not null,
        'source', 'seed'
      ),
      coalesce(appointments.created_at, appointments.appointment_date)
    from public.appointments appointments
    left join public.stylists stylists on stylists.user_id = appointments.user_id
    where appointments.user_id in (select user_id from seed_target)
      and appointments.booking_source = 'public'
    limit 120;
  end if;

  if to_regclass('public.notification_events') is not null then
    insert into public.notification_events (
      id,
      environment,
      account_user_id,
      actor_user_id,
      client_id,
      appointment_id,
      notification_type,
      channel,
      status,
      provider,
      provider_message_id,
      provider_error_code,
      provider_error_message,
      metadata,
      created_at
    )
    select
      pg_temp.seed_uuid('notification-event-' || row_number() over (order by emails.created_at, emails.id)),
      'local',
      emails.user_id,
      null,
      emails.client_id,
      emails.appointment_id,
      case emails.email_type
        when 'appointment_reminder' then 'appointment_reminder'
        when 'rebooking_prompt' then 'rebook_nudge'
        when 'birthday_reminder' then 'birthday_reminder'
        when 'thank_you_email' then 'thank_you_email'
        else 'booking_confirmation'
      end,
      'email',
      case
        when emails.status = 'sent' then 'sent'
        when emails.status = 'failed' then 'failed'
        when emails.status = 'skipped' then 'skipped'
        else 'queued'
      end,
      coalesce(emails.provider, 'demo'),
      emails.provider_message_id,
      case when emails.status = 'failed' then 'seed_provider_failure' else null end,
      case when emails.status = 'failed' then emails.error else null end,
      jsonb_build_object('email_type', emails.email_type, 'source', 'seed'),
      emails.created_at
    from public.appointment_email_events emails
    where emails.user_id in (select user_id from seed_target)
    limit 80;
  end if;

  if to_regclass('public.booking_error_events') is not null then
    insert into public.booking_error_events (
      id,
      environment,
      account_user_id,
      client_id,
      appointment_id,
      stylist_slug,
      request_id,
      session_id,
      anonymous_id,
      step,
      error_code,
      severity,
      error_message,
      metadata,
      created_at
    )
    select
      pg_temp.seed_uuid('booking-error-event-' || error_rows.error_no),
      'local',
      seed_target.user_id,
      error_rows.client_id,
      null,
      stylists.slug,
      'seed-request-' || error_rows.error_no,
      'seed-session-' || error_rows.error_no,
      'seed-anonymous-' || error_rows.error_no,
      error_rows.step,
      error_rows.error_code,
      error_rows.severity,
      error_rows.error_message,
      jsonb_build_object('source', 'seed', 'slot', error_rows.error_no),
      now() - (error_rows.error_no || ' hours')::interval
    from (
      select
        row_number() over (order by clients.id) as error_no,
        clients.id as client_id,
        (array['booking_submission', 'availability_generation', 'waitlist_submit'])[((row_number() over (order by clients.id) - 1) % 3) + 1] as step,
        (array['booking_conflict', 'slot_unavailable', 'waitlist_create_failed'])[((row_number() over (order by clients.id) - 1) % 3) + 1] as error_code,
        (array['warning', 'info', 'error'])[((row_number() over (order by clients.id) - 1) % 3) + 1] as severity,
        'Seeded booking flow error for internal health metrics.' as error_message
      from public.clients clients
      where clients.user_id in (select user_id from seed_target)
      order by clients.id
      limit 9
    ) error_rows
    cross join seed_target
    left join public.stylists stylists on stylists.user_id = seed_target.user_id;
  end if;
end
$$;

do $$
declare
  referral_link_count integer;
  referred_client_count integer;
  referred_appointment_count integer;
  waitlist_match_count integer;
  automation_setting_count integer;
  automation_queue_count integer;
  failed_email_count integer;
begin
  select count(*) into referral_link_count
  from public.client_referral_links
  where user_id in (select user_id from seed_target)
    and status = 'active';

  select count(*) into referred_client_count
  from public.clients
  where user_id in (select user_id from seed_target)
    and original_referral_link_id is not null
    and original_referred_by_client_id is not null
    and original_referral_code is not null
    and original_referral_attributed_at is not null;

  select count(*) into referred_appointment_count
  from public.appointments
  where user_id in (select user_id from seed_target)
    and referral_link_id is not null
    and referred_by_client_id is not null
    and referral_code_used is not null
    and referral_attributed_at is not null;

  select count(*) into waitlist_match_count
  from public.waitlist_entries waitlist
  join public.appointments openings
    on openings.user_id = waitlist.user_id
   and openings.status = 'cancelled'
   and openings.service_id = waitlist.service_id
   and (openings.appointment_date at time zone 'America/Denver')::date = waitlist.requested_date
  where waitlist.user_id in (select user_id from seed_target)
    and waitlist.status = 'active'
    and waitlist.requested_date >= (now() at time zone 'America/Denver')::date;

  select count(*) into automation_setting_count
  from public.automation_settings
  where user_id in (select user_id from seed_target);

  select
    (
      (select count(*) from public.rebook_nudges where user_id in (select user_id from seed_target) and status = 'queued')
      + (select count(*) from public.birthday_reminders where user_id in (select user_id from seed_target) and status = 'queued')
      + (select count(*) from public.thank_you_emails where user_id in (select user_id from seed_target) and status = 'queued')
      + (select count(*) from public.appointment_email_events where user_id in (select user_id from seed_target) and email_type = 'appointment_reminder' and status in ('queued', 'sending'))
    )
  into automation_queue_count;

  select count(*) into failed_email_count
  from public.appointment_email_events
  where user_id in (select user_id from seed_target)
    and status = 'failed';

  if referral_link_count < 16 then
    raise exception 'Seed validation failed: expected at least 16 active referral links, found %', referral_link_count;
  end if;

  if referred_client_count < 18 then
    raise exception 'Seed validation failed: expected at least 18 referred clients, found %', referred_client_count;
  end if;

  if referred_appointment_count < 18 then
    raise exception 'Seed validation failed: expected at least 18 referred appointments, found %', referred_appointment_count;
  end if;

  if waitlist_match_count < 1 then
    raise exception 'Seed validation failed: expected at least one real waitlist/opening match, found %', waitlist_match_count;
  end if;

  if automation_setting_count < 7 then
    raise exception 'Seed validation failed: expected all 7 automation settings, found %', automation_setting_count;
  end if;

  if automation_queue_count < 10 then
    raise exception 'Seed validation failed: expected automation queue coverage, found % queued/sending rows', automation_queue_count;
  end if;

  if failed_email_count < 3 then
    raise exception 'Seed validation failed: expected failed email coverage for health metrics, found %', failed_email_count;
  end if;
end
$$;

commit;
