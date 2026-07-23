# Outreach Frontend Handoff

## Purpose and status

This is the implementation handoff for the Outreach UI. It supersedes the original frontend requirements audit for the functionality that has since been delivered in the API.

Unless noted as public or provider-only, every route below requires the normal authenticated `/api` session. The backend derives account ownership from authentication. The frontend must never submit a `user_id`, stylist ID, campaign owner ID, provider message ID, or raw attribution ID to establish scope.

All new API field names are `snake_case`. Timestamps are ISO-8601 UTC instants. Money is returned as integer cents with `USD` as the current currency.

## What changed from the original request

| Original requirement | Current implementation |
| --- | --- |
| Campaign `active` / `paused` states | Not supported. One-time campaigns use `draft`, `scheduled`, `sending`, `completed`, `partially_failed`, `failed`, `cancelled`. |
| `review_request` scheduled send | Not supported. Do not render a review-request automation, queue, or status. |
| Unified scheduled-outreach queue | Implemented at `GET /api/outreach/scheduled-sends`. |
| Durable drafts, templates, audience estimate, preview, validation, submit | Implemented. See campaign creation flow below. |
| Campaign reporting | Implemented in campaign list/detail responses. Revenue is cents. |
| Open/click analytics | Implemented as follow-up analytics. Treat metrics as directional because privacy proxies and scanner bots can inflate them. |
| Outbound SMS | Not implemented. Automation bootstrap returns SMS as unavailable and disabled. |
| Booking-confirmation channel settings | No dedicated `/api/settings/booking-confirmations` resource was added. Use the automation bootstrap and existing email-template endpoints; do not offer a persisted SMS toggle. |
| Unified `/api/outreach/bootstrap` | Not implemented. Use the existing dashboard, scheduled-sends, and automations endpoints described below. |

## Canonical enums and product rules

### Campaigns

```text
campaign_kind: one_time
status: draft | scheduled | sending | completed | partially_failed | failed | cancelled
send_mode: now | scheduled
link_type: booking_link | referral_link
audience.mode: everyone | specific
```

Lifecycle:

```text
draft -> scheduled -> sending -> completed
                         -> partially_failed
                         -> failed
draft/scheduled -> cancelled
```

`active`, `paused`, `drafted`, and `review_request` are not aliases. Do not translate them in the UI.

Campaign rules returned by `GET /api/outreach/config` are currently:

| Rule | Value |
| --- | --- |
| Name maximum | 60 characters |
| Subject maximum | 100 characters |
| Editable message maximum | 2,000 characters |
| Supported token | `{{first_name}}` only |
| Missing name fallback | `there` |
| Scheduled lead time | At least 5 minutes |
| Scheduling horizon | At most 12 calendar months |
| Attribution window | 30 days |
| Cancellation cutoff | Before the worker atomically claims the campaign and changes it to `sending` |

Campaigns are marketing email. Eligibility is backend-owned and requires a usable email, email marketing consent, no all-email opt-out, no global unsubscribe, active ownership, and duplicate-email resolution. There is no plan recipient cap.

### Scheduled outreach

```text
kind: appointment_reminder | rebook_nudge | thank_you_email | birthday_reminder | campaign
status: queued | sending | sent | cancelled | skipped | failed
channel: email | sms
```

Initial scheduled outreach only returns email. SMS remains unavailable.

## Recommended screen loading

### Outreach Overview

Load these in parallel on screen entry or refresh:

1. `GET /api/activity/dashboard` for legacy dashboard/needs-attention data.
2. `GET /api/outreach/scheduled-sends?status=queued&limit=3` for the three real upcoming sends.
3. `GET /api/outreach/automations` for controls and customers-reached metric.

For View All, call scheduled sends with `limit=20` and pass the opaque `next_cursor` unchanged.

### Campaigns tab

Call:

```http
GET /api/campaigns?limit=50
```

The list includes `summary` for every returned campaign. Do not call campaign detail merely to populate a featured campaign card. The list route supports a single canonical `status` query value, not a comma-separated status list. Filter client-side only over the loaded page if the screen needs a multi-status presentation.

### Automations tab

Call:

```http
GET /api/outreach/automations
```

This replaces loading all templates plus separate rebook, birthday, and thank-you settings routes during the initial paint. Use each control's returned `mutation` path for saves. Use individual preview routes only when the user asks to preview content.

