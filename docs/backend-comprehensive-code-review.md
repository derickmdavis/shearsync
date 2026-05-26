# ShearSync Backend Comprehensive Code Review

Generated from the authored repository files in `src/`, `supabase/`, `docs/`, root config files, and tests. Generated artifacts and dependencies (`dist/`, `node_modules/`) are intentionally excluded from behavioral review because they are compiled output or third-party code.

## Executive Summary

The backend is a Node 20, TypeScript, Express API using Supabase Auth/Postgres/Storage-facing metadata, Zod validation, and a service-layer pattern. Routes are thin; controllers extract auth/user/params; services own database reads/writes, derived fields, appointment conflict checks, public booking policy, waitlist gating, activity feed events, and appointment email queueing.

All authenticated business routes are mounted after `requireAuth`, which validates a Supabase bearer token via `supabaseAnon.auth.getClaims()` or uses an explicit dev fallback when configured. The backend then uses the Supabase service role client (`supabaseAdmin`) for database operations and manually scopes by `user_id` or `stylist_id`.

Important write side effects:

- Creating an appointment writes `appointments` and records `activity_events.booking_created`.
- Cancelling an appointment updates `appointments.status`, records `activity_events.appointment_cancelled`, and queues `appointment_email_events.appointment_cancelled`.
- Rescheduling an appointment updates `appointments.appointment_date` and/or `duration_minutes`, records `activity_events.appointment_rescheduled`, and public reschedules queue `appointment_email_events.appointment_rescheduled`.
- Public booking may create or update a `clients` row, creates `appointments`, and queues an appointment email.
- Waitlist creation writes `waitlist_entries` and records `activity_events.waitlist_joined`.
- Updating a reminder to `sent` writes `reminders.sent_at` if absent and records `activity_events.reminder_sent`.
- Booking settings update `stylists`; booking rules update `booking_rules`; availability replacement deletes and reinserts `availability`.

## Root And Runtime Files

- `package.json`: scripts are `dev`, `build`, `start`, `typecheck`, `test`, and `process:appointment-emails`. Runtime dependencies are Express, Supabase JS, Zod, JWT, Resend, Helmet, CORS, Morgan, dotenv.
- `tsconfig.json`: TypeScript compiler config for source-to-`dist`.
- `railway.json`: Railway build/start configuration.
- `README.md`: setup, route overview, public booking/waitlist contract.
- `src/server.ts`: starts `app` on `process.env.PORT` or `3000`.
- `src/app.ts`: applies Helmet, CORS, JSON limit `1mb`, Morgan, `apiRouter`, 404 handler, error handler.
- `src/config/env.ts`: validates env with Zod. Requires Supabase URL/anon/service-role keys. Production forbids `AUTH_MODE=dev`.

```ts
app.use(express.json({ limit: "1mb" }));
app.use(apiRouter);
app.use(notFoundHandler);
app.use(errorHandler);
```

## Middleware And Shared Libraries

- `src/middleware/auth.ts`: parses `Authorization: Bearer <token>`, verifies with Supabase Auth claims, attaches `req.auth` and `req.user`, logs diagnostics outside production. Dev fallback requires `AUTH_MODE=dev`, `ENABLE_DEV_AUTH_FALLBACK=true`, and `DEV_AUTH_USER_ID`.
- `src/middleware/internalAuth.ts`: protects internal cron endpoint with `x-internal-api-secret`, compared with `timingSafeEqual`.
- `src/middleware/validate.ts`: parses `body`, `params`, and `query` with Zod. It wraps validation failures in `ApiError(400, "Validation failed", error)`, so the main `ZodError` branch in `errorHandler` is rarely reached for route validation.
- `src/middleware/errorHandler.ts`: returns `{ error: { message, details } }`; `ApiError.details` are hidden in production unless `exposeDetails`.
- `src/lib/supabase.ts`: creates `supabaseAdmin` with service role and `supabaseAnon` with anon key.
- `src/lib/request.ts`: `getAuthUserId()` ensures the user exists before continuing; `getCurrentUser()` returns the user row.
- `src/lib/appointments.ts`: appointment end and overlap math. Overlap is strict interval overlap: `newStart < existingEnd && newEnd > existingStart`.
- `src/lib/timezone.ts`: business-local day conversions, local date/day-of-week, offset formatting, UTC conversion for local business times.
- `src/lib/phone.ts`: normalizes US 10-digit or `+` international numbers to E.164-like strings; masks last four digits.
- `src/lib/publicBookingContext.ts`: 30-minute HS256 JWT telling public booking whether submitted contact is an existing client for a specific stylist slug.
- `src/lib/publicAppointmentManagement.ts`: HS256 JWT for public appointment management links. Expiration is the appointment start timestamp.
- `src/lib/plans.ts`: plan tiers and feature flags. Basic has no SMS/waitlist/custom cover/custom slug; Pro gets SMS/waitlist/custom cover; Premium gets all listed flags.
- `src/lib/activityTypes.ts`: activity type/category constants.
- `src/lib/errors.ts`: `ApiError`, `notFound`, `requireFound`.
- `src/lib/asyncHandler.ts`: promise wrapper for route handlers.

