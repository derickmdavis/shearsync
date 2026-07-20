# ShearSync API

ShearSync API is the initial MVP backend for a mobile-first CRM for hair stylists. It is one Node.js, TypeScript, and Express API intended for Railway, with Supabase handling Auth, Postgres, and Storage.

Payments, background jobs, team roles, and a second API are intentionally not included. Appointment email delivery, communication preferences, unsubscribe links, and SMS consent/STOP handling are backend-supported.

## Stack

- Node.js 20+
- TypeScript
- Express
- Supabase Auth, Postgres, and Storage
- Zod
- Railway / Nixpacks

## Install

```bash
npm install
cp .env.example .env
npm run dev
```

The API starts on `PORT`, defaulting to `3000`.

## Environment Variables

```bash
PORT=3000
NODE_ENV=development
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-supabase-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key
CLIENT_APP_URL=http://localhost:8081
WEB_APP_URL=http://localhost:3001
INTERNAL_API_SECRET=your-long-random-internal-secret
RESEND_API_KEY=your-resend-api-key
EMAIL_FROM="DripDesk <appointments@your-verified-domain.com>"
EMAIL_REPLY_TO=support@your-verified-domain.com
```

`SUPABASE_SERVICE_ROLE_KEY` is used only on the backend. Do not expose it to the mobile app, web app, public pages, or browser runtime.

## Scripts

```bash
npm run dev
npm run typecheck
npm run build
npm run start
```

Railway uses `npm run build` and `npm run start` from `railway.json`.

## Supabase Setup

1. Create a Supabase project.
2. Create the tables in `supabase/schema.sql`.
3. Apply all checked-in migrations before starting the API.
4. Enable Supabase Auth.
5. Add the environment variables to `.env` locally and to Railway in production.
6. Create a private Storage bucket for client photos when upload work begins.

The API validates bearer tokens through Supabase Auth using the configured `SUPABASE_URL` and `SUPABASE_ANON_KEY`. Authenticated business data is also scoped by `user_id` in every service query.

The API requires the production schema through `202606160001_client_soft_delete_retention` plus the communication preference tables represented in `supabase/schema.sql`. Startup and `GET /health` fail clearly if required `users` or `clients` columns are missing.

## Routes

Health and identity:

- `GET /health`
- `GET /me`

Authenticated routes:

- `GET /api/clients`
- `POST /api/clients`
- `GET /api/clients/:id`
- `PATCH /api/clients/:id`
- `DELETE /api/clients/:id`
- `GET /api/clients/:id/referral-link`
- `POST /api/clients/:id/referral-link`
- `GET /api/clients/:id/referral-stats`
- `GET /api/clients/:id/appointments`
- `POST /api/appointments`
- `GET /api/appointments/internal-context?date=YYYY-MM-DD&durationMinutes=90`
- `GET /api/appointments/:id`
- `GET /api/appointments/:id/activity`
- `PATCH /api/appointments/:id`
- `GET /api/clients/:id/visual-history`
- `GET /api/clients/:id/photos`
- `POST /api/photos`
- `GET /api/activity`
- `GET /api/activity/referrals`
- `GET /api/activity/cancellations`
- `GET /api/reminders`
- `POST /api/reminders`
- `PATCH /api/reminders/:id`
- `GET /api/dashboard`
- `GET /api/insights?business_snapshot_period=week|month&referral_period=this_month|all_time`
- `GET /api/calendar?date=YYYY-MM-DD`
- `GET /api/settings/profile`
- `PATCH /api/settings/profile`
- `GET /api/settings/booking`
- `PATCH /api/settings/booking`
- `GET /api/settings/availability`
- `PUT /api/settings/availability`
- `GET /api/settings/booking-rules`
- `PATCH /api/settings/booking-rules`
- `GET /api/settings/email-templates`
- `PATCH /api/settings/email-templates/:emailType`
- `DELETE /api/settings/email-templates/:emailType`
- `POST /api/settings/email-templates/:emailType/preview`
- `GET /api/settings/rebook-nudges`
- `PATCH /api/settings/rebook-nudges`
- `POST /api/settings/rebook-nudges/preview`
- `GET /api/settings/birthday-reminders`
- `PATCH /api/settings/birthday-reminders`
- `POST /api/birthday-reminders/:id/approve`
- `POST /api/birthday-reminders/:id/cancel`
- `GET /api/rebook-nudges`
- `POST /api/rebook-nudges`
- `POST /api/rebook-nudges/:id/approve`
- `POST /api/rebook-nudges/:id/cancel`
- `GET /api/settings/thank-you-emails`
- `PATCH /api/settings/thank-you-emails`
- `POST /api/settings/thank-you-emails/preview`
- `GET /api/thank-you-emails`
- `POST /api/thank-you-emails`
- `POST /api/thank-you-emails/:id/approve`
- `POST /api/thank-you-emails/:id/cancel`