## Outreach Overview API

### `GET /api/outreach/scheduled-sends`

Query:

```text
status=queued | sending       default queued
kind=comma,separated,kinds    optional
window=today_tomorrow         optional; uses the business timezone
limit=1..100                 default 20
cursor=<opaque value>         optional
```

The cursor is opaque. Legacy requests are ordered by send time, kind, and resource ID; `window=today_tomorrow` requests are ordered by send time and resource ID. Never parse, build, or persist an interpretation of it.

For the Outreach Overview, request `window=today_tomorrow`. The server includes all sends from the business-local start of today through (but excluding) the business-local start of the day after tomorrow. The response additionally includes `category_counts` and `window` metadata; use the frontend date filter only as a defensive fallback.

Response:

```json
{
  "data": [
    {
      "id": "opaque-base64url-resource-id",
      "kind": "appointment_reminder",
      "status": "queued",
      "channel": "email",
      "send_at": "2026-07-19T16:00:00.000Z",
      "recipient": {
        "client_id": "uuid",
        "display_name": "Sarah J."
      },
      "appointment_id": "uuid-or-null",
      "campaign_id": "uuid-or-null",
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

Use `title`, `context_label`, `recipient`, and `allowed_actions` as supplied. A row can be derived from an appointment before an email event exists; the service reconciles it against a queued event so the UI does not receive duplicate appointment reminders. `total_count` uses the full filtered eligible collection, not only the current page.

### `POST /api/outreach/scheduled-sends/:id/cancel`

`id` is the opaque ID from the list response. Body is optional:

```json
{ "reason": "Cancelled from upcoming sends" }
```

Response:

```json
{ "data": { "id": "...", "status": "cancelled" } }
```

Cancellation is source-specific and idempotent before sending begins. Appointment-reminder cancellation creates a suppression for that appointment occurrence only; rescheduling creates a new eligible occurrence. A `409` means delivery already started. Respect `can_cancel`; do not show a cancel control where it is false.

## Campaign authoring flow

### 1. Load campaign configuration

```http
GET /api/outreach/config
```

Response shape:

```json
{
  "campaign": {
    "name_max_length": 60,
    "subject_max_length": 100,
    "message_max_length": 2000,
    "supported_tokens": ["first_name"],
    "missing_first_name_fallback": "there",
    "link_types": ["booking_link", "referral_link"],
    "minimum_schedule_lead_minutes": 5,
    "maximum_schedule_horizon_months": 12,
    "cancellation_cutoff": "before_sending",
    "timezone": "America/Denver"
  }
}
```

Use this response rather than hardcoded frontend limits, timing, or timezone assumptions.

### 2. Optional template list

```http
GET /api/campaign-templates?status=active&limit=20&cursor=<opaque>
```

`status` is `active`, `inactive`, or `all`. Response is `{ data, next_cursor }`. Each template has:

```json
{
  "id": "uuid",
  "name": "Summer booking",
  "description": "optional text",
  "link_type": "booking_link",
  "icon_key": "sun",
  "subject": "A summer appointment for you",
  "message": "Hi {{first_name}}, ...",
  "suggested_audience": { "mode": "everyone" },
  "sort_order": 10,
  "version": 1,
  "active": true
}
```

The message never contains a literal production booking or referral URL. The backend adds the automatic link section at render/send time.

### 3. Create a draft immediately

```http
POST /api/campaign-drafts
Content-Type: application/json

