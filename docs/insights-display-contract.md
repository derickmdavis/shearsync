# Insights display contract

`GET /api/insights` contract version `2026-08-17` adds the canonical
`performance_snapshot` and `today_activity` display models. They are complete
rendering contracts: clients render supplied page and metric order, labels,
display values, supporting text, comparisons, tones, icon keys, and
accessibility labels. The legacy `business_snapshot`, `campaigns`,
`referrals`, and `appointment_changes` fields remain available during mobile
migration.

Both new sections use the standard unavailable shape when their underlying
data cannot be read. A calculated zero remains available and is rendered as
`0` or `$0.00`; metrics are never omitted because their value is zero.

## Windows and metric definitions

Business metrics use the selected `business_snapshot_period` (`week` means
Monday through the next Monday; `month` means the calendar month) in the
account's `account_timezone`. Their comparison window is the immediately
preceding, equal-length local calendar period. `Booked Revenue` is the sum of
`price` for non-cancelled appointments in the window; `Appointments Booked`
is the count of those appointments; `Average Ticket` is that sum divided by
that count; and `Rebooking Rate` is the existing appointment-metric helper's
unique returning-client calculation. These are appointment-based metrics.
Cancelled appointments are excluded. Refunds, deleted clients, test-data
flags, and duplicate appointment rows have no separate handling in the
current appointments schema; appointments are scoped by `user_id` and each
stored appointment row is counted once.

`Emails Sent` is campaign-recipient delivery aggregate data for the
account-local calendar month to the calculation instant. `Customers Reached`
is a distinct-client count across successfully sent supported communication,
appointment-email, reminder, rebooking-nudge, birthday-reminder, and
thank-you-email events in the rolling 30 days ending at calculation time.
These are email/communication-event based metrics; duplicate events for one
client are de-duplicated by client ID. `Referral Conversions` is the count of
non-cancelled appointments with referral attribution during the selected
`referral_period` (`this_month` in the account timezone or `all_time`);
`Referrals` is the count of referral links created in that same referral
window. They are referral/appointment based. No previous-window referral
comparison is currently supplied, so `comparison` is `null`.

`today_activity` is an event-based rolling UTC 24-hour window ending at
`calculated_at`. `New Appointments` counts canonical `booking_created`
activity events and `Cancellations` counts canonical `appointment_cancelled`
events. The event table's `(user_id, dedupe_key)` uniqueness prevents repeated
mutations from being double-counted. This rolling event window intentionally
does not use the account timezone. Deleted-client, refund, and test-data
filtering are not applicable to these canonical activity event counts.