Client contract notes:

- `GET /api/settings/booking` and `PATCH /api/settings/booking` include the stylist's business booking settings. The booking settings payload accepts optional `instagram`; the backend stores the handle without leading `@`.
- Email template settings support custom subject lines and one custom plain-text message block for `appointment_scheduled`, `appointment_pending`, `appointment_confirmed`, `appointment_cancelled`, `appointment_rescheduled`, `appointment_reminder`, `rebooking_prompt`, `birthday_reminder`, and `thank_you_email`. The custom block is inserted after the standard intro and before email details; the rest of the email remains system-controlled. Legacy `/api/settings/email-confirmations` routes remain available as aliases.
- Rebook nudge settings are separate from email templates for approval-required mode and default rebook interval. Approval-required nudges are persisted as `pending_approval` until individually approved or cancelled.
- Birthday reminder settings are separate from email templates for approval-required mode. Turning review on moves future unsent queued birthday reminders into Needs Attention; turning review off moves pending review birthday reminders into Scheduled Outreach.
- Thank-you email settings are separate from email templates for approval-required mode, send delay, referral URL/code snapshots, and inline QR generation.
- For rebook nudges and thank-you emails, turning review on moves unsent automatic queued rows to pending review; turning review off moves pending review rows to queued/scheduled outreach. Sending, sent, cancelled, skipped, and superseded rows are not moved back and forth.
- `GET /api/clients` supports backend search, pagination, sorting, and supported filters. It returns persisted client fields plus list-safe summary metadata including `next_appointment_at`, `has_future_appointment`, `needs_rebook`, and `last_service`. See `docs/frontend-clients-list-contract.md`.
- `needs_rebook` on `GET /api/clients` uses the same backend-calculated rebook rule as the `rebook` category in `GET /api/activity`.
- `POST /api/clients` and `PATCH /api/clients/:id` accept optional nullable client profile fields such as `preferred_name`, `instagram`, `birthday` (`DD/MM`), `preferred_contact_method`, `tags`, `source`, `reminder_consent`, `total_spend`, and `last_visit_at` in addition to the original client fields.

Appointment contract notes:

- Authenticated `POST /api/appointments` defaults `booking_source` to `internal`, ignores public booking rules, and only enforces ownership plus overlap protection.
- Public booking creation stores `booking_source: "public"`.
- Appointments can store nullable `service_id` for structured reporting/automation while keeping `service_name`, `duration_minutes`, and `price` as historical snapshots.
- Appointment creates and timing updates maintain `appointment_time_range` from `appointment_date` and `duration_minutes`; current conflict checks still use the existing application overlap logic.
- Public booking `notes` are stored on the appointment only; they are not copied into client/customer notes.
- `GET /api/appointments/internal-context` returns `conflictFreeSlots` for a given date and duration. These are overlap-safe internal suggestions only; the response explicitly does not apply saved availability windows, public booking rules, or off-day checks.
- `GET /api/appointments/:id` returns one authenticated stylist-owned appointment by appointment ID, with frontend-friendly detail aliases including `client_name`, `client_phone`, `client_email`, `client_preferred_contact_method`, `client_contact`, `start_time`, `end_time`, `services`, and `revenue` when derivable. `client_contact` uses the linked client's phone first, then email, and is `null` when no contact is available.
- `GET /api/appointments/:id/activity` returns activity events for a single appointment in reverse chronological order for appointment detail/history UI.