## Authentication Model

Public routes under `/api/public` and redirect `/book/:slug` do not require auth. `/internal/appointment-emails/process` uses internal secret auth. `/me` and all `/api/*` routes after the middleware gate require Supabase auth.

The service role client bypasses RLS, so code-level scoping is critical. Most service queries include `.eq("user_id", userId)` or `.eq("stylist_id", stylistId)`. Public management token loading is the main exception, but it verifies appointment `user_id`, `client_id`, and original `appointment_date` against token claims.

## Endpoint Matrix

### Health And Identity

| Method | Path | Auth | Input | Response | Database |
|---|---|---:|---|---|---|
| `GET` | `/health` | No | none | `{ "status": "ok" }` | none |
| `GET` | `/me` | Yes | bearer token | `{ auth, auth_user, profile }` | may insert `users` via `ensureAuthUser` |

### Redirects

| Method | Path | Auth | Input | Response | Database |
|---|---|---:|---|---|---|
| `GET` | `/book/:slug` | No | slug regex | `302` to `${WEB_APP_URL or CLIENT_APP_URL}/book/:slug` | none |

### Account Plan

| Method | Path | Body/Query | Response | Database fields |
|---|---|---|---|---|
| `GET` | `/api/account/plan` | none | `{ data: UserEntitlements }` | reads `users.plan_tier`, `plan_status`, `sms_monthly_limit`, `sms_used_this_month`, `waitlist_enabled` |
| `PATCH` | `/api/account/plan` | `{ tier: "basic"|"pro"|"premium", status?: "trialing"|"active"|"past_due"|"cancelled" }` | `{ data: UserEntitlements }` | updates `users.plan_tier`, `plan_status`, `sms_monthly_limit`, `plan_updated_at` |

### Clients

| Method | Path | Input | Response | Database fields |
|---|---|---|---|---|
| `GET` | `/api/clients` | none | `{ data: Client[] }` plus derived `next_appointment_at`, `has_future_appointment`, `needs_rebook`, `last_service` | reads `clients`, `appointments` |
| `POST` | `/api/clients` | `first_name`, `last_name`, optional `preferred_name`, `phone`, `email`, `instagram`, `birthday`, `preferred_contact_method`, `notes`, `tags`, `source`, `reminder_consent`, `total_spend`, `last_visit_at` | `201 { data: Client }` | inserts `clients.user_id`, sanitized name/contact/profile fields, `phone_normalized` when `phone` is supplied |
| `GET` | `/api/clients/:id` | UUID | `{ data: Client }` plus derived fields | reads one `clients` row and related `appointments` |
| `PATCH` | `/api/clients/:id` | partial create body | `{ data: Client }` | updates supplied `clients` fields; sanitizes empty strings and Instagram `@`; recalculates `phone_normalized` when phone changes |
| `DELETE` | `/api/clients/:id` | UUID | `204` | deletes `clients` row; DB cascades appointments/photos/reminders depending FK behavior |
| `GET` | `/api/clients/:id/appointments` | UUID | `{ data: Appointment[] }` | reads `appointments` for client |
| `GET` | `/api/clients/:id/photos` | UUID | `{ data: Photo[] }` | reads `photos` for client |

Client sanitization example:

```ts
if (payload.phone !== undefined) {
  sanitized.phone_normalized = normalizedPhoneValue ? normalizePhone(normalizedPhoneValue) ?? null : null;
}
```

Rebook calculation: client needs rebook when the latest non-cancelled past appointment is between 3 and 6 months old in business timezone and no non-cancelled future appointment exists.

### Appointments

