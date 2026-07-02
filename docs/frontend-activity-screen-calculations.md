# Frontend Activity Screen Calculations

This handoff explains how each Activity screen value is calculated from `GET /api/activity/dashboard`.

The dashboard response is wrapped as:

```ts
type ActivityDashboardResponse = {
  data: ActivityDashboard;
};
```

Unless noted otherwise, all paths below are relative to `response.data`.

## Needs Attention

Source:

```ts
dashboard.needs_attention
```

The screen should render only rows whose final count is greater than `0`.

### Cancellations need review

Value:

```ts
dashboard.needs_attention.cancellations_need_review_count
```

Backend calculation:

- Loads recent `activity_events` where `activity_type = "appointment_cancelled"`.
- Keeps only events with an appointment id.
- Excludes events where the linked appointment is no longer cancelled.
- Excludes cancellations where the same client has a future non-cancelled appointment on or after the cancelled appointment time.
- Count is the number of remaining cancellation review items.

Equivalent top-level field:

```ts
dashboard.cancellation_review_count
```

### Pending approvals

Value:

```ts
dashboard.needs_attention.pending_approval_count
```

Backend calculation:

- Uses `activityEventsService.getCategoryCounts(...)`.
- Count is `feedCounts.approvals`.
- This is the total Activity feed count for the `approvals` category.

Equivalent top-level field:

```ts
dashboard.pending_approval_count
```

### Thank-you emails need approval

Value:

```ts
dashboard.needs_attention.pending_thank_you_email_count
```

Fallback:

```ts
dashboard.pending_thank_you_email_count
```

Backend calculation:

- If the stylist is not entitled to `thankYouEmails`, the count is `0`.
- Otherwise counts rows in `thank_you_emails` where:
  - `user_id = current user`
  - `status = "pending_approval"`

### New waitlist matches

Value:

```ts
dashboard.needs_attention.waitlist_match_count
```

Backend calculation:

- If the `waitlist_match` automation is unavailable for the stylist's plan, the count is `0`.
- Otherwise loads active waitlist entries with `requested_date >= today` in the business timezone.
- Loads cancelled future appointments as openings.
- A match exists when a waitlist entry and cancelled opening share the requested local date and service.
- Count is the number of matched waitlist entries returned in `dashboard.waitlist_matches`.

Equivalent top-level field:

```ts
dashboard.waitlist_match_count
```

### Reminders pending / appointment reminders off

Value:

```ts
dashboard.needs_attention.pending_reminder_count
```

Backend calculation:

- Count is the length of the combined eligible automation queue, not only appointment reminders.
- The queue can include:
  - appointment reminders
  - queued rebook nudges
  - queued birthday reminders
  - queued thank-you emails
- Each candidate is included only when its automation is effectively enabled, feature access is available, the channel can be sent, and communication preferences allow the send.

Equivalent top-level fields:

```ts
dashboard.pending_reminder_count
dashboard.scheduled_reminder_count
dashboard.reminder_queue.length
```

### Birthday reminders queued

Value fallback chain:

```ts
dashboard.needs_attention.birthday_reminder_count
dashboard.birthday_reminder_count
dashboard.queued_birthday_reminder_count
dashboard.birthdayReminderMode
dashboard.birthday_reminder_queue.length
```

Backend calculation for `birthday_reminder_count` and `queued_birthday_reminder_count`:

- If birthday reminders are not effectively enabled, the count is `0`.
- Otherwise loads `birthday_reminders` where:
  - `user_id = current user`
  - `status = "queued"`
  - `scheduled_send_at >= now`
- Converts rows into eligible email queue candidates.
- Removes rows that cannot be sent because of missing email/entitlement/channel/preference checks.
- Count is the eligible queued birthday reminder count.

Backend calculation for `birthday_reminder_queue.length`:

- If the stylist is not entitled to `birthdayReminders`, the queue is empty.
- Otherwise loads up to 50 upcoming queued birthday reminders from `birthday_reminders`, ordered by `scheduled_send_at`.
- Dashboard birthday reminder queue rows use `status = "queued"` only. The dedicated birthday reminder endpoint may expose broader cancelable active statuses.

`dashboard.birthdayReminderMode` is currently `"automatic"`. Use this field, not count placement heuristics, when deciding whether birthday reminders belong in Reminder Queue or Needs Attention.

### Review requests queued

Value:

```ts
dashboard.needs_attention.queued_review_request_count
```

Backend calculation:

- Loads `reminders` where:
  - `user_id = current user`
  - `status = "open"`
  - `reminder_type = "follow_up"`
- Count is the number of loaded review request queue items.

Equivalent top-level fields:

```ts
dashboard.queued_review_request_count
dashboard.review_request_queue.length
```

Important: review requests are not in `dashboard.reminder_queue`; they live in `dashboard.review_request_queue`.

### Rebook nudges need approval

Value:

```ts
dashboard.needs_attention.pending_rebook_nudge_count
```

Fallback:

```ts
dashboard.pending_rebook_nudge_count
```

Backend calculation:

- If the stylist is not entitled to `rebookNudges`, the count is `0`.
- Otherwise counts rows in `rebook_nudges` where:
  - `user_id = current user`
  - `status = "pending_approval"`

## Automations On

Source:

```ts
dashboard.automation_controls
```

Frontend calculation:

- Build the list of controls the Activity screen supports.
- Exclude unsupported/no-show variants such as `no_show_follow_up` or `no_show` if the screen does not render them.
- `active_count` is the number of supported controls where `control.enabled === true`.
- `total_count` is the number of supported controls after exclusions.

Important: `control.enabled` is already the backend's effective enabled value. It is `true` only when the stored automation setting is on and the feature is available to the stylist.

## Customers Reached

Preferred source:

```ts
dashboard.customers_reached_last_30_days
```

Backend calculation:

- Uses a rolling 30-day window from the current instant.
- Collects unique non-null `client_id` values from sent or delivered communication records:
  - `communication_events` with `status in ("sent", "delivered")`
  - `appointment_email_events` with `status = "sent"`
  - `reminders` with `status = "sent"`
  - `activity_events` where `activity_type = "reminder_sent"`
  - `rebook_nudges` with `status = "sent"`
  - `birthday_reminders` with `status = "sent"`
  - `thank_you_emails` with `status = "sent"`
- Excludes booking/appointment confirmation automation such as `appointment_confirmation`,
  `appointment_scheduled`, `appointment_pending`, and `appointment_confirmed`.
- Value is the size of the unique client id set.

Legacy frontend fallback:

```ts
dashboard.automation_impact_this_week.reminders_sent_count
dashboard.queued_review_request_count
dashboard.pending_rebook_nudge_count
dashboard.queued_rebook_nudge_count
dashboard.pending_thank_you_email_count
dashboard.queued_thank_you_email_count
birthday reminder count from the Needs Attention fallback chain
```

Fallback calculation:

- Add the available queue/activity counts above.
- This is not a true unique-customer metric and can double-count the same client.
- If this fallback is used, the label `in the last 30 days` is aspirational; the backend field above is the accurate last-30-days unique customer metric.

## Automation Controls

Source:

```ts
dashboard.automation_controls
```

Each row uses one object from the controls array.

### Icon

Frontend calculation:

```ts
control.key
```

Map the automation key to the screen icon. Current backend keys are:

```ts
"rebook_nudges"
"appointment_reminders"
"email_confirmations"
"no_show_follow_up"
"waitlist_match"
"birthday_reminders"
"thank_you_emails"
```

### Label

Frontend fallback chain:

```ts
control.label
control.title
control.name
formatAutomationKey(control.key)
```

Backend currently sends `control.label` for every control.

### Detail/status text

Frontend calculation:

- If `control.feature_available !== true`, show `Upgrade required`.
- Else if the control is disabled, show blank detail text.
- Else if `control.key === "thank_you_emails"`:
  - Prefer `control.pending_approval_count` when greater than `0`, for example `3 need approval`.
  - Otherwise use `control.queued_count`, for example `2 queued`.
- Else use `control.status_label` when present.
- Else use `control.detail` when present.

Backend `status_label` calculations:

- `rebook_nudges`: `Upgrade required`, `{pending_approval_count} need approval`, or `{queued_count} queued`.
- `appointment_reminders`: `{scheduled_count} scheduled`.
- `email_confirmations`: `On for bookings` when enabled, otherwise `Paused`.
- `no_show_follow_up`: `Upgrade required` or `{due_count} needed today`.
- `waitlist_match`: `Upgrade required` or `{match_count} match/matches found`.
- `birthday_reminders`: `Upgrade required` or `{queued_count} queued`.
- `thank_you_emails`: `Upgrade required`, `{pending_approval_count} need approval`, or `{queued_count} queued`.

### Status badge

Frontend calculation:

- `Locked` when `control.feature_available !== true`.
- `On` when `control.enabled === true`.
- `Off` otherwise.

## Reminder Queue

Source:

```ts
dashboard.reminder_queue
```

Screen behavior:

- Show appointment reminder items only.
- Show the first 5 matching items.
- If more than 5 matching items exist, show overflow text: `{N} more scheduled`.

Important: `dashboard.reminder_queue` can include multiple automation types. Appointment reminder rows are the ones where:

```ts
item.automation_key === "appointment_reminders"
```

### Client name

Value:

```ts
item.client_name
```

Backend calculation:

- Loads the linked client.
- Formats `first_name` and `last_name`.
- Falls back to `"Client"` when no name is available.

### Time label

Frontend calculation:

- If `item.appointment_start_time` is present, format it as the appointment time.
- Otherwise format `item.send_at` as the scheduled send time.

Backend sources:

- Legacy reminder rows use `reminders.due_date` as `send_at`.
- Appointment email reminder rows use `appointment_email_events.created_at` as `send_at`.
- Appointment email reminder rows use the linked appointment's `appointment_date` as `appointment_start_time`, falling back to `template_data.appointment_start_time`.

### Channel badge

Value:

```ts
item.channel
```

Possible values are usually:

```ts
"email"
"sms"
```

### Status

Value:

```ts
item.status
```

Backend values:

- Legacy appointment reminders use `scheduled`.
- Appointment email reminders use `queued` or `sending`.

### Review request boundary

This section does not show review requests. Review requests come from:

```ts
dashboard.review_request_queue
```

Review request count comes from:

```ts
dashboard.queued_review_request_count
```