Business metric contract notes:

- Shared metric semantics are documented in [docs/frontend-business-metrics-contract.md](docs/frontend-business-metrics-contract.md).
- Booked revenue/minutes include `pending`, `scheduled`, and `completed`; earned/completed revenue includes `completed` only; upcoming revenue includes future `pending` and `scheduled`.
- `cancelled` and `no_show` appointments do not count toward booked revenue, earned revenue, upcoming revenue, booked minutes, busy time, or booked average ticket.

## Activity Feed

The mobile Activity screen is a business timeline, not a chat inbox.

- `GET /api/activity` and `GET /api/activity/feed` return recent operational events grouped by business-local day.
- `GET /api/appointments/:id/activity` returns appointment-specific activity in reverse chronological order for detail/history UI.
- The response is ordered most recent first and includes per-day summary counts for `new_bookings`, `cancellations`, `reschedules`, `reminders_sent`, `waitlist_joins`, and `rebook_needed`.
- Supported MVP event types are `booking_created`, `appointment_cancelled`, `appointment_rescheduled`, `reminder_sent`, `waitlist_joined`, and the derived `client_rebook_needed`.
- Query params: `limit`, `cursor`, `category`, `activity_type`, `start_date`, `end_date`.
- `GET /api/activity/cancellations?window_hours=24` returns a flat recent-cancellations list for the cancellation screen. Each item includes `appointment_id`, `client_id`, `client_name`, `appointment_start_time`, `service_names`, `cancelled_at`, and `cancelled_by`.
- Category feeds support `updates`, `approvals`, `waitlist`, and `rebook`, echo the selected `category`, and include total `counts` for all categories before pagination.
- Pagination is cursor-based and paginates by event, not by day-group count.

Activity events are created automatically by backend mutations:

- Creating an appointment inserts `booking_created`.
- Updating an appointment to `status: "cancelled"` inserts `appointment_cancelled`.
- Changing an appointment's scheduled time inserts `appointment_rescheduled`.
- Updating a reminder to `status: "sent"` inserts `reminder_sent`.
- Creating a waitlist entry inserts `waitlist_joined`.

Reminder notes for Activity support:

- Reminders now support optional `appointment_id`, `channel`, `reminder_type`, and `sent_at`.
- Reminder `status` now supports `sent` in addition to `open`, `done`, and `dismissed`.
- Duplicate `reminder_sent` events are suppressed with an internal dedupe key so retries do not spam the feed.

Feed copy is generated server-side so the mobile app can render the timeline directly without building its own message strings from raw metadata.

Activity metadata is also normalized server-side so the mobile app can inspect typed event details without reconstructing them:

- `booking_created`: `client_name`, `service_name`, `appointment_start_time`
- `appointment_cancelled`: `client_name`, `service_name`, `appointment_start_time`, `cancelled_by`
- `appointment_rescheduled`: `client_name`, `service_name`, `old_start_time`, `new_start_time`
- `reminder_sent`: `client_name`, `channel`, `reminder_type`, `appointment_start_time`
- `waitlist_joined`: `client_name`, `service_name`, `requested_date`, `requested_time_preference`, `source`

Public booking routes:

- `GET /book/:slug` redirects to the public booking web app and is the canonical browser URL.
- `GET /api/public/stylists/:slug`
- `GET /api/public/services/:slug?booking_context_token=...`
- `GET /api/public/availability/:slug?booking_context_token=...`
- `GET /api/public/availability/:slug/slots?service_id=...&date=YYYY-MM-DD&booking_context_token=...`
- `GET /api/public/referrals/:referralCode`
- `POST /api/public/stylists/:slug/waitlist`
- `POST /api/public/booking-intake`
- `POST /api/public/bookings`