| Method | Path | Input | Response | Database fields |
|---|---|---|---|---|
| `GET` | `/api/appointments/internal-context?date=YYYY-MM-DD&durationMinutes=90` | date, duration | `{ data: { date, mode: "conflict_free", respectsAvailability: false, respectsBookingRules: false, respectsOffDays: false, conflictFreeSlots, existingAppointments, blockedTimes: [] } }` | reads active `appointments`; does not read availability |
| `POST` | `/api/appointments` | `client_id`, `appointment_date`, `service_name`, `duration_minutes`, optional `price`, `notes`, `status`, `booking_source` | `201 { data: Appointment }` | inserts `appointments` with `user_id`; records `activity_events.booking_created` |
| `PATCH` | `/api/appointments/:id` | partial appointment body | `{ data: Appointment }` | updates `appointments`; may record cancel/reschedule activity; may queue cancellation email |
| `PATCH` | `/api/appointments/:id/decision` | `{ decision: "accept"|"reject" }` | `{ data: Appointment }` | pending accept updates `appointments.status="scheduled"` and queues confirmed email; reject updates `status="cancelled"` with cancellation side effects |
| `GET` | `/api/appointments/:id/activity` | UUID | `{ data: { events } }` | reads `appointments` and `activity_events` |

Appointment conflict logic:

```ts
return appointmentStart < existingEnd && appointmentEnd > existingStart;
```

Write-time conflict detection loads possible overlaps from `appointmentStart - 720 minutes` through requested end and filters in memory. It excludes cancelled appointments and optionally the appointment being updated.

Internal context calculation: loops every 15 minutes from local midnight to 24:00 and returns slots with no overlap for the requested duration. It ignores saved availability windows and booking rules by design.

### Calendar

| Method | Path | Input | Response | Database |
|---|---|---|---|---|
| `GET` | `/api/calendar`, `/api/calendar/day` | `date=YYYY-MM-DD` | `CalendarDayResponse` with appointments, available open gaps, summary metrics | reads `appointments`, previous-week appointments, `availability`, `stylist_off_days` |

Calendar calculations:

- `bookedRevenueCents` is rounded `price * 100` for statuses `scheduled`, `pending`, `completed`.
- `bookedMinutes` sums duration for those same statuses.
- `comparisonVsLastWeekPercent` is `null` if previous-week revenue is zero; otherwise rounded percent delta.
- Available slots are merged availability windows minus busy intervals, with minimum open gap `30` minutes.
- For today, open gaps start at the next 15-minute boundary after current local time.

### Dashboard

| Method | Path | Response | Database |
|---|---|---|---|
| `GET` | `/api/dashboard` | counts, reminders, today/upcoming/recent appointments, next appointment, top clients, monthly revenue | reads `clients`, `reminders`, `appointments` |

Dashboard monthly revenue sums `appointments.price` where `status="completed"` and appointment is after the start of the current business-local month.

### Activity

| Method | Path | Query | Response | Database |
|---|---|---|---|---|
| `GET` | `/api/activity`, `/api/activity/feed` | `limit`, `cursor`, `category`, `activity_type`, `start_date`, `end_date` | grouped activity feed with optional category counts and cursor | reads `activity_events`, `appointments`, `clients` |

Categories:

- `updates`: booking, cancellation, reschedule, excluding pending approval pseudo-events.
- `approvals`: pending appointments projected as activity items from `appointments`.
- `waitlist`: waitlist join events.
- `rebook`: clients whose last qualifying appointment is in the 3-to-6-month rebook window, with no non-cancelled future appointment scheduled.

Cursor is base64url JSON:

```ts
{ occurred_at: event.occurred_at, id: event.id, category }
```

Activity writes are idempotent per `stylist_id + dedupe_key`.

### Services

| Method | Path | Input | Response | Database fields |
|---|---|---|---|---|
| `GET` | `/api/services` | none | `{ data: ServiceCatalogItem[] }` | reads `services` |
| `POST` | `/api/services` | `name`, `durationMinutes`, `price`, `isActive`, optional `category`, `description`, `isDefault`, `sortOrder` | `201 { data }` | inserts `services.user_id`, `name`, `duration_minutes`, `price`, `is_active`, `category`, `description`, `is_default`, `sort_order` |
| `PATCH` | `/api/services/reorder` | `{ serviceIds: uuid[] }` | `{ data: ServiceCatalogItem[] }` | updates each listed `services.sort_order` to index + 1 |
| `PATCH` | `/api/services/:id` | partial service body | `{ data }` | updates mapped `services` fields |
| `DELETE` | `/api/services/:id` | UUID | `204` | deletes `services` row |

Service responses map DB fields to the canonical camelCase API shape:

```ts
durationMinutes: row.duration_minutes,
price: Number(row.price),
isActive: row.is_active
```

### Settings