{ "template_id": "uuid-or-omit" }
```

Returns `201` with `{ data: CampaignDraft }`. Save the draft ID as soon as the creation flow starts. This is the durable recovery point.

### 4. Autosave setup and content

```http
PATCH /api/campaign-drafts/:id
```

Every PATCH requires the current `revision` and at least one other field:

```json
{
  "revision": 3,
  "name": "Summer Booking Boost",
  "send_mode": "scheduled",
  "send_at": "2026-08-01T15:00:00.000Z",
  "timezone": "America/Denver",
  "link_type": "booking_link",
  "template_id": "uuid-or-null",
  "audience": {
    "mode": "specific",
    "client_ids": ["uuid", "uuid"]
  },
  "content": {
    "subject": "Ready for your next visit?",
    "message": "Hi {{first_name}}, I would love to see you again."
  }
}
```

Important PATCH behavior:

- `send_at` must be `null`/omitted for `send_mode: "now"`; it is required before scheduled validation/submission.
- `audience` replaces the complete specific selection transactionally; send the full selected ID array every time audience changes.
- Setting `template_id` snapshots the template's version/content into the draft. Editing a template later does not mutate that draft.
- Unknown campaign tokens fail validation. Do not offer any token except `{{first_name}}`.
- Successful PATCH increments the revision and clears a prior validation token.
- Stale revision returns `409` with `details.current_revision`; reload the draft, reconcile UI state, then retry only with user intent.

Draft response:

```json
{
  "id": "uuid",
  "status": "draft",
  "campaign_kind": "one_time",
  "revision": 4,
  "name": "Summer Booking Boost",
  "send_mode": "scheduled",
  "send_at": "2026-08-01T15:00:00.000Z",
  "timezone": "America/Denver",
  "link_type": "booking_link",
  "template_id": "uuid-or-null",
  "template_version": 1,
  "audience": { "mode": "specific", "client_ids": ["uuid"] },
  "content": { "subject": "...", "message": "..." },
  "created_at": "...",
  "updated_at": "..."
}
```

Use `GET /api/campaign-drafts/:id` to restore a draft. Use `DELETE /api/campaign-drafts/:id` to discard it; this succeeds only for a draft and returns `204`.

### 5. Estimate audience and search clients

Estimate:

```http
POST /api/campaigns/audience/estimate

{
  "audience": { "mode": "everyone", "client_ids": [] },
  "link_type": "booking_link"
}
```

`link_type` is accepted by the current request validator but eligibility is campaign-email eligibility and does not change by link type.

Response:

```json
{
  "audience_mode": "everyone",
  "total_count": 130,
  "eligible_count": 118,
  "excluded_count": 12,
  "exclusions": {
    "missing_email": 4,
    "invalid_email": 2,
    "email_marketing_disabled": 4,
    "globally_unsubscribed": 2,
    "client_deleted": 0,
    "duplicate_recipient": 0,
    "not_owned_or_not_found": 0
  },
  "evaluated_at": "2026-07-19T...Z"
}
```

Specific audiences also return `selections: [{ client_id, eligible, reason }]`. `not_owned_or_not_found` intentionally does not reveal whether an ID belongs to another account.

There is no separate campaign-client endpoint. Extend normal client search/list calls with:

```text
campaign_eligibility=email_marketing
```

Each client result includes:

```json
"campaign_eligibility": { "eligible": true, "reason": null }
```

Pass only selected IDs back in draft PATCH. The estimate is advisory; submission rechecks consent and eligibility before recipient snapshots are created.

### 6. Preview safely

```http
POST /api/campaign-drafts/:id/preview

{ "first_name": "Sara" }
```

Response has `campaign_id`, `revision`, `sample`, `missing_name_sample`, and `warnings`. Each sample includes rendered subject, text, HTML, automatic section, and links. Preview links use `https://preview.invalid`; they never create production booking links, referral links, unsubscribe records, preference records, recipients, or sends.

### 7. Validate, then submit

Validation:

```http
POST /api/campaign-drafts/:id/validate

{ "revision": 4 }
```

Response includes:

```json
{
  "valid": true,
  "campaign_id": "uuid",
  "revision": 4,
  "field_errors": [],
  "audience": { "eligible_count": 118, "excluded_count": 12 },
  "warnings": ["12 recipients are excluded from this send."],
  "validation_token": "short-lived-token",
  "validation_expires_at": "2026-07-19T...Z"
}
```

Only a valid response contains a usable token. It expires after 15 minutes and is bound to campaign, owner, revision, nonce, and normalized submission values. Any draft edit invalidates it.

Submit a scheduled draft:

```http
POST /api/campaign-drafts/:id/schedule
Idempotency-Key: <stable-client-generated-key>

{ "revision": 4, "validation_token": "..." }
```

Submit a send-now draft:

```http
POST /api/campaign-drafts/:id/send
Idempotency-Key: <stable-client-generated-key>

{ "revision": 4, "validation_token": "..." }
```

The exact same idempotency key with the same request returns the original submission result. Reusing the key with changed request content returns `409`. Treat network uncertainty by retrying with the same key, never generating a replacement key automatically.