Public communication routes:

- `GET /api/communications/unsubscribe/:token`
- `POST /api/communications/sms/inbound`

## Public Booking Flow

Recommended public flow:

1. `GET /api/public/stylists/:slug` and read `booking_enabled`, `features.waitlistEnabled`, and `features.appointmentPhotos`.
2. If `booking_enabled` is `false`, stop the booking flow and show an "online booking unavailable" state.
3. `POST /api/public/booking-intake` with guest contact details.
4. Read `isExistingClient`, `bookingContextToken`, and `bookingEnabled` from the response.
5. If `bookingEnabled` is `false`, stop the booking flow and show an "online booking unavailable" state.
6. Pass `booking_context_token` into `GET /api/public/services/:slug` so the backend can filter service visibility using returning-client vs new-client rules.
7. If the UI needs raw weekly windows, pass the same `booking_context_token` into `GET /api/public/availability/:slug` so audience-specific windows are filtered the same way.
8. Pass the same `booking_context_token` into `GET /api/public/availability/:slug/slots` so slot generation uses the same client-specific rules and client-specific availability windows.
   - When Intelligent Scheduling is enabled, this endpoint returns up to 5 ranked initial `slots`, the remaining valid `moreSlots`, `hasMore`, and `intelligentSchedulingEnabled`.
   - Intelligent Scheduling is display ranking only. The backend still returns every technically valid slot across `slots` and `moreSlots`.
9. If the visitor entered through `GET /api/public/referrals/:referralCode` or a `/r/:referralCode` frontend route, carry the referral code through the flow.
10. Submit the final booking through `POST /api/public/bookings`, including optional `referral_code` when present.
11. If the selected day has no useful slots and `features.waitlistEnabled=true`, the client may submit `POST /api/public/stylists/:slug/waitlist`.

`POST /api/public/bookings` still re-checks the real client match and booking rules server-side:

1. Finds the stylist by `stylist_slug`.
2. Confirms online booking is enabled.
3. Confirms the service is active for that stylist.
4. Checks that the requested datetime falls inside an active availability window.
5. Matches an existing client by phone, then email, or creates a new client.
6. If `referral_code` is valid for this stylist and is not a self-referral, stores referral attribution on the appointment and on a newly created client.
7. Creates a scheduled or pending appointment, depending on booking rules.
8. Returns a confirmation payload.

## Referrals

Authenticated client referral endpoints:

- `GET /api/clients/:id/referral-link` returns the active referral link for a stylist-owned client, or `null`.
- `POST /api/clients/:id/referral-link` creates or returns the active referral link for a stylist-owned client.
- `GET /api/clients/:id/referral-stats` returns lightweight counts for referral link opens and attributed bookings.
- `GET /api/activity/referrals?range=this_month` returns account-level referral activity stats for the Activity surface.

Public referral endpoint:

- `GET /api/public/referrals/:referralCode` validates an active referral code and returns the stylist booking URL plus an expiry timestamp for frontend handoff.

Final public bookings accept optional `referral_code`. Invalid, wrong-stylist, or self-referral codes do not block booking; they simply do not write attribution. Valid referral bookings write referral fields on the appointment, and new referred clients get original referral source fields.

Frontend handoff details are documented in [docs/frontend-referrals-ui-codex-handoff.md](docs/frontend-referrals-ui-codex-handoff.md), [docs/frontend-referrals-contract.md](docs/frontend-referrals-contract.md), and [docs/frontend-activity-referrals-contract.md](docs/frontend-activity-referrals-contract.md).

Authenticated Pro and Premium stylists can enable thank-you emails that include the client's referral link and an inline QR code after completed appointments. The authenticated API surface is:

- `GET /api/settings/thank-you-emails`
- `PATCH /api/settings/thank-you-emails`
- `POST /api/settings/thank-you-emails/preview`
- `GET /api/thank-you-emails`
- `POST /api/thank-you-emails`
- `POST /api/thank-you-emails/:id/approve`
- `POST /api/thank-you-emails/:id/cancel`

Thank-you email automation details are documented in [docs/frontend-thank-you-emails-contract.md](docs/frontend-thank-you-emails-contract.md).

The public read endpoints also enforce booking availability now:

- `GET /api/public/services/:slug` returns `400` when `booking_enabled=false`.
- `GET /api/public/availability/:slug` returns `400` when `booking_enabled=false`.
- `GET /api/public/availability/:slug/slots` returns `400` when `booking_enabled=false`.

This is intentionally MVP-safe. There is no calendar sync, payment collection, automatic waitlist booking, or advanced collision logic beyond rejecting an exact appointment datetime conflict.

## Waitlist

Waitlist is a plan-gated backend feature for public booking pages with a stylist-controlled on/off setting. Basic stylists cannot use it; Pro and Premium stylists can use it when their plan is not cancelled and `public.users.waitlist_enabled=true`. No Stripe or real subscription lifecycle logic is added.

Database support:

- `public.users.waitlist_enabled` stores the stylist's waitlist toggle. It defaults to `true`.
- `public.waitlist_entries` stores one requested date/service/contact row per waitlist request.
- `user_id` is the stylist/account owner.
- `client_id` and `service_id` are nullable.
- Status values are `active`, `contacted`, `booked`, `cancelled`, and `expired`.
- Source values are `public_booking`, `stylist_created`, and `manual`.
- RLS policies scope authenticated direct table access to `auth.uid() = user_id`.

Public metadata:

```json
{
  "data": {
    "slug": "maya-johnson",
    "booking_enabled": true,
    "features": {
      "waitlistEnabled": true,
      "appointmentPhotos": true
    }
  }
}
```

Public create:

`POST /api/public/stylists/:slug/waitlist`

```json
{
  "requestedDate": "2026-06-15",
  "serviceId": "33333333-3333-4333-8333-333333333333",
  "requestedTimePreference": "Morning preferred",
  "clientName": "Ava Martinez",
  "clientEmail": "ava@example.com",
  "clientPhone": "(555) 555-1212",
  "note": "I can come in anytime after 10am."
}
```

The backend validates the stylist slug, plan eligibility, requested date in the stylist business timezone, optional service ownership, and at least one email or phone contact. Public callers cannot list waitlist entries.

Authenticated stylist endpoints:

- `GET /api/waitlist?status=active&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&serviceId=uuid&limit=50`
- `GET /api/waitlist/:id`
- `POST /api/waitlist`
- `PATCH /api/waitlist/:id`
- `DELETE /api/waitlist/:id`

`GET /api/waitlist` returns an empty list with `meta.featureAvailable=false` for Basic accounts. Mutating waitlist routes return `403` for ineligible plans. Cross-stylist access returns `404`.

Stylist settings toggle:

- Read current value with `GET /api/settings/profile` and `data.waitlist_enabled`.
- Update with `PATCH /api/settings/profile` and body `{ "waitlist_enabled": false }` or `{ "waitlist_enabled": true }`.
- The account plan endpoint also returns:
  - `data.features.waitlist`: tier eligibility
  - `data.features.appointmentPhotos`: tier eligibility for appointment photos, before/after photos, and public reference photo upload
  - `data.settings.waitlistEnabled`: stored stylist toggle
  - `data.effectiveFeatures.waitlistEnabled`: eligible, not cancelled, and toggled on

Public booking integration:

- Read `GET /api/public/stylists/:slug`.
- Show public waitlist UI only when `data.booking_enabled === true` and `data.features.waitlistEnabled === true`.
- Submit public waitlist requests to `POST /api/public/stylists/:slug/waitlist`.
- Do not insert directly into Supabase from the public frontend; anonymous browser inserts fail RLS by design.