| Method | Path | Input | Response | Database fields |
|---|---|---|---|---|
| `GET` | `/api/settings/profile` | none | `{ data: users row }` | reads/ensures `users` |
| `PATCH` | `/api/settings/profile` | optional `full_name`, `phone_number`, `business_name`, `location_label`, `avatar_image_id`, `timezone`, `waitlist_enabled` | `{ data: users row }` | updates supplied `users` columns |
| `GET` | `/api/settings/booking` | none | `{ data: stylists row }` | ensures/reads `stylists` |
| `PATCH` | `/api/settings/booking` | optional `slug`, `display_name`, `bio`, `cover_photo_url`, `instagram`, `booking_enabled`, `intelligent_scheduling_enabled` | `{ data: stylists row }` | updates/inserts `stylists`; custom cover/slug plan-gated |
| `GET` | `/api/settings/availability` | none | `{ data: { timezone, days[7] } }` | reads `availability` and `users.timezone` |
| `PUT` | `/api/settings/availability` | `{ days: [{ dayOfWeek, isOpen, windows: [{ startTime, endTime, clientAudience }] }] }` | `{ data: { timezone, days } }` | deletes all `availability` for user, inserts active rows for windows |
| `GET` | `/api/settings/booking-rules` | none | `{ data: BookingSettings }` | ensures/reads `booking_rules` |
| `PATCH` | `/api/settings/booking-rules` | partial booking rules | `{ data: BookingSettings }` | updates mapped `booking_rules` columns |

Availability validation rejects overlapping windows per day and `clientAudience`, requires open days to have windows, and closed days to have none. Replacement is not transactional: delete and insert are separate Supabase calls.

Booking rules field mapping:

- `leadTimeHours` -> `lead_time_hours`
- `sameDayBookingAllowed` -> `same_day_booking_allowed`
- `sameDayBookingCutoff` -> `same_day_booking_cutoff`
- `maxBookingWindowDays` -> `max_booking_window_days`
- `cancellationWindowHours` -> `cancellation_window_hours`
- `lateCancellationFeeEnabled` -> `late_cancellation_fee_enabled`
- `lateCancellationFeeType` -> `late_cancellation_fee_type`
- `lateCancellationFeeValue` -> `late_cancellation_fee_value`
- `allowCancellationAfterCutoff` -> `allow_cancellation_after_cutoff`
- `rescheduleWindowHours` -> `reschedule_window_hours`
- `maxReschedules` -> `max_reschedules` (`"unlimited"` and `null` stored as SQL `null`)
- `sameDayReschedulingAllowed` -> `same_day_rescheduling_allowed`
- `preserveAppointmentHistory` -> `preserve_appointment_history`
- `newClientApprovalRequired` -> `new_client_approval_required`
- `newClientBookingWindowDays` -> `new_client_booking_window_days`
- `restrictServicesForNewClients` -> `restrict_services_for_new_clients`
- `restrictedServiceIds` -> `restricted_service_ids`

### Photos

| Method | Path | Input | Response | Database fields |
|---|---|---|---|---|
| `POST` | `/api/photos` | `client_id`, `file_path`, `photo_type`, optional `caption` | `201 { data, upload }` | inserts `photos.user_id`, `client_id`, `file_path`, `photo_type`, `caption` |
| `GET` | `/api/clients/:id/photos` | client UUID | `{ data: Photo[] }` | reads `photos` |

The endpoint records metadata only. It does not upload bytes or create signed upload URLs.

### Reminders

| Method | Path | Input | Response | Database fields |
|---|---|---|---|---|
| `GET` | `/api/reminders` | none | `{ data: Reminder[] }` | reads `reminders` |
| `POST` | `/api/reminders` | `client_id`, optional `appointment_id`, `title`, `due_date`, optional `status`, `channel`, `reminder_type`, `sent_at`, `notes` | `201 { data }` | inserts `reminders` |
| `PATCH` | `/api/reminders/:id` | partial reminder body, status may include `sent` | `{ data }` | updates `reminders`; auto-sets `sent_at` when status becomes `sent`; may insert `activity_events.reminder_sent` |

### Profile Overview

| Method | Path | Query | Response | Database |
|---|---|---|---|---|
| `GET` | `/api/profile/overview` | `performancePeriod=week|month` | dashboard-style profile overview | reads `users`, `stylists`, `booking_rules`, `services`, `appointments`, `availability` |

Key calculations:

- Upcoming revenue: future `pending` and `scheduled` appointments within next 30 business-local days.
- Next week/month revenue forecasts: future `pending` and `scheduled` appointment prices before +7/+30 local days.
- Performance metrics compare current week/month to previous week/month.
- Performance revenue is booked revenue: `pending`, `scheduled`, and `completed`.
- Rebooking rate: percent of clients in the period with more than one booked appointment in that same period.
- Average ticket: period booked revenue divided by booked appointment count.

### Off Days

