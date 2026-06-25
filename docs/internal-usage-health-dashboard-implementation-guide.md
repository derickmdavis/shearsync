# Internal Usage And Health Dashboard Backend Implementation Guide

Created: 2026-06-24

Inputs:

- Accessible plan: `DripDesk Internal Usage + Health Dashboard Backend Plan`
- `docs/production-readiness-code-review-2026-06-22.md`
- Additional guardrails from the 2026-06-24 planning thread
- Current backend implementation in `src/` and current Supabase schema/migrations

This guide is backend-only. Do not build the dashboard UI in this initiative.

## Scope Boundary

Recent payment decisions override the original plan where they conflict:

- Do not reintroduce `appointment_payments`.
- Do not track appointment paid/unpaid state.
- Do not emit `appointment_marked_paid` or `appointment_marked_unpaid`.
- Do not calculate “payments marked paid.”
- Do not store payment URLs in metadata.

Payment shortcut usage is still in scope:

- count configured payment shortcuts from `payment_methods`
- track shortcut creation/update/deactivation
- optionally track frontend-originated `payment_qr_shown` and `payment_link_opened` events, without storing QR paths, signed URLs, or payment URLs

Assumption from the request: required SQL changes have already been made. This guide still names expected SQL columns so implementation can verify the contract and fail clearly if staging/prod drift.

## Required SQL Contract To Verify

The original plan creates:

- `admin_users`
- `product_events`
- `notification_events`
- `job_runs`
- `api_request_logs`
- `booking_error_events`
- `admin_account_notes`

The implementation must also assume or verify these guardrail deltas:

- `environment text` exists on analytics/logging tables.
- `product_events.dedupe_key text null` exists.
- A unique index exists for non-null product event dedupe keys, ideally on `(environment, event_type, dedupe_key)` or `(environment, dedupe_key)`.
- `booking_error_events.severity text` exists.
- `api_request_logs.severity text` exists.
- `api_request_logs` can support retention cleanup by `created_at`.

If any guardrail delta is missing in staging, pause backend implementation and update SQL first.

## Privacy And Data Rules

Never store the following in `metadata`, notes-derived metadata, product events, request logs, booking error events, or job metadata:

- full message bodies
- raw phone numbers
- raw emails
- raw IP addresses
- auth tokens
- public appointment action tokens
- signed upload/read URLs
- payment URLs
- QR storage paths unless explicitly needed for an internal storage repair workflow

Allowed safe identifiers:

- internal UUIDs such as `user_id`, `client_id`, `appointment_id`, `service_id`
- public stylist slug
- event names
- status values
- provider names like `venmo`, `zelle`, `cash`
- booleans like `has_payment_url`, `has_qr_image_path`
- counts and durations

## Chunk 1: Environment And Metadata Sanitization

Goal: create a safe foundation before any persistent logging.

Files:

- `src/config/env.ts`
- `src/lib/safeMetadata.ts`
- `src/types/api.ts`
- tests in `src/__tests__/safeMetadata.test.ts`

Implementation:

1. Add env values:
   - `APP_ENV`, optional, default from `NODE_ENV`
   - `API_REQUEST_LOG_RETENTION_DAYS`, optional, default `30`
   - optionally `ADMIN_API_KEY`, if supporting server-to-server admin access in addition to admin users
2. Add `getAppEnvironment()` helper:
   - returns `APP_ENV` when present
   - otherwise returns `NODE_ENV`
   - normalized values: `development`, `test`, `staging`, `production`
3. Add `sanitizeMetadata(input)`:
   - accepts unknown input
   - returns a plain object
   - recursively redacts sensitive keys
   - bounds depth, array length, string length, and serialized byte size
4. Redact by key pattern:
   - `email`, `phone`, `message`, `body`, `token`, `authorization`, `signed_url`, `signedUrl`, `payment_url`, `paymentUrl`, `url`, `ip`
5. Add tests for:
   - redacting raw email/phone/token/signed URL/payment URL
   - preserving safe status, IDs, counts, provider names
   - bounding deeply nested metadata

