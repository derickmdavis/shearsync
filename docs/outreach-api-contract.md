# Outreach API Contract Foundation

## Status

This document defines the canonical types introduced by Outreach implementation Chunk 1. The scheduled-send read and cancellation routes described below were implemented in Chunks 2 and 3. Campaign routes remain forward contracts and are not implemented yet.

Runtime constants and TypeScript types live in `src/lib/outreachContracts.ts`. Zod validators live in `src/validators/outreachValidators.ts`. Representative typed fixtures live in `src/__tests__/fixtures/outreachContractFixtures.ts`.

## Campaign contract

### Status

Normal one-time lifecycle:

```text
draft -> scheduled -> sending -> completed
```

Exception and terminal statuses:

```text
partially_failed
failed
cancelled
```

`active` and `paused` are deliberately unsupported. `drafted` is not an alias for `draft`.

### Campaign shape decisions

| Field | Canonical values/rule |
|---|---|
| Campaign kind | `one_time` |
| Send mode | `now`, `scheduled` |
| Link type | `booking_link`, `referral_link` |
| Audience mode | `everyone`, `specific` |
| Personalization | `{{first_name}}` only |
| Missing first name | `there` |
| Name | Required after setup; maximum 60 characters |
| Subject | Required; maximum 100 characters |
| Message | Required; maximum 2,000 characters |
| Minimum scheduled lead | 5 minutes |
| Maximum scheduled horizon | 12 calendar months |
| Attribution window | 30 days |

`{{first_name}}` is the only token exposed for campaign content. Existing automation token support is unchanged.

### Audience exclusion reasons

```text
missing_email
invalid_email
email_marketing_disabled
globally_unsubscribed
client_deleted
duplicate_recipient
not_owned_or_not_found
```

The last value intentionally combines unauthorized and unknown IDs so API responses do not disclose cross-account records.

### Representative draft

```json
{
  "id": "11111111-1111-4111-8111-111111111111",
  "status": "draft",
  "campaign_kind": "one_time",
  "revision": 1,
  "name": "Summer Booking Boost",
  "send_mode": "scheduled",
  "send_at": "2026-07-20T15:00:00.000Z",
  "link_type": "booking_link",
  "template_id": "22222222-2222-4222-8222-222222222222",
  "template_version": 3,
  "audience": {
    "mode": "specific",
    "client_ids": ["33333333-3333-4333-8333-333333333333"]
  },
  "content": {
    "subject": "A summer appointment for you",
    "message": "Hi {{first_name}}, I would love to see you again this summer."
  },
  "created_at": "2026-07-18T15:00:00.000Z",
  "updated_at": "2026-07-18T15:05:00.000Z"
}
```

## Scheduled Outreach contract

### Implemented routes

```http
GET  /api/outreach/scheduled-sends?status=queued&kind=appointment_reminder,rebook_nudge&limit=20&cursor=...
POST /api/outreach/scheduled-sends/:id/cancel
```

The list route defaults to `status=queued`, accepts `queued` or `sending`, supports a comma-separated canonical kind filter, and returns `{ data, next_cursor, total_count }`. `total_count` covers the full eligible filtered list before cursor pagination.

The cancellation body is optional:

```json
{ "reason": "Skipped by stylist" }
```

Cancellation is ownership-scoped. Appointment-reminder cancellation is tied to the appointment ID and appointment-start snapshot. It returns `409` once sending has started and remains idempotent when repeated before sending.

### Kinds

```text
appointment_reminder
rebook_nudge
thank_you_email
birthday_reminder
campaign
```

`review_request` is not supported. The current product has no defined review destination, trigger, content, approval behavior, or delivery lifecycle. It is unrelated to campaign status.

The Outreach automations bootstrap is `GET /api/outreach/automations`. It returns six supported controls and intentionally omits the legacy `no_show_follow_up`/generic follow-up presentation. Every control includes explicit email and SMS capabilities, timing, mode, counts, content limits, token rules, current settings, and its canonical mutation path. SMS is currently always returned as unavailable and disabled.

The `customers_reached` metric includes `window_kind: "rolling"`, `window_days: 30`, exact UTC window boundaries, the business timezone, and the included message types. This prevents the frontend from inventing a calendar window or attribution definition.

Campaign authoring begins with `POST /api/campaign-drafts`, which creates a durable revision-1 draft immediately. `GET`, revision-checked `PATCH`, and `DELETE` use `/api/campaign-drafts/:id`. A PATCH replaces specific-audience selections in the same transaction as content/setup changes and returns `409` with `current_revision` when its revision is stale.

Campaign configuration is available from `GET /api/outreach/config`. Versioned product templates are listed through `GET /api/campaign-templates?status=active&limit=20&cursor=...`. Applying a template snapshots its ID, version, link type, subject, and message onto the draft; later template changes do not alter that snapshot.

Campaign audience estimates use `POST /api/campaigns/audience/estimate`. Both `everyone` and `specific` audiences use the same email-marketing eligibility service and canonical exclusions. Duplicate normalized emails are resolved after consent checks; the lexicographically smallest otherwise-eligible client ID wins and remaining matches use `duplicate_recipient`. Foreign and missing selected IDs both return `not_owned_or_not_found` without disclosing ownership.