| Method | Path | Input | Response | Database fields |
|---|---|---|---|---|
| `GET` | `/api/off-days` | optional `startDate`, `endDate` | `{ data: OffDay[] }` | reads `stylist_off_days` |
| `POST` | `/api/off-days` | `date`, optional `label`, `reason`, `isRecurring` | `201 { data }` | inserts `stylist_off_days.user_id`, `date`, `label`, `reason`, `is_recurring` |
| `POST` | `/api/off-days/bulk` | `{ offDays: OffDayInput[] }` | `201 { data }` | inserts multiple `stylist_off_days` rows |
| `PATCH` | `/api/off-days/:id` | partial off-day body | `{ data }` | updates `date`, `label`, `reason`, `is_recurring` |
| `DELETE` | `/api/off-days/:id` | UUID | `204` | deletes row |

Off-day dates are unique per user. Availability slot generation returns no slots on off days.

### Waitlist

| Method | Path | Input | Response | Database fields |
|---|---|---|---|---|
| `GET` | `/api/waitlist` | optional `status`, `startDate`, `endDate`, `serviceId`, `limit` | `{ data, meta }` | reads `waitlist_entries`; Basic/ineligible accounts get empty data and `featureAvailable:false` |
| `GET` | `/api/waitlist/:id` | UUID | `{ data: WaitlistEntry }` | reads one `waitlist_entries` row |
| `POST` | `/api/waitlist` | `requestedDate`, optional `serviceId`, `requestedTimePreference`, `clientName`, `clientEmail`, `clientPhone`, `note` | `201 { data }` | inserts `waitlist_entries` with `source="stylist_created"` and optional matched `client_id`; records activity |
| `PATCH` | `/api/waitlist/:id` | partial waitlist fields plus optional `status` | `{ data }` | updates mapped `waitlist_entries` fields |
| `DELETE` | `/api/waitlist/:id` | UUID | `204` | deletes row |

Waitlist create/update validates plan eligibility, date not in the past in business timezone, optional service ownership, and duplicate active entries for same date + service + email/phone.

### Public Booking

| Method | Path | Input | Response | Database |
|---|---|---|---|---|
| `GET` | `/api/public/stylists/:slug` | slug | `{ data: PublicStylistProfile }` | reads `stylists`, `users`, entitlements |
| `GET` | `/api/public/services/:slug` | optional `booking_context_token` | `{ data: ServiceCatalogItem[] }` | reads active `services`; filters restricted services for new clients |
| `GET` | `/api/public/availability/:slug` | optional `booking_context_token` | `{ data: Availability[] }` | reads active `availability`; filters by `client_audience` |
| `GET` | `/api/public/availability/:slug/slots` | `service_id`, `date`, optional context token | `{ data: PublicAvailabilitySlotsResponse }` | reads stylist, service, booking rules, off days, availability, appointments |
| `POST` | `/api/public/booking-intake` | `stylist_slug`, `full_name`, `phone`, optional `email` | `{ data: PublicBookingIntakeResponse }` | reads stylist, booking rules, clients, services, appointments |
| `POST` | `/api/public/bookings` | `stylist_slug`, `service_id`, `requested_datetime`, guest name/email/phone, optional `booking_context_token`, `notes` | `201 { data: PublicBookingConfirmation }` | may insert/update `clients`; inserts `appointments`; inserts `activity_events`; queues email |
| `POST` | `/api/public/stylists/:slug/waitlist` | waitlist body | `201 { data }` | inserts `waitlist_entries`, records activity |
| `GET` | `/api/public/appointments/manage/:token` | management JWT | `{ data: PublicManagedAppointment }` | reads appointment, client, stylist, user |
| `POST` | `/api/public/appointments/manage/:token/cancel` | token | `{ data }` | updates `appointments.status="cancelled"`; records activity; queues cancelled email |
| `POST` | `/api/public/appointments/manage/:token/reschedule` | `{ requested_datetime }` | `{ data }` | updates `appointments.appointment_date` and status; records activity; queues rescheduled email |

Public booking datetime normalization intentionally treats the submitted date/time components as business-local wall time and converts them to UTC:

```ts
return zonedDateTimeToUtc(date, timeZone, hour, minute, second, millisecond).toISOString();
```

Public booking slot policy checks, in order:

1. 15-minute grid, zero seconds/milliseconds.
2. Future time.
3. Reschedule notice window when rescheduling.
4. Lead time.
5. Max booking window.
6. Same-day booking/rescheduling allowed and cutoff.
7. New-client booking window.
8. New-client service restriction.
9. Off day.
10. Fits active audience-specific availability window.
11. No appointment conflict.

Allowed status is `pending` for new clients when `newClientApprovalRequired=true`; otherwise `scheduled`. Reschedules preserve pending status if the current appointment was pending.

### Internal Appointment Email Processing