Acceptance criteria:

- All later services can import one sanitizer.
- No raw sensitive values survive sanitizer tests.

## Chunk 2: Product Events Service

Goal: track usage, activation, funnel, and account-health events.

Files:

- `src/services/productEventsService.ts`
- `src/__tests__/productEvents.test.ts`
- `src/services/schemaReadinessService.ts`

Service API:

```ts
recordProductEvent({
  accountUserId,
  actorUserId,
  clientId,
  appointmentId,
  eventType,
  eventSource,
  stylistSlug,
  anonymousId,
  sessionId,
  dedupeKey,
  metadata
})
```

Implementation:

1. Require `eventType`; normalize to lower snake case or reject invalid names.
2. Default `eventSource` to `backend`.
3. Always write `environment`.
4. Always sanitize `metadata`.
5. If `dedupeKey` is provided, use it for idempotent one-time events.
6. Treat duplicate dedupe conflicts as success:
   - return `{ inserted: false, deduped: true }`
   - do not throw for expected retries
7. Add schema readiness checks for critical columns:
   - `environment`
   - `event_type`
   - `event_source`
   - `dedupe_key`
   - `metadata`
   - `created_at`

Initial backend event taxonomy:

- `user_opened_app`
- `account_created`
- `profile_updated`
- `booking_page_enabled`
- `booking_page_disabled`
- `service_created`
- `service_updated`
- `service_deleted`
- `business_hours_updated`
- `booking_settings_updated`
- `notification_settings_updated`
- `payment_shortcut_created`
- `payment_shortcut_updated`
- `payment_shortcut_disabled`
- `appointment_created`
- `appointment_completed`
- `appointment_cancelled`
- `appointment_rescheduled`
- `appointment_no_show`
- `booking_page_viewed`
- `public_booking_started`
- `public_booking_service_selected`
- `public_booking_date_selected`
- `public_booking_time_selected`
- `public_booking_client_info_started`
- `public_booking_submitted`
- `public_booking_submission_failed`
- `booking_approved`
- `booking_rejected`
- `client_created`
- `client_updated`
- `client_photo_added`
- `client_note_added`
- `automation_enabled`
- `automation_disabled`
- `automation_sent`
- `automation_failed`
- `automation_skipped`
- `payment_qr_shown`
- `payment_link_opened`
- `referral_link_created`
- `referral_qr_created`
- `referral_link_clicked`
- `referral_booking_started`
- `referral_booking_submitted`
- `referral_booking_completed`
- `waitlist_entry_created`
- `waitlist_match_found`
- `waitlist_notification_sent`
- `waitlist_opening_filled`

Important dedupe keys:

- `account_created:<user_id>`
- `public_booking_submitted:<appointment_id>`
- `appointment_created:<appointment_id>`
- `client_created:<client_id>`
- `waitlist_entry_created:<waitlist_entry_id>`
- `referral_link_created:<referral_link_id>`
- `payment_shortcut_created:<payment_method_id>`

Acceptance criteria:

- Product events can be recorded safely.
- One-time events dedupe.
- Payment shortcut events do not store `payment_url`, `qr_image_url`, `qr_image_path`, or signed URLs.

## Chunk 3: Notification Events Service

Goal: provide queue and delivery health for email/SMS/automation.

Files:

- `src/services/notificationEventsService.ts`
- integration points in email/reminder/automation services
- `src/__tests__/notificationEvents.test.ts`
- `src/services/schemaReadinessService.ts`

Service API:

```ts
recordNotificationQueued(payload)
recordNotificationSent(payload)
recordNotificationFailed(payload)
recordNotificationSkipped(payload)
getQueueStatus(range)
getNotificationFailuresForAccount(userId, range)
getAutomationsSentCount(userId, range)
```

Notification types:

- `booking_confirmation`
- `booking_request_received`
- `booking_approved`
- `booking_rejected`
- `appointment_reminder`
- `thank_you_email`
- `review_request`
- `rebook_nudge`
- `birthday_reminder`
- `waitlist_match`
- `account_email`

Implementation:

1. Always write `environment`.
2. Use safe columns for provider errors:
   - `provider`
   - `provider_message_id`
   - `provider_error_code`
   - bounded `provider_error_message`
3. Do not store message bodies.
4. Do not store raw recipient email/phone in metadata.
5. Map existing appointment email delivery events into notification events at send/fail/skip boundaries.
6. For automation health, `notification_events` is the source of truth; optional `product_events` can mirror high-level `automation_sent`/`automation_failed`.

Acceptance criteria:

- Admin system health can compute email/SMS queue status.
- Account detail can show notification failures.
- Existing mobile/public behavior is unchanged.

## Chunk 4: Job Runs Service

Goal: track workers, cron jobs, and cleanup tasks.

Files:

- `src/services/jobRunsService.ts`
- worker/script updates, starting with `src/scripts/processAppointmentEmails.ts`
- future cleanup script updates
- `src/__tests__/jobRuns.test.ts`

Service API:

```ts
startJobRun(jobName, metadata)
completeJobRun(jobRunId, stats)
failJobRun(jobRunId, error, stats)
skipJobRun(jobName, reason)
getLastSuccessfulJobRun()
getFailedJobsCount(range)
```

Initial job names:

- `appointment-emails-worker`
- `appointment-reminders-worker`
- `birthday-reminder-worker`
- `rebook-nudge-worker`
- `thank-you-email-worker`
- `api-request-logs-cleanup`
- `client-purge-worker`
- `appointment-image-cleanup-worker`

Implementation:

1. Insert `status='started'` when a job begins.
2. Update to `completed`, `failed`, `skipped`, or `cancelled`.
3. Capture:
   - `started_at`
   - `finished_at`
   - `duration_ms`
   - `records_processed`
   - `records_succeeded`
   - `records_failed`
   - safe error code/message
   - sanitized metadata
4. Always write `environment` if SQL includes it.

Acceptance criteria:

- System health can show failed jobs last 24h and last successful run.
- Job instrumentation failures do not mask the underlying worker result.

## Chunk 5: API Request Logs And Retention

Goal: persist lightweight request latency/error logs and clean them up from the start.

Current state:

- `src/lib/logger.ts` already assigns request IDs and emits JSON logs.
- It does not persist `api_request_logs`.

Files:

- `src/lib/logger.ts`
- `src/services/apiRequestLogsService.ts`
- `src/services/apiRequestLogRetentionService.ts`
- `src/scripts/cleanupApiRequestLogs.ts`
- `src/routes/internalRoutes.ts`
- `src/controllers/internalController.ts`
- `package.json`
- tests in `src/__tests__/apiRequestLogs.test.ts`

Implementation:

1. Add `apiRequestLogsService.record(input)`:
   - fire-and-forget after response finish
   - insert with service role
   - never fail the HTTP response
2. Write:
   - `environment`
   - `request_id`
   - `method`
   - `path`
   - `route_pattern`
   - `status_code`
   - `duration_ms`
   - `account_user_id`
   - `actor_user_id`
   - `error_code`
   - `error_message`
   - `severity`
   - sanitized metadata
3. Do not store raw IP. If needed, add `ip_hash` using a server-side salt.
4. Exclude noisy routes:
   - `/health`
   - `/favicon.ico`
   - static assets
5. Severity mapping:
   - `<400`: `info`
   - `400-499`: `warning`
   - `500-599`: `error`
   - explicit critical errors: `critical`
6. Add retention cleanup:
   - default `30` days via `API_REQUEST_LOG_RETENTION_DAYS`
   - internal endpoint: `POST /internal/api-request-logs/cleanup`
   - package script: `cleanup:api-request-logs`
   - record a `job_runs` row for cleanup
7. Tests:
   - successful request logs `info`
   - validation error logs `warning`
   - server error logs `error`
   - query tokens are redacted or omitted
   - cleanup deletes only older rows

Acceptance criteria:

- API latency and error rate can be computed by environment.
- API logs have retention from day one.

## Chunk 6: Booking Error Events

