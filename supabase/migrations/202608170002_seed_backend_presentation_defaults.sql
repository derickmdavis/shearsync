-- Catalog static, user-facing copy emitted by backend presentation contracts.
-- Dynamic values (client names, service names, amounts, dates, and counts) are
-- intentionally not seeded as content rows.
with defaults(key, namespace, category, value) as (values
  ('campaigns.metric.emails_sent.label', 'campaigns', 'section', 'Emails sent'),
  ('campaigns.metric.appointments_booked.label', 'campaigns', 'section', 'Appointments booked'),
  ('campaigns.metric.attributed_revenue.label', 'campaigns', 'section', 'Attributed revenue'),
  ('campaigns.top_campaign.eyebrow', 'campaigns', 'section', 'Top campaign'),
  ('campaigns.empty_state.title', 'campaigns', 'empty_state', 'Send your first campaign'),
  ('campaigns.empty_state.body', 'campaigns', 'empty_state', 'Reach more clients with a targeted email campaign.'),
  ('campaigns.empty_state.cta', 'campaigns', 'cta', 'Create campaign'),
  ('referrals.metric.new_clients.label', 'referrals', 'section', 'New clients'),
  ('referrals.metric.appointments_booked.label', 'referrals', 'section', 'Appointments'),
  ('referrals.metric.conversion_rate.label', 'referrals', 'section', 'Conversion'),
  ('referrals.top_referrer.eyebrow', 'referrals', 'section', 'Top referrer'),
  ('referrals.setup.title', 'referrals', 'empty_state', 'Turn happy clients into new bookings'),
  ('referrals.setup.body', 'referrals', 'empty_state', 'Create a referral offer and share your personal links to start earning more clients.'),
  ('referrals.setup.cta', 'referrals', 'cta', 'Start referral program'),
  ('referrals.setup.accessibility', 'referrals', 'empty_state', 'Set up your referral program'),
  ('automation.rebook_nudges.label', 'automation', 'section', 'Rebook Nudges'),
  ('automation.appointment_reminders.label', 'automation', 'section', 'Appointment Reminders'),
  ('automation.email_confirmations.label', 'automation', 'section', 'Email Confirmations'),
  ('automation.no_show_follow_up.label', 'automation', 'section', 'No Show Follow-up'),
  ('automation.waitlist_match.label', 'automation', 'section', 'Waitlist Match'),
  ('automation.birthday_reminders.label', 'automation', 'section', 'Birthday Reminders'),
  ('automation.thank_you_emails.label', 'automation', 'section', 'Thank You Emails'),
  ('profile.services.detail.configured', 'profile', 'section', 'Manage your services, pricing, and durations'),
  ('profile.services.detail.empty', 'profile', 'empty_state', 'Add services with pricing and durations'),
  ('profile.messaging.badge.unconfigured', 'profile', 'section', 'Not configured'),
  ('profile.messaging.detail.unconfigured', 'profile', 'empty_state', 'Messaging settings are not configured yet'),
  ('profile.settings.business.detail', 'profile', 'section', 'Location, contact info, and business details'),
  ('profile.settings.account.detail', 'profile', 'section', 'Billing, subscription, and logout'),
  ('booking.intake.status.more_information', 'booking', 'callout', 'We need a little more information before confirming returning-client status.'),
  ('booking.intake.status.welcome_back', 'booking', 'callout', 'Welcome back — you can book directly.'),
  ('account.deletion.request.received', 'account', 'callout', 'Your account deletion request has been received.'),
  ('account.deletion.request.already_received', 'account', 'callout', 'Your account deletion request has already been received.'),
  ('early.access.confirmation', 'early_access', 'callout', 'You''re on the list.'),
  ('outreach.scheduled_send.fallback_campaign_title', 'outreach', 'section', 'Campaign'),
  ('outreach.scheduled_send.appointment_reminder_title', 'outreach', 'section', 'Appointment reminder')
)
insert into public.app_content_definitions (
  key, namespace, category, description, allowed_placeholders, max_length,
  multiline_allowed, fallback_required, created_by_admin_email, updated_by_admin_email
)
select key, namespace, category, 'Editable backend presentation copy: ' || key,
  '{}'::text[], 280, false, true, 'system', 'system'
from defaults
on conflict (key) do nothing;

with defaults(key, value) as (values
  ('campaigns.metric.emails_sent.label', 'Emails sent'), ('campaigns.metric.appointments_booked.label', 'Appointments booked'), ('campaigns.metric.attributed_revenue.label', 'Attributed revenue'),
  ('campaigns.top_campaign.eyebrow', 'Top campaign'), ('campaigns.empty_state.title', 'Send your first campaign'), ('campaigns.empty_state.body', 'Reach more clients with a targeted email campaign.'), ('campaigns.empty_state.cta', 'Create campaign'),
  ('referrals.metric.new_clients.label', 'New clients'), ('referrals.metric.appointments_booked.label', 'Appointments'), ('referrals.metric.conversion_rate.label', 'Conversion'), ('referrals.top_referrer.eyebrow', 'Top referrer'),
  ('referrals.setup.title', 'Turn happy clients into new bookings'), ('referrals.setup.body', 'Create a referral offer and share your personal links to start earning more clients.'), ('referrals.setup.cta', 'Start referral program'), ('referrals.setup.accessibility', 'Set up your referral program'),
  ('automation.rebook_nudges.label', 'Rebook Nudges'), ('automation.appointment_reminders.label', 'Appointment Reminders'), ('automation.email_confirmations.label', 'Email Confirmations'), ('automation.no_show_follow_up.label', 'No Show Follow-up'), ('automation.waitlist_match.label', 'Waitlist Match'), ('automation.birthday_reminders.label', 'Birthday Reminders'), ('automation.thank_you_emails.label', 'Thank You Emails'),
  ('profile.services.detail.configured', 'Manage your services, pricing, and durations'), ('profile.services.detail.empty', 'Add services with pricing and durations'), ('profile.messaging.badge.unconfigured', 'Not configured'), ('profile.messaging.detail.unconfigured', 'Messaging settings are not configured yet'), ('profile.settings.business.detail', 'Location, contact info, and business details'), ('profile.settings.account.detail', 'Billing, subscription, and logout'),
  ('booking.intake.status.more_information', 'We need a little more information before confirming returning-client status.'), ('booking.intake.status.welcome_back', 'Welcome back — you can book directly.'),
  ('account.deletion.request.received', 'Your account deletion request has been received.'), ('account.deletion.request.already_received', 'Your account deletion request has already been received.'), ('early.access.confirmation', 'You''re on the list.'),
  ('outreach.scheduled_send.fallback_campaign_title', 'Campaign'), ('outreach.scheduled_send.appointment_reminder_title', 'Appointment reminder')
)
insert into public.app_content_drafts (
  definition_key, locale, value, draft_version, validation_status,
  validation_errors, updated_by_admin_email, updated_by_user_id
)
select key, 'en-US', value, 1, 'valid', null, 'system', null from defaults
on conflict (definition_key, locale) do nothing;