| Method | Path | Auth | Input | Response | Database fields |
|---|---|---:|---|---|---|
| `POST` | `/internal/appointment-emails/process` | `x-internal-api-secret` | query `limit`, `allow_noop` | `{ data: { processed, sent, skipped, failed } }` | reads/updates `appointment_email_events` |

Processing selects retryable `queued`, `failed`, and stale `sending` events, claims each by setting `status="sending"`, increments `attempt_count`, sets `last_attempt_at`, sends via Resend or noop, then marks `sent`, `skipped`, or `failed`.

## Database Schema

Primary authored schema is `supabase/schema.sql`; migrations evolve it.

### `users`

Fields: `id`, `email`, `full_name`, `phone_number`, `business_name`, `timezone`, `plan_tier`, `plan_status`, `sms_monthly_limit`, `sms_used_this_month`, `waitlist_enabled`, `plan_updated_at`, timestamps. It is the account/profile row and entitlement source.

### `clients`

Fields: `id`, `user_id`, `first_name`, `last_name`, `preferred_name`, `phone`, `phone_normalized`, `email`, `instagram`, `birthday`, `notes`, `preferred_contact_method`, `tags`, `source`, `reminder_consent`, `total_spend`, `last_visit_at`, timestamps.

### `appointments`

Fields: `id`, `user_id`, `client_id`, `appointment_date`, `service_name`, `duration_minutes`, `price`, `notes`, `status`, `booking_source`, timestamps. Active exact-start unique index exists on `(user_id, appointment_date) where status <> 'cancelled'`; service code also checks duration overlaps.

### `photos`

Fields: `id`, `user_id`, `client_id`, `file_path`, `photo_type`, `caption`, `created_at`.

### `reminders`

Fields: `id`, `user_id`, `client_id`, nullable `appointment_id`, `title`, `due_date`, `status`, `channel`, `reminder_type`, `sent_at`, `notes`, timestamps.

### `activity_events`

Fields: `id`, `stylist_id`, nullable `client_id`, nullable `appointment_id`, `activity_type`, `title`, `description`, `occurred_at`, `metadata`, `dedupe_key`, `created_at`. Unique index on `(stylist_id, dedupe_key)`.

### `appointment_email_events`

Fields: `id`, `stylist_id`, `client_id`, `appointment_id`, `email_type`, `recipient_email`, `status`, `idempotency_key`, `provider`, `provider_message_id`, `template_data`, `error`, `attempt_count`, `last_attempt_at`, `sent_at`, timestamps. Unique index on `idempotency_key`.

### `stylists`

Fields: `id`, `user_id`, `slug`, `display_name`, `bio`, `cover_photo_url`, `instagram`, `booking_enabled`, `intelligent_scheduling_enabled`, timestamps.

### `booking_rules`

Fields mirror the booking-rules mapping above. One row per `user_id`.

### `services`

Fields: `id`, `user_id`, `name`, `description`, `category`, `duration_minutes`, `price`, `is_active`, `is_default`, `sort_order`, timestamps.

### `availability`

Fields: `id`, `user_id`, `day_of_week`, `start_time`, `end_time`, `client_audience`, `is_active`, timestamps.

### `stylist_off_days`

Fields: `id`, `user_id`, `date`, `label`, `reason`, `is_recurring`, timestamps. Unique per `(user_id, date)`.

### `waitlist_entries`

Fields: `id`, `user_id`, nullable `client_id`, nullable `service_id`, `requested_date`, `requested_time_preference`, `client_name`, `client_email`, `client_phone`, `note`, `status`, `source`, timestamps.

## Core Calculations And Derived Values

### Appointment End

Every appointment end is `new Date(start).getTime() + duration_minutes * 60_000`.

### Appointment Overlap

Two appointments overlap when both parsed times are finite and `startA < endB && endA > startB`. Back-to-back appointments are allowed.

### Public Availability Slots

For every active availability window on the requested day, the backend steps by 15 minutes. A candidate is kept only if its service duration fits inside the window and `schedulingPolicyService.evaluateRequestedSlot()` passes. Duplicate UTC starts are suppressed. Output is then optionally ranked by Intelligent Scheduling.

### Intelligent Scheduling

If disabled, or valid slot count is <= 5, all slots return chronologically. If enabled and more than 5 valid slots exist, slots are scored by adjacency to busy blocks, hour/half-hour starts, awkward gaps under 60 minutes, long-service preferences, and chronological nudges. Top 5 become `slots`; remaining valid slots become `moreSlots`.

### Booking Intake Recommended Service

For a matched existing client:

1. Prefer active service matching the most recent completed appointment service name.
2. Else prefer active service matching most recent non-cancelled booked appointment.
3. Else prefer first active service with `is_default=true`.
4. Else `null`.

