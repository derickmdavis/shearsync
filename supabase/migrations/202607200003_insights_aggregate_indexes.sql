-- Insights sections use account-scoped, time-windowed aggregate queries. These
-- indexes keep those queries bounded to the selected account and period.
create index if not exists insights_appointments_user_date_idx
  on public.appointments(user_id, appointment_date)
  where status <> 'cancelled';

create index if not exists insights_activity_events_user_type_occurred_idx
  on public.activity_events(user_id, activity_type, occurred_at desc);

create index if not exists insights_referral_links_user_created_idx
  on public.client_referral_links(user_id, created_at desc);

create index if not exists insights_referral_events_user_type_created_idx
  on public.referral_events(user_id, event_type, created_at desc);

create index if not exists insights_clients_user_referral_attributed_idx
  on public.clients(user_id, original_referral_attributed_at desc)
  where original_referral_attributed_at is not null;

create index if not exists insights_appointments_user_referral_attributed_idx
  on public.appointments(user_id, referral_attributed_at desc)
  where referral_attributed_at is not null and status <> 'cancelled';

create index if not exists insights_campaign_recipients_user_sent_idx
  on public.campaign_recipients(user_id, sent_at desc, campaign_id)
  where sent_at is not null;

create index if not exists insights_appointments_user_campaign_attributed_idx
  on public.appointments(user_id, campaign_attributed_at desc, campaign_id)
  where campaign_id is not null and status <> 'cancelled';
