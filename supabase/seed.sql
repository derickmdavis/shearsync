-- Rich demo seed for the screenshot stylist.
-- Target stylist/user:
--   d87fb2aa-e129-450c-ad09-a7853a891590
--
-- This seed resets CRM/demo data for that user, keeps the account, and ensures
-- only the two screenshot services exist:
--   Cut & Shave  191de43d-d3ea-42a5-8ff8-5d46d9fa3c95
--   Cut          ff5d3c54-3d6d-4e3e-8fcb-f30ddb723cbb

do $$
declare
  target_user_id constant uuid := 'd87fb2aa-e129-450c-ad09-a7853a891590';
  target_email constant text := 'demo.barber@example.com';
begin
  insert into auth.users (
    instance_id,
    id,
    aud,
    role,
    email,
    encrypted_password,
    email_confirmed_at,
    raw_app_meta_data,
    raw_user_meta_data,
    created_at,
    updated_at
  )
  values (
    '00000000-0000-0000-0000-000000000000',
    target_user_id,
    'authenticated',
    'authenticated',
    target_email,
    crypt('password123', gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Demo Barber","business_name":"Demo Barber Studio"}'::jsonb,
    now(),
    now()
  )
  on conflict (id) do update set
    email = excluded.email,
    encrypted_password = excluded.encrypted_password,
    email_confirmed_at = excluded.email_confirmed_at,
    raw_app_meta_data = excluded.raw_app_meta_data,
    raw_user_meta_data = excluded.raw_user_meta_data,
    updated_at = now();

  insert into auth.identities (
    id,
    user_id,
    provider_id,
    identity_data,
    provider,
    last_sign_in_at,
    created_at,
    updated_at
  )
  values (
    target_user_id,
    target_user_id,
    target_user_id::text,
    jsonb_build_object('sub', target_user_id::text, 'email', target_email),
    'email',
    now(),
    now(),
    now()
  )
  on conflict (provider, provider_id) do update set
    identity_data = excluded.identity_data,
    updated_at = now();
end
$$;

do $$
begin
  if to_regclass('public.appointment_email_events') is not null then
    delete from public.appointment_email_events
    where user_id = 'd87fb2aa-e129-450c-ad09-a7853a891590';
  end if;

  if to_regclass('public.activity_events') is not null then
    delete from public.activity_events
    where user_id = 'd87fb2aa-e129-450c-ad09-a7853a891590';
  end if;

  if to_regclass('public.waitlist_entries') is not null then
    delete from public.waitlist_entries
    where user_id = 'd87fb2aa-e129-450c-ad09-a7853a891590';
  end if;
end
$$;

delete from public.reminders
where user_id = 'd87fb2aa-e129-450c-ad09-a7853a891590';

delete from public.appointments
where user_id = 'd87fb2aa-e129-450c-ad09-a7853a891590';

delete from public.clients
where user_id = 'd87fb2aa-e129-450c-ad09-a7853a891590';

delete from public.availability
where user_id = 'd87fb2aa-e129-450c-ad09-a7853a891590';

delete from public.stylist_off_days
where user_id = 'd87fb2aa-e129-450c-ad09-a7853a891590';

delete from public.services
where user_id = 'd87fb2aa-e129-450c-ad09-a7853a891590'
  and id not in (
    '191de43d-d3ea-42a5-8ff8-5d46d9fa3c95',
    'ff5d3c54-3d6d-4e3e-8fcb-f30ddb723cbb'
  );

insert into public.users (
  id,
  email,
  full_name,
  phone_number,
  business_name,
  timezone,
  plan_tier,
  plan_status,
  sms_monthly_limit,
  sms_used_this_month,
  waitlist_enabled,
  plan_updated_at
)
values (
  'd87fb2aa-e129-450c-ad09-a7853a891590',
  'demo.barber@example.com',
  'Demo Barber',
  '+15550101000',
  'Demo Barber Studio',
  'America/Denver',
  'premium',
  'active',
  1000,
  184,
  true,
  now()
)
on conflict (id) do update set
  email = excluded.email,
  full_name = excluded.full_name,
  phone_number = excluded.phone_number,
  business_name = excluded.business_name,
  timezone = excluded.timezone,
  plan_tier = excluded.plan_tier,
  plan_status = excluded.plan_status,
  sms_monthly_limit = excluded.sms_monthly_limit,
  sms_used_this_month = excluded.sms_used_this_month,
  waitlist_enabled = excluded.waitlist_enabled,
  plan_updated_at = excluded.plan_updated_at;

insert into public.stylists (
  user_id,
  slug,
  display_name,
  bio,
  cover_photo_url,
  instagram,
  booking_enabled,
  intelligent_scheduling_enabled
)
values (
  'd87fb2aa-e129-450c-ad09-a7853a891590',
  'demo-barber',
  'Demo Barber',
  'Clean cuts, sharp shaves, and an easy booking flow.',
  null,
  'demobarber',
  true,
  true
)
on conflict (user_id) do update set
  slug = excluded.slug,
  display_name = excluded.display_name,
  bio = excluded.bio,
  cover_photo_url = excluded.cover_photo_url,
  instagram = excluded.instagram,
  booking_enabled = excluded.booking_enabled,
  intelligent_scheduling_enabled = excluded.intelligent_scheduling_enabled;

insert into public.booking_rules (
  user_id,
  lead_time_hours,
  same_day_booking_allowed,
  same_day_booking_cutoff,
  max_booking_window_days,
  cancellation_window_hours,
  late_cancellation_fee_enabled,
  late_cancellation_fee_type,
  late_cancellation_fee_value,
  allow_cancellation_after_cutoff,
  reschedule_window_hours,
  max_reschedules,
  same_day_rescheduling_allowed,
  preserve_appointment_history,
  new_client_approval_required,
  new_client_booking_window_days,
  restrict_services_for_new_clients,
  restricted_service_ids
)
values (
  'd87fb2aa-e129-450c-ad09-a7853a891590',
  1,
  true,
  '16:00:00',
  60,
  12,
  false,
  'flat',
  0,
  false,
  12,
  null,
  true,
  true,
  false,
  60,
  false,
  '{}'
)
on conflict (user_id) do update set
  lead_time_hours = excluded.lead_time_hours,
  same_day_booking_allowed = excluded.same_day_booking_allowed,
  same_day_booking_cutoff = excluded.same_day_booking_cutoff,
  max_booking_window_days = excluded.max_booking_window_days,
  cancellation_window_hours = excluded.cancellation_window_hours,
  late_cancellation_fee_enabled = excluded.late_cancellation_fee_enabled,
  late_cancellation_fee_type = excluded.late_cancellation_fee_type,
  late_cancellation_fee_value = excluded.late_cancellation_fee_value,
  allow_cancellation_after_cutoff = excluded.allow_cancellation_after_cutoff,
  reschedule_window_hours = excluded.reschedule_window_hours,
  max_reschedules = excluded.max_reschedules,
  same_day_rescheduling_allowed = excluded.same_day_rescheduling_allowed,
  preserve_appointment_history = excluded.preserve_appointment_history,
  new_client_approval_required = excluded.new_client_approval_required,
  new_client_booking_window_days = excluded.new_client_booking_window_days,
  restrict_services_for_new_clients = excluded.restrict_services_for_new_clients,
  restricted_service_ids = excluded.restricted_service_ids;

insert into public.services (
  id,
  user_id,
  name,
  description,
  category,
  duration_minutes,
  price,
  is_active,
  is_default,
  sort_order
)
values
  (
    '191de43d-d3ea-42a5-8ff8-5d46d9fa3c95',
    'd87fb2aa-e129-450c-ad09-a7853a891590',
    'Cut & Shave',
    'Haircut with hot towel shave and finishing style.',
    'Barbering',
    60,
    75,
    true,
    false,
    1
  ),
  (
    'ff5d3c54-3d6d-4e3e-8fcb-f30ddb723cbb',
    'd87fb2aa-e129-450c-ad09-a7853a891590',
    'Cut',
    'Classic haircut with cleanup and style.',
    'Barbering',
    30,
    45,
    true,
    true,
    2
  )
on conflict (id) do update set
  user_id = excluded.user_id,
  name = excluded.name,
  description = excluded.description,
  category = excluded.category,
  duration_minutes = excluded.duration_minutes,
  price = excluded.price,
  is_active = excluded.is_active,
  is_default = excluded.is_default,
  sort_order = excluded.sort_order;

insert into public.availability (
  user_id,
  day_of_week,
  start_time,
  end_time,
  client_audience,
  is_active
)
values
  ('d87fb2aa-e129-450c-ad09-a7853a891590', 1, '09:00:00', '17:00:00', 'all', true),
  ('d87fb2aa-e129-450c-ad09-a7853a891590', 2, '09:00:00', '17:00:00', 'all', true),
  ('d87fb2aa-e129-450c-ad09-a7853a891590', 3, '09:00:00', '17:00:00', 'all', true),
  ('d87fb2aa-e129-450c-ad09-a7853a891590', 4, '09:00:00', '17:00:00', 'all', true),
  ('d87fb2aa-e129-450c-ad09-a7853a891590', 5, '09:00:00', '17:00:00', 'all', true),
  ('d87fb2aa-e129-450c-ad09-a7853a891590', 6, '10:00:00', '14:00:00', 'all', true);

with client_seed as (
  select *
  from (
    values
      (1, 'Marcus', 'Reed', '1986-01-12'::date, 'marcus.reed@example.com', '+15552010001', '(555) 201-0001', 615::numeric, array['regular', 'cut']),
      (2, 'Andre', 'Parker', '1991-02-18'::date, 'andre.parker@example.com', '+15552010002', '(555) 201-0002', 430::numeric, array['shave']),
      (3, 'Caleb', 'Brooks', '1989-03-09'::date, 'caleb.brooks@example.com', '+15552010003', '(555) 201-0003', 705::numeric, array['regular']),
      (4, 'Devin', 'Hayes', '1994-04-22'::date, 'devin.hayes@example.com', '+15552010004', '(555) 201-0004', 265::numeric, array['new']),
      (5, 'Eli', 'Foster', '1982-05-05'::date, 'eli.foster@example.com', '+15552010005', '(555) 201-0005', 780::numeric, array['cut-and-shave']),
      (6, 'Noah', 'Bennett', '1997-06-13'::date, 'noah.bennett@example.com', '+15552010006', '(555) 201-0006', 350::numeric, array['cut']),
      (7, 'Luis', 'Santos', '1985-07-28'::date, 'luis.santos@example.com', '+15552010007', '(555) 201-0007', 520::numeric, array['regular']),
      (8, 'Owen', 'Carter', '1990-08-16'::date, 'owen.carter@example.com', '+15552010008', '(555) 201-0008', 460::numeric, array['shave']),
      (9, 'Theo', 'Mitchell', '1993-09-21'::date, 'theo.mitchell@example.com', '+15552010009', '(555) 201-0009', 600::numeric, array['regular']),
      (10, 'Isaac', 'Ross', '1988-10-30'::date, 'isaac.ross@example.com', '+15552010010', '(555) 201-0010', 255::numeric, array['cut']),
      (11, 'Miles', 'Cooper', '1995-11-08'::date, 'miles.cooper@example.com', '+15552010011', '(555) 201-0011', 840::numeric, array['vip']),
      (12, 'Julian', 'Gray', '1984-12-19'::date, 'julian.gray@example.com', '+15552010012', '(555) 201-0012', 390::numeric, array['regular']),
      (13, 'Aaron', 'Diaz', '1992-01-25'::date, 'aaron.diaz@example.com', '+15552010013', '(555) 201-0013', 475::numeric, array['cut']),
      (14, 'Ben', 'Morris', '1987-02-07'::date, 'ben.morris@example.com', '+15552010014', '(555) 201-0014', 535::numeric, array['shave']),
      (15, 'Cole', 'Watson', '1996-03-17'::date, 'cole.watson@example.com', '+15552010015', '(555) 201-0015', 225::numeric, array['new']),
      (16, 'Dylan', 'Price', '1983-04-29'::date, 'dylan.price@example.com', '+15552010016', '(555) 201-0016', 690::numeric, array['regular']),
      (17, 'Finn', 'Howard', '1999-05-31'::date, 'finn.howard@example.com', '+15552010017', '(555) 201-0017', 315::numeric, array['cut']),
      (18, 'Gabe', 'Ward', '1981-06-11'::date, 'gabe.ward@example.com', '+15552010018', '(555) 201-0018', 560::numeric, array['regular']),
      (19, 'Henry', 'Bell', '1990-07-04'::date, 'henry.bell@example.com', '+15552010019', '(555) 201-0019', 410::numeric, array['shave']),
      (20, 'Ian', 'Murphy', '1986-08-24'::date, 'ian.murphy@example.com', '+15552010020', '(555) 201-0020', 745::numeric, array['vip']),
      (21, 'Jace', 'Bailey', '1994-09-02'::date, 'jace.bailey@example.com', '+15552010021', '(555) 201-0021', 330::numeric, array['cut']),
      (22, 'Kai', 'Rivera', '1989-10-14'::date, 'kai.rivera@example.com', '+15552010022', '(555) 201-0022', 510::numeric, array['regular']),
      (23, 'Leo', 'Collins', '1998-11-27'::date, 'leo.collins@example.com', '+15552010023', '(555) 201-0023', 290::numeric, array['new']),
      (24, 'Mateo', 'Stewart', '1982-12-03'::date, 'mateo.stewart@example.com', '+15552010024', '(555) 201-0024', 650::numeric, array['cut-and-shave']),
      (25, 'Nico', 'Powell', '1991-01-06'::date, 'nico.powell@example.com', '+15552010025', '(555) 201-0025', 375::numeric, array['cut']),
      (26, 'Omar', 'Long', '1985-02-20'::date, 'omar.long@example.com', '+15552010026', '(555) 201-0026', 720::numeric, array['regular']),
      (27, 'Quinn', 'Bryant', '1993-03-15'::date, 'quinn.bryant@example.com', '+15552010027', '(555) 201-0027', 455::numeric, array['shave']),
      (28, 'Rafael', 'Coleman', '1988-04-10'::date, 'rafael.coleman@example.com', '+15552010028', '(555) 201-0028', 585::numeric, array['regular']),
      (29, 'Silas', 'Jenkins', '1996-05-26'::date, 'silas.jenkins@example.com', '+15552010029', '(555) 201-0029', 245::numeric, array['new']),
      (30, 'Troy', 'Perry', '1987-06-18'::date, 'troy.perry@example.com', '+15552010030', '(555) 201-0030', 805::numeric, array['vip']),
      (31, 'Victor', 'Hughes', '1992-07-12'::date, 'victor.hughes@example.com', '+15552010031', '(555) 201-0031', 365::numeric, array['cut']),
      (32, 'Wes', 'Flores', '1984-08-08'::date, 'wes.flores@example.com', '+15552010032', '(555) 201-0032', 540::numeric, array['regular']),
      (33, 'Xavier', 'Butler', '1995-09-19'::date, 'xavier.butler@example.com', '+15552010033', '(555) 201-0033', 420::numeric, array['shave']),
      (34, 'Yusuf', 'Simmons', '1989-10-23'::date, 'yusuf.simmons@example.com', '+15552010034', '(555) 201-0034', 675::numeric, array['regular']),
      (35, 'Zane', 'Russell', '1997-11-30'::date, 'zane.russell@example.com', '+15552010035', '(555) 201-0035', 310::numeric, array['cut']),
      (36, 'Adrian', 'Griffin', '1983-12-06'::date, 'adrian.griffin@example.com', '+15552010036', '(555) 201-0036', 590::numeric, array['cut-and-shave'])
  ) as seed(idx, first_name, last_name, birthday, email, phone_normalized, phone, total_spend, tags)
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
  (
    substr(md5('seed-client-' || idx), 1, 8) || '-' ||
    substr(md5('seed-client-' || idx), 9, 4) || '-' ||
    substr(md5('seed-client-' || idx), 13, 4) || '-' ||
    substr(md5('seed-client-' || idx), 17, 4) || '-' ||
    substr(md5('seed-client-' || idx), 21, 12)
  )::uuid,
  'd87fb2aa-e129-450c-ad09-a7853a891590',
  first_name,
  last_name,
  first_name,
  phone,
  phone_normalized,
  email,
  lower(first_name || '.' || last_name),
  birthday,
  'Seed client with history for dashboard and rebooking metrics.',
  case when idx % 5 = 0 then 'email' when idx % 4 = 0 then 'call' else 'text' end,
  tags,
  case when idx % 4 = 0 then 'referral' when idx % 4 = 1 then 'instagram' when idx % 4 = 2 then 'walk-in' else 'existing-client' end,
  idx % 6 <> 0,
  total_spend,
  now() - ((idx % 24 + 12) || ' days')::interval
from client_seed;

with client_rows as (
  select
    row_number() over (order by first_name, last_name) as idx,
    id as client_id
  from public.clients
  where user_id = 'd87fb2aa-e129-450c-ad09-a7853a891590'
),
past_appointments as (
  select
    (
      substr(md5('seed-past-appointment-' || client_rows.idx || '-' || series.appointment_no), 1, 8) || '-' ||
      substr(md5('seed-past-appointment-' || client_rows.idx || '-' || series.appointment_no), 9, 4) || '-' ||
      substr(md5('seed-past-appointment-' || client_rows.idx || '-' || series.appointment_no), 13, 4) || '-' ||
      substr(md5('seed-past-appointment-' || client_rows.idx || '-' || series.appointment_no), 17, 4) || '-' ||
      substr(md5('seed-past-appointment-' || client_rows.idx || '-' || series.appointment_no), 21, 12)
    )::uuid as id,
    client_rows.client_id,
    client_rows.idx,
    series.appointment_no,
    case when (client_rows.idx + series.appointment_no) % 3 = 0 then 'Cut & Shave' else 'Cut' end as service_name,
    case when (client_rows.idx + series.appointment_no) % 3 = 0 then 60 else 30 end as duration_minutes,
    case when (client_rows.idx + series.appointment_no) % 3 = 0 then 75 else 45 end as price,
    (
      date_trunc('day', now())
      - ((12 + client_rows.idx * 3 + series.appointment_no * 11) || ' days')::interval
      + ((9 + ((client_rows.idx + series.appointment_no) % 7)) || ' hours')::interval
    ) as appointment_date
  from client_rows
  cross join lateral generate_series(1, 1 + (client_rows.idx % 3)) as series(appointment_no)
)
insert into public.appointments (
  id,
  user_id,
  client_id,
  appointment_date,
  service_name,
  duration_minutes,
  price,
  notes,
  status,
  booking_source
)
select
  id,
  'd87fb2aa-e129-450c-ad09-a7853a891590',
  client_id,
  appointment_date,
  service_name,
  duration_minutes,
  price,
  'Seeded past appointment for client history.',
  'completed',
  case when appointment_no % 2 = 0 then 'public' else 'internal' end
from past_appointments;

with schedule_slots as (
  select *
  from (
    values
      (1, 0, '09:00:00'::time, 'Cut', 30, 45, 'scheduled'),
      (2, 0, '09:30:00'::time, 'Cut', 30, 45, 'scheduled'),
      (3, 0, '10:00:00'::time, 'Cut & Shave', 60, 75, 'scheduled'),
      (4, 0, '11:00:00'::time, 'Cut', 30, 45, 'scheduled'),
      (5, 0, '11:30:00'::time, 'Cut', 30, 45, 'scheduled'),
      (6, 0, '12:00:00'::time, 'Cut & Shave', 60, 75, 'scheduled'),
      (7, 0, '13:00:00'::time, 'Cut', 30, 45, 'scheduled'),
      (8, 0, '13:30:00'::time, 'Cut', 30, 45, 'scheduled'),
      (9, 0, '14:00:00'::time, 'Cut & Shave', 60, 75, 'scheduled'),
      (10, 0, '15:00:00'::time, 'Cut', 30, 45, 'pending'),
      (11, 0, '15:30:00'::time, 'Cut', 30, 45, 'scheduled'),
      (12, 0, '16:00:00'::time, 'Cut & Shave', 60, 75, 'scheduled'),
      (13, 1, '09:00:00'::time, 'Cut', 30, 45, 'scheduled'),
      (14, 1, '09:30:00'::time, 'Cut', 30, 45, 'scheduled'),
      (15, 1, '10:00:00'::time, 'Cut & Shave', 60, 75, 'scheduled'),
      (16, 1, '11:00:00'::time, 'Cut', 30, 45, 'scheduled'),
      (17, 1, '11:30:00'::time, 'Cut', 30, 45, 'scheduled'),
      (18, 1, '12:00:00'::time, 'Cut & Shave', 60, 75, 'scheduled'),
      (19, 1, '13:00:00'::time, 'Cut', 30, 45, 'scheduled'),
      (20, 1, '13:30:00'::time, 'Cut', 30, 45, 'scheduled'),
      (21, 1, '14:00:00'::time, 'Cut & Shave', 60, 75, 'scheduled'),
      (22, 1, '15:00:00'::time, 'Cut', 30, 45, 'pending'),
      (23, 1, '15:30:00'::time, 'Cut', 30, 45, 'scheduled'),
      (24, 1, '16:00:00'::time, 'Cut & Shave', 60, 75, 'scheduled'),
      (25, 2, '09:00:00'::time, 'Cut', 30, 45, 'scheduled'),
      (26, 2, '10:00:00'::time, 'Cut & Shave', 60, 75, 'scheduled'),
      (27, 2, '11:30:00'::time, 'Cut', 30, 45, 'scheduled'),
      (28, 2, '13:00:00'::time, 'Cut', 30, 45, 'scheduled'),
      (29, 2, '14:00:00'::time, 'Cut & Shave', 60, 75, 'scheduled'),
      (30, 2, '15:30:00'::time, 'Cut', 30, 45, 'pending'),
      (31, 3, '09:00:00'::time, 'Cut', 30, 45, 'scheduled'),
      (32, 3, '09:30:00'::time, 'Cut', 30, 45, 'scheduled'),
      (33, 3, '10:00:00'::time, 'Cut & Shave', 60, 75, 'scheduled'),
      (34, 3, '11:00:00'::time, 'Cut', 30, 45, 'scheduled'),
      (35, 3, '11:30:00'::time, 'Cut', 30, 45, 'scheduled'),
      (36, 3, '12:00:00'::time, 'Cut & Shave', 60, 75, 'scheduled'),
      (37, 3, '13:00:00'::time, 'Cut', 30, 45, 'scheduled'),
      (38, 3, '13:30:00'::time, 'Cut', 30, 45, 'scheduled'),
      (39, 3, '14:00:00'::time, 'Cut & Shave', 60, 75, 'scheduled'),
      (40, 3, '15:00:00'::time, 'Cut', 30, 45, 'scheduled'),
      (41, 3, '15:30:00'::time, 'Cut', 30, 45, 'scheduled'),
      (42, 3, '16:00:00'::time, 'Cut & Shave', 60, 75, 'scheduled'),
      (43, 4, '09:30:00'::time, 'Cut', 30, 45, 'scheduled'),
      (44, 4, '10:30:00'::time, 'Cut & Shave', 60, 75, 'scheduled'),
      (45, 4, '12:00:00'::time, 'Cut', 30, 45, 'scheduled'),
      (46, 4, '13:30:00'::time, 'Cut', 30, 45, 'scheduled'),
      (47, 4, '15:00:00'::time, 'Cut & Shave', 60, 75, 'pending'),
      (48, 5, '09:00:00'::time, 'Cut', 30, 45, 'scheduled'),
      (49, 5, '10:00:00'::time, 'Cut & Shave', 60, 75, 'scheduled'),
      (50, 5, '11:30:00'::time, 'Cut', 30, 45, 'scheduled'),
      (51, 5, '13:00:00'::time, 'Cut', 30, 45, 'scheduled'),
      (52, 5, '14:30:00'::time, 'Cut & Shave', 60, 75, 'scheduled'),
      (53, 6, '09:00:00'::time, 'Cut', 30, 45, 'scheduled'),
      (54, 6, '10:00:00'::time, 'Cut & Shave', 60, 75, 'scheduled'),
      (55, 6, '11:30:00'::time, 'Cut', 30, 45, 'pending'),
      (56, 6, '13:00:00'::time, 'Cut', 30, 45, 'scheduled'),
      (57, 6, '14:00:00'::time, 'Cut & Shave', 60, 75, 'scheduled')
  ) as seed(slot_no, day_offset, start_time, service_name, duration_minutes, price, status)
),
client_rows as (
  select
    row_number() over (order by first_name, last_name) as idx,
    id as client_id
  from public.clients
  where user_id = 'd87fb2aa-e129-450c-ad09-a7853a891590'
),
future_appointments as (
  select
    (
      substr(md5('seed-future-appointment-' || schedule_slots.slot_no), 1, 8) || '-' ||
      substr(md5('seed-future-appointment-' || schedule_slots.slot_no), 9, 4) || '-' ||
      substr(md5('seed-future-appointment-' || schedule_slots.slot_no), 13, 4) || '-' ||
      substr(md5('seed-future-appointment-' || schedule_slots.slot_no), 17, 4) || '-' ||
      substr(md5('seed-future-appointment-' || schedule_slots.slot_no), 21, 12)
    )::uuid as id,
    client_rows.client_id,
    schedule_slots.slot_no,
    schedule_slots.service_name,
    schedule_slots.duration_minutes,
    schedule_slots.price,
    schedule_slots.status,
    (
      date_trunc('day', now() at time zone 'America/Denver')::date
      + schedule_slots.day_offset
      + schedule_slots.start_time
    ) at time zone 'America/Denver' as appointment_date
  from schedule_slots
  join client_rows on client_rows.idx = ((schedule_slots.slot_no - 1) % 36) + 1
)
insert into public.appointments (
  id,
  user_id,
  client_id,
  appointment_date,
  service_name,
  duration_minutes,
  price,
  notes,
  status,
  booking_source
)
select
  id,
  'd87fb2aa-e129-450c-ad09-a7853a891590',
  client_id,
  appointment_date,
  service_name,
  duration_minutes,
  price,
  case
    when status = 'pending' then 'Seeded pending online booking requiring approval.'
    else 'Seeded upcoming appointment for dashboard density.'
  end,
  status,
  'public'
from future_appointments;

insert into public.stylist_off_days (
  user_id,
  date,
  label,
  reason,
  is_recurring
)
values
  (
    'd87fb2aa-e129-450c-ad09-a7853a891590',
    (date_trunc('day', now()) + interval '9 days')::date,
    'Shop closed',
    'Private event',
    false
  ),
  (
    'd87fb2aa-e129-450c-ad09-a7853a891590',
    (date_trunc('day', now()) + interval '16 days')::date,
    'Training day',
    'Advanced barbering workshop',
    false
  )
on conflict (user_id, date) do update set
  label = excluded.label,
  reason = excluded.reason,
  is_recurring = excluded.is_recurring;

with client_rows as (
  select
    row_number() over (order by first_name, last_name) as idx,
    id as client_id
  from public.clients
  where user_id = 'd87fb2aa-e129-450c-ad09-a7853a891590'
),
reminder_seed as (
  select *
  from (
    values
      (1, 1, 1, 'Confirm tomorrow appointments', 'sms', 'appointment_reminder'),
      (2, 2, 2, 'Ask about beard length preference', 'sms', 'general'),
      (3, 3, 3, 'Follow up about rebook', 'email', 'follow_up'),
      (4, 4, 5, 'Send haircut maintenance note', 'email', 'follow_up'),
      (5, 5, 7, 'Check product recommendation', 'sms', 'general'),
      (6, 6, 10, 'Invite back for monthly cut', 'sms', 'follow_up')
  ) as seed(reminder_no, client_idx, day_offset, title, channel, reminder_type)
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
  (
    substr(md5('seed-reminder-' || reminder_seed.reminder_no), 1, 8) || '-' ||
    substr(md5('seed-reminder-' || reminder_seed.reminder_no), 9, 4) || '-' ||
    substr(md5('seed-reminder-' || reminder_seed.reminder_no), 13, 4) || '-' ||
    substr(md5('seed-reminder-' || reminder_seed.reminder_no), 17, 4) || '-' ||
    substr(md5('seed-reminder-' || reminder_seed.reminder_no), 21, 12)
  )::uuid,
  'd87fb2aa-e129-450c-ad09-a7853a891590',
  client_rows.client_id,
  null,
  reminder_seed.title,
  date_trunc('day', now()) + (reminder_seed.day_offset || ' days')::interval + interval '9 hours',
  'open',
  reminder_seed.channel,
  reminder_seed.reminder_type,
  'Seeded reminder for homescreen reminders.'
from reminder_seed
join client_rows on client_rows.idx = reminder_seed.client_idx;

with waitlist_seed as (
  select *
  from (
    values
      (1, 2,  'Cut',         'morning',   'Drew Walker',   'drew.walker@example.com',   '(555) 301-0101'),
      (2, 2,  'Cut & Shave', 'afternoon', 'Mason King',    'mason.king@example.com',    '(555) 301-0102'),
      (3, 2,  'Cut',         'anytime',   'Ty Ellis',      'ty.ellis@example.com',      '(555) 301-0103'),
      (4, 3,  'Cut & Shave', 'morning',   'Grant Fisher',  'grant.fisher@example.com',  '(555) 301-0104'),
      (5, 3,  'Cut',         'afternoon', 'Roman Cruz',    'roman.cruz@example.com',    '(555) 301-0105'),
      (6, 3,  'Cut',         'anytime',   'Blake Woods',   'blake.woods@example.com',   '(555) 301-0106'),
      (7, 6,  'Cut & Shave', 'morning',   'Evan Knight',   'evan.knight@example.com',   '(555) 301-0107'),
      (8, 6,  'Cut',         'afternoon', 'Jonah Stone',   'jonah.stone@example.com',   '(555) 301-0108'),
      (9, 8,  'Cut',         'anytime',   'Max Porter',    'max.porter@example.com',    '(555) 301-0109'),
      (10, 8, 'Cut & Shave', 'morning',   'Shawn Brooks',  'shawn.brooks@example.com',  '(555) 301-0110'),
      (11, 11,'Cut',         'afternoon', 'Chris Vaughn',  'chris.vaughn@example.com',  '(555) 301-0111'),
      (12, 11,'Cut & Shave', 'anytime',   'Alex Ramsey',   'alex.ramsey@example.com',   '(555) 301-0112')
  ) as seed(waitlist_no, day_offset, service_name, time_preference, client_name, client_email, client_phone)
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
  (
    substr(md5('seed-waitlist-' || waitlist_seed.waitlist_no), 1, 8) || '-' ||
    substr(md5('seed-waitlist-' || waitlist_seed.waitlist_no), 9, 4) || '-' ||
    substr(md5('seed-waitlist-' || waitlist_seed.waitlist_no), 13, 4) || '-' ||
    substr(md5('seed-waitlist-' || waitlist_seed.waitlist_no), 17, 4) || '-' ||
    substr(md5('seed-waitlist-' || waitlist_seed.waitlist_no), 21, 12)
  )::uuid,
  'd87fb2aa-e129-450c-ad09-a7853a891590',
  null,
  case
    when waitlist_seed.service_name = 'Cut & Shave' then '191de43d-d3ea-42a5-8ff8-5d46d9fa3c95'::uuid
    else 'ff5d3c54-3d6d-4e3e-8fcb-f30ddb723cbb'::uuid
  end,
  (date_trunc('day', now()) + (waitlist_seed.day_offset || ' days')::interval)::date,
  waitlist_seed.time_preference,
  waitlist_seed.client_name,
  waitlist_seed.client_email,
  waitlist_seed.client_phone,
  'Seeded waitlist request on a busy upcoming day.',
  'active',
  'public_booking'
from waitlist_seed;

with latest_future as (
  select id, client_id, service_name, appointment_date, status
  from public.appointments
  where user_id = 'd87fb2aa-e129-450c-ad09-a7853a891590'
    and appointment_date >= now()
  order by appointment_date
  limit 12
),
event_rows as (
  select
    row_number() over (order by appointment_date) as event_no,
    latest_future.*
  from latest_future
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
  (
    substr(md5('seed-activity-booking-' || event_no), 1, 8) || '-' ||
    substr(md5('seed-activity-booking-' || event_no), 9, 4) || '-' ||
    substr(md5('seed-activity-booking-' || event_no), 13, 4) || '-' ||
    substr(md5('seed-activity-booking-' || event_no), 17, 4) || '-' ||
    substr(md5('seed-activity-booking-' || event_no), 21, 12)
  )::uuid,
  'd87fb2aa-e129-450c-ad09-a7853a891590',
  client_id,
  id,
  'booking_created',
  'New booking for ' || service_name,
  'Seeded public booking event.',
  now() - (event_no || ' hours')::interval,
  jsonb_build_object(
    'service_name', service_name,
    'appointment_start_time', appointment_date,
    'current_appointment_status', status
  ),
  'seed-booking-created-' || event_no
from event_rows;

with waitlist_events as (
  select
    row_number() over (order by created_at, id) as event_no,
    id,
    client_id,
    service_id,
    client_name,
    requested_date,
    requested_time_preference
  from public.waitlist_entries
  where user_id = 'd87fb2aa-e129-450c-ad09-a7853a891590'
    and client_id is not null
  limit 8
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
  (
    substr(md5('seed-activity-waitlist-' || event_no), 1, 8) || '-' ||
    substr(md5('seed-activity-waitlist-' || event_no), 9, 4) || '-' ||
    substr(md5('seed-activity-waitlist-' || event_no), 13, 4) || '-' ||
    substr(md5('seed-activity-waitlist-' || event_no), 17, 4) || '-' ||
    substr(md5('seed-activity-waitlist-' || event_no), 21, 12)
  )::uuid,
  'd87fb2aa-e129-450c-ad09-a7853a891590',
  client_id,
  null,
  'waitlist_joined',
  client_name || ' joined the waitlist',
  'Seeded waitlist activity for a busy day.',
  now() - ((event_no + 12) || ' hours')::interval,
  jsonb_build_object(
    'client_name', client_name,
    'requested_date', requested_date,
    'requested_time_preference', requested_time_preference,
    'source', 'public_booking'
  ),
  'seed-waitlist-joined-' || event_no
from waitlist_events;