### Activity Feed Grouping

Events are grouped by business-local date of `occurred_at`. Each group contains summary counts by event type. Category counts are computed before pagination.

### Email Idempotency

Email idempotency key is `${emailType}:${appointmentId}`, except reschedules include appointment start time: `${emailType}:${appointmentId}:${appointmentStartTime}`. This allows multiple reschedule emails for different start times.

## File Inventory

### Routes

- `src/routes/index.ts`: top-level mount order and auth gates.
- `accountRoutes.ts`, `activityRoutes.ts`, `appointmentRoutes.ts`, `authRoutes.ts`, `calendarRoutes.ts`, `clientRoutes.ts`, `dashboardRoutes.ts`, `healthRoutes.ts`, `internalRoutes.ts`, `offDayRoutes.ts`, `photoRoutes.ts`, `profileRoutes.ts`, `publicRoutes.ts`, `reminderRoutes.ts`, `serviceRoutes.ts`, `settingsRoutes.ts`, `waitlistRoutes.ts`: route-to-controller bindings with Zod validators.

### Controllers

Controllers are thin delegators. They call `getAuthUserId()` or `getCurrentUser()`, read validated params/body/query, call services, and shape `{ data: ... }` responses. Notable exceptions: `calendarController.getDay()` returns the day object directly, not wrapped in `{ data }`; `authController.getMe()` returns `{ auth, auth_user, profile }`.

### Services

- `appointmentsService.ts`: appointment CRUD, overlap validation, internal slot context, pending decision workflow, activity/email side effects.
- `availabilityService.ts`: weekly availability read/replace, public availability filtering, public slot generation.
- `schedulingPolicyService.ts`: booking/reschedule rule engine.
- `publicBookingsService.ts`: public booking orchestration and race/idempotency handling.
- `publicBookingIntakeService.ts`: contact lookup, existing-client JWT context, recommended service.
- `publicAppointmentManagementService.ts`: token-managed public cancel/reschedule.
- `clientsService.ts`: client CRUD, booking client matching, derived rebook/list metadata.
- `servicesService.ts`: service catalog CRUD/reorder and public filtering.
- `stylistsService.ts`: public profile, default stylist creation, slug generation, booking settings, plan feature checks.
- `bookingRulesService.ts`: ensure/default booking rules, API-to-DB mapping, restricted service validation.
- `waitlistService.ts`: plan-gated waitlist CRUD, duplicate prevention, activity recording.
- `offDaysService.ts`: off-day CRUD and date checks.
- `calendarService.ts`: day view, open gap, summary metrics.
- `dashboardService.ts`: dashboard aggregate reads.
- `profileOverviewService.ts`: profile overview metrics and summaries.
- `activityEventsService.ts`: activity read models, grouping/cursors, idempotent event recording.
- `appointmentEmailEventsService.ts`: queue appointment email events and template data.
- `appointmentEmailDeliveryService.ts`: render/send/claim/retry queued email events.
- `remindersService.ts`: reminder CRUD and sent activity side effect.
- `photosService.ts`: photo metadata CRUD.
- `usersService.ts`: user bootstrap/update.
- `entitlementsService.ts`: plan feature/limit calculations.
- `businessTimeZoneService.ts`: resolve user timezone.
- `intelligentSchedulingService.ts`: slot ranking.
- `rebookService.ts`: 3-to-6-month rebook heuristic.
- `db.ts`: generic row types, Supabase error wrapping, missing-column helpers.

### Validators

All validator files map public API contracts to Zod schemas. Important normalization happens in validators for waitlist email/phone nullability, optional empty email strings, off-day nullable text, and boolean/internal query coercion.

### Tests

Tests cover API routing/auth, activity, appointment email delivery, appointment overlap, client actions, intelligent scheduling, off days, profile/dashboard, public appointment management, and public availability. They rely on `src/__tests__/helpers/mockSupabase.ts`.

## Tech Debt, Risks, And Specific Concerns

1. **Service role bypasses RLS.** This is common for backend APIs, but every query must keep correct `user_id`/`stylist_id` scoping. A missed filter would become a cross-tenant data leak.

2. **Availability replacement is not atomic.** `replaceWeeklyForUser()` deletes all rows then inserts new rows. If insert fails, the user has no availability. This should ideally be an RPC transaction.

3. **Service reorder ignores update errors.** `servicesService.reorder()` fires `Promise.all` update builders but does not inspect each `{ error }`. Failed updates can be silently missed.

4. **Some DB `updated_at` fields are not automatically maintained in code.** Many updates do not explicitly set `updated_at`; unless database triggers exist outside this repo, rows can retain stale `updated_at`.