Client search accepts `campaign_eligibility=email_marketing` and adds an individual `{ eligible, reason }` annotation. Duplicate handling is deferred until an actual audience is estimated, because two independently searchable client records are not duplicates unless both are selected for the same send. Broad estimates load every client in batches and have no plan recipient cap.

### Statuses

```text
queued
sending
sent
cancelled
skipped
failed
```

### Actions

```text
view_appointment
view_client
view_campaign
cancel
```

The backend will return actions; clients must not derive them from kind or status.

### Representative list

```json
{
  "data": [
    {
      "id": "appointment_reminder:44444444-4444-4444-8444-444444444444:2026-07-19T16:00:00.000Z",
      "kind": "appointment_reminder",
      "status": "queued",
      "channel": "email",
      "send_at": "2026-07-18T16:00:00.000Z",
      "recipient": {
        "client_id": "33333333-3333-4333-8333-333333333333",
        "display_name": "Sarah J."
      },
      "appointment_id": "44444444-4444-4444-8444-444444444444",
      "campaign_id": null,
      "title": "Appointment reminder",
      "context_label": "For appointment at 10:00 AM",
      "can_cancel": true,
      "cancel_scope": "single_send",
      "allowed_actions": ["view_appointment", "view_client", "cancel"]
    }
  ],
  "next_cursor": null,
  "total_count": 1
}
```

The `id` is opaque to API consumers. Its example representation is not permission to parse or construct it on the client.

## Automation contract

Canonical keys remain:

```text
rebook_nudges
appointment_reminders
email_confirmations
no_show_follow_up
waitlist_match
birthday_reminders
thank_you_emails
```

Automation modes, where applicable, are:

```text
automatic
approval_required
```

Controls that do not have an approval mode return `mode: null`. New automation responses use snake_case. Legacy settings endpoints may retain existing casing until their consumers migrate.

Outbound SMS remains unavailable until a provider and outbound delivery system are implemented. The future automation response must express availability explicitly rather than returning a working-looking local toggle.

## Scheduling validation

Schedule validation is performed against an injected/current instant:

- Earlier than five minutes ahead: invalid
- Exactly five minutes ahead: valid
- Later than 12 calendar months ahead: invalid
- Exactly 12 calendar months ahead: valid

Calendar-month arithmetic is used rather than treating a year as a fixed number of milliseconds.

The contract accepts offset ISO 8601 instants. The account IANA timezone is separately required so future setup and preview endpoints can explain the local scheduled time.

## Campaign preview and validation

`POST /api/campaign-drafts/:id/preview` accepts an optional `first_name` and returns named and missing-name-fallback render samples. Every link uses the non-deliverable `https://preview.invalid` domain; preview never creates booking, referral, recipient, unsubscribe, or preference records.

`POST /api/campaign-drafts/:id/validate` requires `{ "revision": number }`. It returns field errors, a current audience estimate and exclusions, warnings, and—only when valid—a 15-minute validation token. The token is bound to the campaign, owner, revision, validation nonce, and normalized draft submission. A successful draft edit clears the stored nonce, invalidating every prior token.

## Campaign submission and cancellation

`POST /api/campaign-drafts/:id/schedule` and `POST /api/campaign-drafts/:id/send` require `{ revision, validation_token }` plus an `Idempotency-Key` request header. Schedule accepts only drafts configured for scheduled delivery; send accepts only send-now drafts. Submission re-evaluates eligibility immediately before one database transaction snapshots the initial run and all recipients.

The same idempotency key and request returns the original submission response. Reusing a key with another campaign revision or delivery mode returns `409`.

`POST /api/campaigns/:id/cancel` and `POST /api/outreach/scheduled-sends/:id/cancel` both cancel a campaign while it remains `scheduled`. The database transition to `sending` is the cancellation cutoff; a later cancellation returns `409`.

### First-release campaign reporting

`GET /api/campaigns` returns a `summary` for every listed campaign, so the list does not require a separate analytics request per row. `GET /api/campaigns/:id` returns the same values as `metrics`. Both responses include `metric_definitions`.

`recipients` contains raw counts for `total`, `eligible`, `excluded`, `pending`, `queued`, `sending`, `sent`, `delivered`, `failed`, `skipped`, and `cancelled`. `attribution.booked_count` and `attribution.booked_revenue_cents` include only non-cancelled appointments that carry the signed campaign booking attribution. Revenue is an integer number of USD cents.

The metadata declares the 30-day attribution window. Delivery analytics report raw and unique opens/clicks plus their raw numerator and delivery-event denominator. Open/click telemetry can be inflated by privacy proxies, email-security scanners, and automated prefetches; flagged automated and privacy-limited raw counts are returned alongside the headline metrics.

## Compatibility policy

- Canonical enum values are not aliased indefinitely.
- Additive fields may be introduced without a version change.
- Removing or renaming values requires a migration period for active clients.
- The backend owns eligibility, authorization, allowed actions, token rendering, and schedule enforcement.
- This contract creates no route or database behavior by itself.