Goal: answer “why could a client not book?” and monitor booking reliability.

Files:

- `src/services/bookingErrorEventsService.ts`
- public booking, appointment management, waitlist, and public image services
- `src/__tests__/bookingErrorEvents.test.ts`

Booking steps:

- `stylist_lookup`
- `availability_generation`
- `service_selection`
- `client_lookup`
- `booking_submission`
- `booking_approval`
- `booking_cancel`
- `booking_reschedule`
- `waitlist_submit`
- `reference_photo_upload`

Implementation:

1. Add `recordBookingError(payload)`.
2. Always write `environment`.
3. Always write `severity`.
4. Store safe IDs/slugs only:
   - `account_user_id`
   - `client_id`
   - `appointment_id`
   - `stylist_slug`
   - `request_id`
   - `session_id`
   - `anonymous_id`
5. Error codes:
   - `slot_unavailable`
   - `booking_validation_failed`
   - `booking_conflict`
   - `booking_insert_failed`
   - `manage_link_invalid`
   - `manage_link_expired`
   - `reference_photo_upload_failed`
   - `waitlist_create_failed`
6. Do not store raw customer names, emails, phones, notes, manage-link tokens, or signed URLs.

Acceptance criteria:

- System health can count booking errors last 24h.
- Admin account detail can show recent booking failures.
- Expected user-facing validation failures are `warning`, not `error`.

## Chunk 7: Error Severity Plumbing

Goal: make API severity consistent across request logs and booking errors.

Files:

- `src/lib/errors.ts`
- `src/middleware/errorHandler.ts`
- `src/lib/logger.ts`
- tests in `src/__tests__/apiRoutes.test.ts` or `src/__tests__/errorHandler.test.ts`

Implementation:

1. Extend `ApiError` options with optional `severity`.
2. Add `getErrorSeverity(error, statusCode)`.
3. Set `res.locals.error` to include:
   - `code`
   - `message`
   - `severity`
4. Do not expose internal details in production.
5. Ensure API request logs use the same severity.

Acceptance criteria:

- Validation errors are `warning`.
- Expected conflicts are `warning`.
- 5xx errors are `error`.
- Explicit invariant/security anomalies can be `critical`.

## Chunk 8: Admin Authorization

Goal: protect all future dashboard endpoints.

Current state:

- `requireAuth` exists.
- `requireInternalApiSecret` exists.
- `requireAdmin` does not exist.

Files:

- `src/middleware/adminAuth.ts`
- `src/routes/adminRoutes.ts`
- `src/routes/index.ts`
- `src/__tests__/adminAuth.test.ts`

Implementation:

1. Add `requireAdmin` after `requireAuth`.
2. Admin check:
   - use authenticated user email if available
   - query `admin_users.email`
   - require `is_active = true`
3. Use service-role Supabase access for the admin lookup.
4. Admin dashboard endpoints must use service-role reads after `requireAdmin` passes because RLS intentionally blocks normal user reads.
5. Optionally support server-to-server dashboard access with a dedicated admin API key, but do not replace user admin checks unless explicitly needed.

Acceptance criteria:

- Normal authenticated users receive 403.
- Admin users can access `/api/admin/*`.
- Admin endpoints do not rely on direct Supabase client reads from the browser.

## Chunk 9: Admin Dashboard Services And Endpoints

Goal: return dashboard-ready JSON. No UI.

Files:

- `src/routes/adminRoutes.ts`
- `src/controllers/adminController.ts`
- `src/services/adminDashboardService.ts`
- `src/services/adminMetricsService.ts`
- `src/__tests__/adminDashboard.test.ts`

Endpoints:

- `GET /api/admin/system-health`
- `GET /api/admin/business-overview?range=30d`
- `GET /api/admin/accounts?range=30d`
- `GET /api/admin/accounts/:userId`

### `GET /api/admin/system-health`

Return:

- API status, uptime, environment, optional version
- DB status and latency
- email queue: queued, scheduled, sent last 24h, failed last 24h
- SMS queue: queued, scheduled, sent last 24h, failed last 24h
- jobs: failed last 24h, last successful run
- booking errors last 24h
- API latency average and p95 last 24h