5. **Appointment overlap is code-level plus exact-start DB index.** The schema contains exact-start uniqueness but not a real exclusion constraint for interval overlap. Concurrent writes can race between read-time conflict check and insert unless the database has the `appointments_user_active_time_no_overlap` exclusion constraint elsewhere.

6. **Public booking dedupe is partial.** It handles exact matching public booking conflicts for matched/latest clients, but client creation and appointment creation are not one transaction. Duplicate clients can still be created under concurrent submissions.

7. **`clientsService.findBookingMatches()` only matches by phone.** It accepts email but currently normalizes and queries phone/phone_normalized only. Existing clients with matching email but no phone match will not be found.

8. **Schema drift now fails clearly.** The backend has removed prototype-era compatibility shims for required client, entitlement, and dashboard columns. Startup and `GET /health` verify the required `users` and `clients` columns so stale environments fail before silently returning reduced behavior.

9. **`calendarController.getDay()` response shape differs from most controllers.** Most endpoints wrap responses in `{ data }`; calendar returns the object directly. This is documented in frontend contracts but remains an API consistency risk.

10. **Internal context ignores availability and booking rules.** This is intentional in comments/README, but product surfaces must not present it as public bookable availability.

11. **Plan update endpoint is authenticated but not billing-protected.** Any authenticated user can call `PATCH /api/account/plan` to change tier/status. This is probably an MVP/admin/testing shortcut and should not exist as-is in production billing.

12. **Email processing claim is status-compare only.** It reduces duplicate workers but does not use row locks. Two workers reading the same queued batch can race; the `.eq("status", currentStatus)` claim usually makes one win, but there is no worker identifier or stronger DB lock.

13. **No delete endpoint for reminders/photos.** Existing CRUD is asymmetrical; clients and services can delete, reminders/photos cannot.

14. **Waitlist duplicate checking is application-side.** There is no DB unique index for active duplicates, so concurrent duplicate submissions can race.

15. **Public appointment management tokens expire at appointment start and bind to original start time.** This is good for safety, but any reschedule makes old links invalid because `appointment_date` no longer matches token claims.

16. **`maxReschedules` is stored but not enforced.** Booking rules include max reschedules, but `schedulingPolicyService` does not count or enforce historical reschedules.

17. **Cancellation window and late-cancellation fee are stored but not enforced.** Public management cancellation currently allows any pending/scheduled future appointment to be cancelled, regardless of cancellation rules.

18. **`preserveAppointmentHistory` is stored but not used.** Rejected pending appointments are cancelled; no alternate behavior exists.

19. **Location/avatar fields used by profile may not exist in base schema.** `usersService.updateProfile()` accepts `location_label` and `avatar_image_id`, and profile overview reads them, but they are not present in `supabase/schema.sql` shown here.

20. **Database schema and migrations differ in references.** Base schema `waitlist_entries.user_id` references `auth.users(id)`, while most app services treat it as the stylist user. It works when `public.users.id` mirrors `auth.users.id`, but consistency would be cleaner with `public.users(id)`.

21. **Validation error details are wrapped as `ApiError`.** Because `validate()` catches all Zod errors and wraps them, clients receive raw Zod error object in `details` outside production, not the cleaner `flatten()` branch.

22. **Potential CORS looseness in unconfigured env.** If no allowed origins are configured, CORS allows any origin. Useful locally, risky if production env variables are missing.

23. **Public booking uses wall-clock components from offset datetime.** This is deliberate but can surprise clients: an input with a different offset is interpreted as business-local date/time rather than the instant represented by the offset.

24. **SMS entitlements are implemented but SMS sending is not.** `assertSmsAvailable()` and usage stubs exist, but no SMS delivery service is present.

25. **Photos are metadata only.** The API response says Supabase storage is expected, but no storage upload/signing integration exists in backend code.

## Recommended Follow-Up Work

1. Move availability replacement, public booking client+appointment creation, and waitlist duplicate prevention into Postgres RPC transactions.
2. Add a real database exclusion constraint for active appointment time ranges or equivalent transactional locking.
3. Remove or gate `PATCH /api/account/plan` behind trusted admin/internal auth before production billing.
4. Enforce stored cancellation/reschedule rules: cancellation cutoff, max reschedules, late fee metadata.
5. Add missing migrations for `users.location_label` and `users.avatar_image_id` if those fields are intended.
6. Decide whether client matching should include email and implement it explicitly.
7. Normalize response shape or document exceptions in OpenAPI-style contract.
8. Keep all deploy targets migrated through the required schema version before routing traffic.
9. Add delete endpoints or intentional docs for reminders/photos.
10. Add a generated OpenAPI spec from Zod schemas or route metadata to reduce drift.
