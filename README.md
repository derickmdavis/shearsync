# ShearSync API

ShearSync API is the initial MVP backend for a mobile-first CRM for hair stylists. It is one Node.js, TypeScript, and Express API intended for Railway, with Supabase handling Auth, Postgres, and Storage.

Messaging, formulas, payments, background jobs, team roles, and a second API are intentionally not included.

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
3. Enable Supabase Auth.
4. Add the environment variables to `.env` locally and to Railway in production.
5. Create a private Storage bucket for client photos when upload work begins.

The API validates bearer tokens through Supabase Auth using the configured `SUPABASE_URL` and `SUPABASE_ANON_KEY`. Authenticated business data is also scoped by `user_id` in every service query.

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
- `GET /api/clients/:id/appointments`
- `POST /api/appointments`
- `GET /api/appointments/internal-context?date=YYYY-MM-DD&durationMinutes=90`
- `GET /api/appointments/:id/activity`
- `PATCH /api/appointments/:id`
- `GET /api/clients/:id/photos`
- `POST /api/photos`
- `GET /api/activity`
- `GET /api/reminders`
- `POST /api/reminders`
- `PATCH /api/reminders/:id`
- `GET /api/dashboard`
- `GET /api/client-actions`
- `GET /api/calendar?date=YYYY-MM-DD`
- `GET /api/settings/profile`
- `PATCH /api/settings/profile`
- `GET /api/settings/booking`
- `PATCH /api/settings/booking`
- `GET /api/settings/availability`
- `PUT /api/settings/availability`
- `GET /api/settings/booking-rules`
- `PATCH /api/settings/booking-rules`

Client contract notes:

- `GET /api/clients` returns persisted client fields plus list-safe summary metadata including `next_appointment_at`, `has_future_appointment`, `needs_rebook`, and `last_service`.
- `needs_rebook` on `GET /api/clients` uses the same backend-calculated rebook rule as `clients_requiring_rebook` in `GET /api/client-actions`.
- `POST /api/clients` and `PATCH /api/clients/:id` accept optional nullable client profile fields such as `preferred_name`, `instagram`, `preferred_contact_method`, `tags`, `source`, `reminder_consent`, `total_spend`, and `last_visit_at` in addition to the original client fields.

Appointment contract notes:

- Authenticated `POST /api/appointments` defaults `booking_source` to `internal`, ignores public booking rules, and only enforces ownership plus overlap protection.
- Public booking creation stores `booking_source: "public"`.
- `GET /api/appointments/internal-context` returns overlap-safe internal slot suggestions for a given date and duration without applying public booking rules or saved availability windows.
- `GET /api/appointments/:id/activity` returns activity events for a single appointment in reverse chronological order for appointment detail/history UI.

Client actions contract notes:

- `GET /api/client-actions` returns a typed `items` array for dashboard/action-center UI surfaces.
- Current item types are `pending_appointment_approvals` and `clients_requiring_rebook`.
- `clients_requiring_rebook` is based on the client's most recent non-cancelled appointment being 3 to 6 months old in the business timezone, with no non-cancelled future appointment scheduled.

See [docs/frontend-client-actions-integration.md](docs/frontend-client-actions-integration.md) for the full frontend contract.

## Activity Feed

The mobile Activity screen is a business timeline, not a chat inbox.

- `GET /api/activity` returns recent operational events grouped by business-local day.
- `GET /api/appointments/:id/activity` returns appointment-specific activity in reverse chronological order for detail/history UI.
- The response is ordered most recent first and includes per-day summary counts for `new_bookings`, `cancellations`, `reschedules`, and `reminders_sent`.
- Supported MVP event types are `booking_created`, `appointment_cancelled`, `appointment_rescheduled`, and `reminder_sent`.
- Query params: `limit`, `cursor`, `activity_type`, `start_date`, `end_date`.
- Pagination is cursor-based and paginates by event, not by day-group count.

Activity events are created automatically by backend mutations:

- Creating an appointment inserts `booking_created`.
- Updating an appointment to `status: "cancelled"` inserts `appointment_cancelled`.
- Changing an appointment's scheduled time inserts `appointment_rescheduled`.
- Updating a reminder to `status: "sent"` inserts `reminder_sent`.

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

Public booking routes:

- `GET /api/public/stylists/:slug`
- `GET /api/public/services/:slug?booking_context_token=...`
- `GET /api/public/availability/:slug?booking_context_token=...`
- `GET /api/public/availability/:slug/slots?service_id=...&date=YYYY-MM-DD&booking_context_token=...`
- `POST /api/public/stylists/:slug/waitlist`
- `POST /api/public/booking-intake`
- `POST /api/public/bookings`

## Public Booking Flow

Recommended public flow:

1. `GET /api/public/stylists/:slug` and read `booking_enabled` plus `features.waitlistEnabled`.
2. If `booking_enabled` is `false`, stop the booking flow and show an "online booking unavailable" state.
3. `POST /api/public/booking-intake` with guest contact details.
4. Read `isExistingClient`, `bookingContextToken`, and `bookingEnabled` from the response.
5. If `bookingEnabled` is `false`, stop the booking flow and show an "online booking unavailable" state.
6. Pass `booking_context_token` into `GET /api/public/services/:slug` so the backend can filter service visibility using returning-client vs new-client rules.
7. If the UI needs raw weekly windows, pass the same `booking_context_token` into `GET /api/public/availability/:slug` so audience-specific windows are filtered the same way.
8. Pass the same `booking_context_token` into `GET /api/public/availability/:slug/slots` so slot generation uses the same client-specific rules and client-specific availability windows.
9. Submit the final booking through `POST /api/public/bookings`.
10. If the selected day has no useful slots and `features.waitlistEnabled=true`, the client may submit `POST /api/public/stylists/:slug/waitlist`.

`POST /api/public/bookings` still re-checks the real client match and booking rules server-side:

1. Finds the stylist by `stylist_slug`.
2. Confirms online booking is enabled.
3. Confirms the service is active for that stylist.
4. Checks that the requested datetime falls inside an active availability window.
5. Matches an existing client by email or phone, or creates a new client.
6. Creates a scheduled or pending appointment, depending on booking rules.
7. Returns a confirmation payload.

The public read endpoints also enforce booking availability now:

- `GET /api/public/services/:slug` returns `400` when `booking_enabled=false`.
- `GET /api/public/availability/:slug` returns `400` when `booking_enabled=false`.
- `GET /api/public/availability/:slug/slots` returns `400` when `booking_enabled=false`.

This is intentionally MVP-safe. There is no calendar sync, payment collection, automatic waitlist booking, or advanced collision logic beyond rejecting an exact appointment datetime conflict.

## Waitlist

Waitlist is a plan-gated backend feature for public booking pages. Basic stylists cannot use it; Pro and Premium stylists can. The source of truth is the existing `public.users.plan_tier` field (`basic`, `pro`, `premium`) exposed through the backend entitlement helpers. No Stripe or real subscription lifecycle logic is added.

Database support:

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
      "waitlistEnabled": true
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

Current limitations:

- No automatic cancellation matching.
- No automatic booking from the waitlist.
- No SMS or email notifications.
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
5. Check `GET /health`.

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