Sources:

- process uptime
- lightweight DB query
- `notification_events`
- `job_runs`
- `booking_error_events`
- `api_request_logs`

### `GET /api/admin/business-overview`

Return:

- total stylists
- active stylists last 7/30 days
- appointments booked today/week/month
- public bookings submitted
- clients created
- automations sent and failed
- recorded revenue
- booking page views
- top active accounts

Revenue rule:

- Do not use `appointment_payments`.
- For MVP, recorded revenue source is `appointment_price_fallback`.
- Calculate from `appointments.price` for completed appointments unless a non-payment-tracking SQL contract already supplies recorded revenue.
- Return:

```json
{
  "revenue": {
    "recorded": 8240,
    "source": "appointment_price_fallback"
  }
}
```

### `GET /api/admin/accounts`

Return account monitor rows:

- user ID
- business name
- plan tier/status
- signup date
- last login
- last meaningful action
- booking enabled
- services count
- clients count
- appointments last 30 days
- public bookings last 30 days
- automations sent last 30 days
- failures last 30 days
- setup score
- health status and reasons

### `GET /api/admin/accounts/:userId`

Return:

- account summary
- setup checklist
- usage trend
- recent appointments
- recent events
- automation status
- notification failures
- public booking funnel
- clients added
- payment shortcut usage
- referral usage
- support notes

Payment shortcut usage fields:

```json
{
  "methodsConfigured": 0,
  "qrShownLast30Days": 0,
  "linkOpenedLast30Days": 0
}
```

Do not include appointments marked paid/unpaid.

Acceptance criteria:

- Endpoints are admin-only.
- Endpoints filter by `environment` where applicable.
- Counts can be manually verified with SQL.

## Chunk 10: Admin Account Notes

Goal: support internal support notes per stylist/account.

Files:

- `src/services/adminAccountNotesService.ts`
- `src/controllers/adminController.ts`
- `src/routes/adminRoutes.ts`
- `src/__tests__/adminAccountNotes.test.ts`

Endpoints:

- `GET /api/admin/accounts/:userId/notes`
- `POST /api/admin/accounts/:userId/notes`
- optional later: `PATCH /api/admin/accounts/:userId/notes/:noteId`
- optional later: soft delete

Implementation:

1. Notes are admin-only.
2. Use service-role access after `requireAdmin`.
3. Store `created_by_admin_email`.
4. Sanitize metadata.
5. Keep note content professional and factual.

Acceptance criteria:

- Admin can create/list notes.
- Non-admin cannot access notes.

## Chunk 11: Setup Score And Health Status

Goal: make account monitor and account detail actionable.

Setup checklist: 10 points each.

- profile complete: business name or stylist display name exists
- booking page enabled
- services configured: at least one visible/active service
- business hours configured: at least one active availability row
- timezone set
- notifications configured: at least one relevant confirmation/reminder setting enabled
- payment shortcut added: at least one active `payment_methods` row
- first client created
- first appointment created
- automation enabled: at least one automation setting enabled

Health status:

- `healthy`
  - meaningful action within 7 days
  - booking page configured
  - no critical failures in last 7 days
  - at least one appointment in last 30 days
- `needs_attention`
  - setup score below 70
  - no appointments in last 30 days
  - booking page disabled
  - high pending approvals
  - notification failures in last 7 days
- `at_risk`
  - no login or meaningful action in 14+ days
  - setup score below 40
  - repeated notification failures
  - repeated booking errors
  - no services or no business hours

Meaningful actions:

- appointment created/completed/cancelled/rescheduled/no-show
- booking approved/rejected
- client created/updated
- service created/updated
- business hours updated
- booking page enabled
- automation enabled/disabled
- payment shortcut created/updated/disabled
- waitlist entry created
- referral link created/clicked

Do not count page views as meaningful stylist actions.

## Chunk 12: Instrument Critical Flows

Goal: add events gradually after services and admin endpoints are stable.

Start with:

- login/app open
- public booking page viewed
- public booking submitted
- public booking submission failed
- appointment created
- booking approved/rejected
- client created
- automation enabled/disabled
- notification queued/sent/failed/skipped
- job started/completed/failed
- booking errors
- payment shortcut created/updated/disabled
- referral link created/clicked
- waitlist entry created

Metadata examples:

- appointment created:
  - `source`
  - `status`
  - `service_id`
  - `has_price`
- payment shortcut created:
  - `provider`
  - `has_payment_url`
  - `has_qr_image_url`
  - `has_qr_image_path`
- public booking funnel:
  - `stylist_slug`
  - `service_id`
  - `source: "public_booking"`

Do not store service notes, client notes, message bodies, customer contact info, payment URLs, QR paths, or signed URLs.

## Chunk 13: Revenue Source Metadata In User-Facing Metrics

Goal: frontend dashboards know whether revenue came from current appointment prices or another safe source.

Current state:

- `dashboardService` monthly revenue uses completed appointment prices.
- `calendarService` maps appointment `revenue` to `price`.
- `appointmentMetrics.getAppointmentValue` uses `revenue ?? price`.

Implementation:

1. Add revenue source type:

```ts
type RevenueSource = "appointment_price_fallback" | "recorded_revenue";
```

2. Current source should be `appointment_price_fallback`.
3. Add to dashboard:

```json
{
  "monthly_revenue_summary": {
    "completed_revenue": 1200,
    "source": "appointment_price_fallback"
  }
}
```

4. Add to calendar appointment rows:

```json
{
  "revenue": 95,
  "revenue_source": "appointment_price_fallback"
}
```

5. Add to admin business overview revenue:

```json
{
  "recorded": 8240,
  "source": "appointment_price_fallback"
}
```

Acceptance criteria:

- No code references `appointment_payments`.
- Dashboard/calendar/admin revenue responses include `source`.

## Chunk 14: Runbook And Manual Verification

Files:

- `docs/internal-dashboard-runbook.md`
- update `README.md` only if useful

Runbook content:

- how to verify SQL tables
- how to seed/admin-enable an `admin_users` row
- how to verify `APP_ENV`
- how to query product events by environment
- how to check notification queue health
- how to check failed jobs
- how to run `api_request_logs` cleanup
- how to manually verify admin endpoint counts against SQL
- sensitive data audit checklist

Smoke checklist:

1. Hit `GET /api/health`.
2. Hit one authenticated endpoint.
3. Trigger one validation error.
4. Confirm `api_request_logs` has environment and severity.
5. Create a staging public booking.
6. Confirm product event dedupe.
7. Trigger a safe booking validation miss.
8. Confirm `booking_error_events` has warning severity.
9. Run request-log cleanup.
10. Confirm non-admin cannot access `/api/admin/system-health`.
11. Confirm admin can access `/api/admin/system-health`.

## Testing Requirements

Run after each chunk:

```bash
npm run typecheck
npm test
```

Minimum new tests:

- metadata sanitizer
- product event insert/dedupe
- notification event service
- job runs service
- API request logging
- API request log cleanup
- booking error service
- error severity mapping
- admin auth
- admin system health
- admin business overview
- admin accounts list
- admin account detail
- admin notes
- revenue source metadata

## Recommended Implementation Order

1. Environment and sanitizer
2. Product events service
3. Notification events service
4. Job runs service
5. API request logs and cleanup
6. Booking error events
7. Error severity plumbing
8. Admin authorization
9. Admin system health endpoint
10. Admin business overview endpoint
11. Admin accounts list endpoint
12. Admin account detail endpoint
13. Admin account notes
14. Setup score and health status refinements
15. Critical flow instrumentation
16. Revenue source metadata
17. Runbook

## Out Of Scope

- dashboard UI
- analytics warehouse
- complex cohorts
- predictive churn
- third-party analytics
- exposing event tables directly to the mobile app
- appointment payment tracking
- paid/unpaid appointment state
- storing raw IP, email, phone, tokens, signed URLs, payment URLs, or full message bodies