Submission returns a campaign/run summary including `campaign_id`, `run_id`, `status`, `send_mode`, `scheduled_for`, `recipient_total`, `eligible_count`, and `excluded_count`. The backend creates recipient snapshots transactionally and reevaluates eligibility at that moment.

## Campaign list, detail, cancellation, and reporting

### `GET /api/campaigns`

Query:

```text
status=<one canonical campaign status>  optional
limit=1..100                           default 50
```

There is no cursor in this route today. The returned list is newest-first by campaign creation time.

Response:

```json
{
  "data": [
    {
      "id": "uuid",
      "name": "Summer Booking Boost",
      "status": "completed",
      "send_mode": "now",
      "scheduled_for": "2026-07-19T...Z",
      "audience_mode": "everyone",
      "recipient_total": 118,
      "eligible_count": 118,
      "excluded_count": 12,
      "summary": { "recipients": {}, "attribution": {}, "delivery_analytics": {} },
      "allowed_actions": ["view"],
      "created_at": "...",
      "updated_at": "..."
    }
  ],
  "metric_definitions": { "...": "..." }
}
```

`summary` is already the per-row analytics payload. Use it for campaign cards and featured campaign UI without N+1 detail requests.

### `GET /api/campaigns/:id`

Returns `{ data: CampaignDetail }`. It contains the same list-safe base fields and `summary`, plus:

```json
{
  "metrics": {
    "recipients": {
      "total": 130,
      "eligible": 118,
      "excluded": 12,
      "pending": 0,
      "queued": 0,
      "sending": 0,
      "sent": 110,
      "delivered": 100,
      "failed": 2,
      "skipped": 8,
      "cancelled": 0
    },
    "attribution": {
      "booked_count": 4,
      "booked_revenue_cents": 50000,
      "currency": "USD"
    },
    "delivery_analytics": {
      "delivered_raw": 100,
      "opens": {
        "raw": 75,
        "unique": 60,
        "automated_raw": 5,
        "privacy_limited_raw": 9,
        "rate": { "numerator": 60, "denominator": 100, "value": 0.6 }
      },
      "clicks": {
        "raw": 21,
        "unique": 16,
        "automated_raw": 2,
        "privacy_limited_raw": 0,
        "rate": { "numerator": 16, "denominator": 100, "value": 0.16 }
      }
    }
  },
  "metric_definitions": { "...": "..." }
}
```

Metric rules:

- Recipient figures are raw rows grouped by current eligibility/status and reconcile to recipient records.
- Bookings/revenue include non-cancelled appointments with signed campaign attribution only. Revenue is appointment price converted to integer cents, not payment-collection revenue.
- The attribution window is 30 days from recipient queueing; `metric_definitions.attribution_window` provides the authoritative rule.
- `raw` counts every event; `unique` counts distinct campaign recipients.
- Rate `value` is `unique / delivered_raw`; always use the supplied numerator and denominator. When no delivery events exist, `value` is `null`.
- Open/click tracking starts only after delivery analytics is deployed. There is no fabricated historical backfill.
- `automated_raw` and `privacy_limited_raw` are not removed from headline metrics. Show a privacy/scanner caveat rather than treating opens as exact human behavior.

Current detail limitation: this endpoint is a reporting/detail-summary endpoint. It does **not** return editable draft setup/content, template snapshots, individual recipients, or recipient-level errors. Those values are available only while a campaign is a draft through `GET /api/campaign-drafts/:id`; submitted campaigns are view-only in the current release.

### Cancel a campaign

```http
POST /api/campaigns/:id/cancel

{ "reason": "Optional reason, maximum 1,000 characters" }
```

This works only while status is `scheduled`. It is idempotent while already cancelled. A `409` after the delivery worker has claimed the campaign is expected; refresh the campaign and show its current state. Campaigns in `sending`, completed, failed, or partially failed are view-only.

## Tracked campaign links and booking attribution

Campaign emails contain opaque recipient tracking links generated by the backend. The frontend does not construct campaign URLs.

Public redirect endpoint:

```http
GET /api/public/campaign-links/:token
```

The browser follows this link from the email. The API records a tracked click, resolves the opaque token, and redirects to the canonical booking UI with a short-lived signed booking context. Raw campaign/client/recipient IDs cannot be forged by the browser.