Current limitations:

- No automatic cancellation matching.
- No automatic booking from the waitlist.
- Appointment emails are implemented through the queued email processor; reminder delivery and outbound SMS delivery are not yet implemented.
- Email template customizations are snapshotted when an email/nudge/reminder record is queued, so edits apply to future queued emails and do not rewrite already queued messages.
- Rebook nudges use `/internal/rebook-nudges/queue` to create due nudge records, `/internal/rebook-nudges/process` to enqueue approved/automatic rebook emails, and `/internal/appointment-emails/process` to deliver the resulting email events.
- Thank-you emails use `/internal/thank-you-emails/queue` to create completed-appointment records, `/internal/thank-you-emails/process` to enqueue approved/automatic thank-you email events, and `/internal/appointment-emails/process` to deliver the resulting email events.
- SMS preference/consent checks and STOP/START/HELP inbound handling exist for future SMS provider integration.
- No Stripe enforcement beyond the existing mocked/backend plan fields.
- No automated expiration or cleanup.

## Availability Settings

The authenticated availability settings API is the source of truth for a stylist's open booking hours.

- `GET /api/settings/availability` returns a normalized 7-day weekly schedule plus the business timezone.
- `PUT /api/settings/availability` replaces the full weekly schedule in one request.
- Each saved availability window now includes a `clientAudience` of `all`, `new`, or `returning`.
- `GET /api/public/availability/:slug/slots` uses these stored hours, plus booking rules, booking context, and existing appointments, to generate bookable public slots.

See [docs/frontend-availability-integration.md](docs/frontend-availability-integration.md) for the full frontend contract and UI integration notes.
See [docs/frontend-public-booking-client-context-handoff.md](docs/frontend-public-booking-client-context-handoff.md) for the intake token flow the web booking app should use for client-aware services and slots.

See [docs/tiers-overview.md](docs/tiers-overview.md) for the full plan/tier entitlement contract.

## Photo Upload Placeholder

`GET /api/clients/:id/visual-history` returns production appointment image history for the Client Detail screen. Results are backed by `appointment_images`, include appointment context, and include short-lived signed `thumbnail_url` and `display_url` fields for private Storage objects.

`POST /api/photos` records photo metadata:

```json
{
  "client_id": "uuid",
  "file_path": "client-photos/user-id/client-id/photo.jpg",
  "photo_type": "before",
  "caption": "Before color correction"
}
```

The actual file upload should be wired to Supabase Storage once bucket names, signed upload behavior, and client upload UX are finalized.

## Deploy to Railway

1. Push this repo to GitHub.
2. Create a Railway project from the repo.
3. Add the Supabase environment variables.
4. Deploy.
5. Check `GET /health`. A non-200 response means the API or required database schema is not ready.

Railway will run the build and start commands from `railway.json`.

## Implemented

- Express app with security middleware, request logging, CORS, JSON parsing, health check, and centralized errors.
- Supabase clients for service-role and anon usage.
- Supabase JWT auth middleware.
- Zod validation for all create/update endpoints.
- Authenticated CRM route scaffolding for clients, appointments, photos, reminders, dashboard, and settings.
- Public booking route scaffolding for stylist pages, services, availability, and booking creation.
- Database-facing service layers with `user_id` ownership checks.
- Supabase schema starter matching the MVP handoff tables.

## Placeholder / Next Setup

- Supabase project credentials are required before the API can run against real data.
- Database migrations need to be applied in Supabase.
- RLS policies should be added before production traffic. The API already scopes by `user_id`, but database policies are still recommended.
- User profile creation after Supabase signup needs a trigger or app-side onboarding call.
- Photo upload currently stores metadata only. Storage bucket policy and signed upload flow are not wired yet.
- Appointment-related day logic uses the business timezone stored on `users.timezone`. Availability uses `day_of_week` as `0` for Sunday through `6` for Saturday in that timezone.
