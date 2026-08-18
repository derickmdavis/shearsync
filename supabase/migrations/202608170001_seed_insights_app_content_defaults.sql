-- Seed the editable, backend-owned copy used by the canonical Insights API.
-- Existing administrator edits are preserved on re-application.
insert into public.app_content_definitions (
  key, namespace, category, description, allowed_placeholders, max_length,
  multiline_allowed, fallback_required, created_by_admin_email, updated_by_admin_email
)
select key, 'insights', category, description, placeholders, max_length, false, true, 'system', 'system'
from (values
  ('insights.period.week', 'section', 'Period selector label for the current week.', '{}'::text[], 80),
  ('insights.period.month', 'section', 'Period selector label for the current month.', '{}'::text[], 80),
  ('insights.page.business_metrics.title', 'section', 'Title of the business metric page.', '{}'::text[], 80),
  ('insights.page.outreach_metrics.title', 'section', 'Title of the outreach metric page.', '{}'::text[], 80),
  ('insights.swipe.forward', 'callout', 'Forward swipe accessibility hint.', '{}'::text[], 160),
  ('insights.swipe.backward', 'callout', 'Backward swipe accessibility hint.', '{}'::text[], 160),
  ('insights.metric.booked_revenue.label', 'section', 'Label for booked revenue.', '{}'::text[], 80),
  ('insights.metric.booked_revenue.supporting', 'section', 'Supporting text for booked revenue.', array['count']::text[], 160),
  ('insights.metric.appointments_booked.label', 'section', 'Label for booked appointments.', '{}'::text[], 80),
  ('insights.metric.appointments_booked.supporting', 'section', 'Supporting text for booked appointments.', '{}'::text[], 160),
  ('insights.metric.rebooking_rate.label', 'section', 'Label for rebooking rate.', '{}'::text[], 80),
  ('insights.metric.rebooking_rate.supporting', 'section', 'Supporting text for rebooking rate.', '{}'::text[], 160),
  ('insights.metric.average_ticket.label', 'section', 'Label for average ticket.', '{}'::text[], 80),
  ('insights.metric.average_ticket.supporting', 'section', 'Supporting text for average ticket.', '{}'::text[], 160),
  ('insights.metric.emails_sent.label', 'section', 'Label for emails sent.', '{}'::text[], 80),
  ('insights.metric.emails_sent.supporting', 'section', 'Supporting text for emails sent.', array['periodLabel']::text[], 160),
  ('insights.metric.emails_sent.accessibility', 'section', 'Accessibility label for emails sent.', array['count', 'periodLabel']::text[], 280),
  ('insights.metric.customers_reached.label', 'section', 'Label for customers reached.', '{}'::text[], 80),
  ('insights.metric.customers_reached.supporting', 'section', 'Supporting text for customers reached.', array['days']::text[], 160),
  ('insights.metric.customers_reached.accessibility', 'section', 'Accessibility label for customers reached.', array['count', 'days']::text[], 280),
  ('insights.metric.referral_conversions.label', 'section', 'Label for referral conversions.', '{}'::text[], 80),
  ('insights.metric.referral_conversions.supporting', 'section', 'Supporting text for referral conversions.', array['periodLabel']::text[], 160),
  ('insights.metric.referral_conversions.accessibility', 'section', 'Accessibility label for referral conversions.', array['count', 'periodLabel']::text[], 280),
  ('insights.metric.referrals.label', 'section', 'Label for referrals.', '{}'::text[], 80),
  ('insights.metric.referrals.supporting', 'section', 'Supporting text for referrals.', array['periodLabel']::text[], 160),
  ('insights.metric.referrals.accessibility', 'section', 'Accessibility label for referrals.', array['count', 'periodLabel']::text[], 280),
  ('insights.metric.accessibility.with_comparison', 'section', 'Accessibility template for a metric with a comparison.', array['displayValue', 'label', 'direction', 'comparison']::text[], 280),
  ('insights.metric.accessibility.without_comparison', 'section', 'Accessibility template for a metric without a comparison.', array['displayValue', 'label']::text[], 280),
  ('insights.today_activity.heading', 'section', 'Heading for today activity.', '{}'::text[], 80),
  ('insights.today_activity.accessibility', 'section', 'Accessibility label for today activity.', '{}'::text[], 280),
  ('insights.today_activity.new_appointments.label', 'section', 'Label for new appointments today.', '{}'::text[], 80),
  ('insights.today_activity.new_appointments.accessibility', 'section', 'Accessibility label for new appointments today.', array['count']::text[], 280),
  ('insights.today_activity.cancellations.label', 'section', 'Label for cancellations today.', '{}'::text[], 80),
  ('insights.today_activity.cancellations.accessibility', 'section', 'Accessibility label for cancellations today.', array['count']::text[], 280)
) as defaults(key, category, description, placeholders, max_length)
on conflict (key) do nothing;