For referral-link campaigns, the redirect preserves both campaign attribution and referral attribution. A booking created from the signed context persists campaign, run, and recipient attribution. Cancelled appointments are excluded from reporting.

The public redirect should normally be opened by the email client, not called from authenticated app UI.

## Delivery analytics provider integration

This is backend/provider configuration, not a frontend call:

```http
POST /webhooks/resend
```

Configure Resend to send signed Svix webhooks here and configure `RESEND_WEBHOOK_SECRET` in the API environment. The backend verifies the raw payload signature (`svix-id`, `svix-timestamp`, `svix-signature`) before recording events.

Supported provider event types are delivery, open, click, bounce, and complaint. Duplicate provider events are idempotent by `(provider, provider_event_id)`. Existing recipients use stored `provider_message_id`; no recipient table redesign was required. Unknown/unmatched provider messages are acknowledged without becoming campaign metrics.

## Automations

### `GET /api/outreach/automations`

Returns:

```json
{
  "account_timezone": "America/Denver",
  "summary": { "enabled_count": 4, "available_count": 6, "total_count": 6 },
  "controls": ["..."],
  "customers_reached": {
    "unique_clients": 42,
    "window_start": "...",
    "window_end": "...",
    "timezone": "America/Denver",
    "window_kind": "rolling",
    "window_days": 30,
    "included_message_types": ["..."]
  }
}
```

Implemented controls:

```text
email_confirmations
appointment_reminders
rebook_nudges
thank_you_emails
birthday_reminders
waitlist_match
```

Each control has `enabled`, entitlement (`feature_available`, `unavailable_reason`), counts, `mode`, channel capabilities, timing, settings, content rules, templates, and a canonical mutation. Do not infer 24-hour appointment reminder timing; use `timing.lead_time_minutes` (currently `1440`) and `settings.individualCancellationSupported`.

SMS is always represented as:

```json
{ "available": false, "enabled": false, "unavailable_reason": "Outbound SMS is not available yet." }
```

Never make an SMS toggle look saved or functional.

Automation saves use the control mutation returned by the bootstrap. The current canonical settings routes are:

```text
PATCH /api/activity/automation/settings/:key
PATCH /api/settings/rebook-nudges
PATCH /api/settings/thank-you-emails
PATCH /api/settings/birthday-reminders
PATCH /api/settings/email-templates/:emailType
```

Use controls' returned `content_rules` and `templates` rather than campaign content limits. Automation templates currently have distinct limits/token sets.

## Error and state handling

- `400`: malformed request, invalid token, invalid cursor, unsupported enum, validation failure, invalid selected client ID, or missing idempotency key.
- `401`: not authenticated (or invalid provider signature for the webhook).
- `404`: absent/foreign owned authenticated resource is intentionally not disclosed; draft/template/campaign may be reported as not found.
- `409`: stale draft revision, invalidated/expired validation token, idempotency key reused with changed request, campaign/reminder already sending, or another lifecycle race. Refresh before displaying a recovery action.
- `503`: required Supabase migration has not been applied. The response identifies the required outreach schema marker.

Do not optimistically invent lifecycle values, delivery counts, allowed actions, eligibility, or cancellation results. Refetch/replace the affected resource using the response after a successful mutation.

## Deployment and migration checklist

The frontend should not enable these routes until the database migrations are applied in order. The current required schema marker is:

```text
campaign_delivery_analytics_2026_07_18
```

Manual SQL migrations:

```text
202607180001_outreach_scheduled_sends_and_reminder_suppressions.sql
202607180002_campaign_schema_foundation.sql
202607180003_campaign_drafts_and_templates.sql
202607180004_outreach_corrective_pass.sql
202607180005_campaign_submission_and_cancellation.sql
202607180006_campaign_booking_attribution.sql
202607180007_campaign_delivery_worker.sql
202607180008_campaign_reporting.sql
202607180009_campaign_delivery_analytics.sql
```

After applying them, run the manual Supabase smoke test:

```text
supabase/smoke/20260718_outreach_campaigns_smoke.sql
```

For analytics, also configure the Resend webhook URL and `RESEND_WEBHOOK_SECRET`. Historical campaigns will show stored delivery/booking data where present, but open/click event history begins only after the analytics migration and webhook are live.