insert into public.app_content_drafts (
  definition_key, locale, value, draft_version, validation_status,
  validation_errors, updated_by_admin_email, updated_by_user_id
)
select key, 'en-US', value, 1, 'valid', null, 'system', null
from (values
  ('insights.period.week', 'This Week'), ('insights.period.month', 'This Month'),
  ('insights.page.business_metrics.title', 'Business Metrics'), ('insights.page.outreach_metrics.title', 'Outreach Metrics'),
  ('insights.swipe.forward', 'Swipe to view Outreach metrics'), ('insights.swipe.backward', 'Swipe to view Business metrics'),
  ('insights.metric.booked_revenue.label', 'Booked Revenue'), ('insights.metric.booked_revenue.supporting', '{{count}} booked appts'),
  ('insights.metric.appointments_booked.label', 'Appts Booked'), ('insights.metric.appointments_booked.supporting', 'All appointments'),
  ('insights.metric.rebooking_rate.label', 'Rebooking Rate'), ('insights.metric.rebooking_rate.supporting', 'Returned clients'),
  ('insights.metric.average_ticket.label', 'Average Ticket'), ('insights.metric.average_ticket.supporting', 'Booked appointments'),
  ('insights.metric.emails_sent.label', 'Emails Sent'), ('insights.metric.emails_sent.supporting', '{{periodLabel}}'), ('insights.metric.emails_sent.accessibility', '{{count}} emails sent {{periodLabel}}'),
  ('insights.metric.customers_reached.label', 'Customers Reached'), ('insights.metric.customers_reached.supporting', 'Unique clients • Last {{days}} days'), ('insights.metric.customers_reached.accessibility', '{{count}} customers reached in the last {{days}} days'),
  ('insights.metric.referral_conversions.label', 'Referral Conversions'), ('insights.metric.referral_conversions.supporting', 'Booked from referrals • {{periodLabel}}'), ('insights.metric.referral_conversions.accessibility', '{{count}} referral conversions for {{periodLabel}}'),
  ('insights.metric.referrals.label', 'Referrals'), ('insights.metric.referrals.supporting', 'Referral links created • {{periodLabel}}'), ('insights.metric.referrals.accessibility', '{{count}} referrals for {{periodLabel}}'),
  ('insights.metric.accessibility.with_comparison', '{{displayValue}} {{label}}, {{direction}} {{comparison}}'), ('insights.metric.accessibility.without_comparison', '{{displayValue}} {{label}}'),
  ('insights.today_activity.heading', 'Today • Last 24 Hours'), ('insights.today_activity.accessibility', 'Today’s activity over the last 24 hours'),
  ('insights.today_activity.new_appointments.label', 'New Appointments'), ('insights.today_activity.new_appointments.accessibility', '{{count}} new appointments in the last 24 hours'),
  ('insights.today_activity.cancellations.label', 'Cancellations'), ('insights.today_activity.cancellations.accessibility', '{{count}} cancellations in the last 24 hours')
) as defaults(key, value)
on conflict (definition_key, locale) do nothing;
