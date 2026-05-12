# ShearSync Backend API and Booking Logic Spec

Last reviewed against the current codebase on 2026-05-04.

This document describes the backend as it is implemented today in this repository. When behavior is inferred from code paths, validators, tests, and checked-in SQL, that is called out directly. When something is stored in the schema but not enforced by runtime logic, that is called out explicitly.

---

## 1. Purpose of the Backend

ShearSync is one Express + TypeScript API that serves two consumers:

- The authenticated stylist-facing app, which acts like a lightweight CRM and operations backend.
- The unauthenticated public booking flow, which lets guests discover a stylist by slug, see bookable services and time slots, and submit a booking request.

The backend is responsible for:

- Authenticating stylists against Supabase Auth.
- Scoping all private CRM data to the authenticated stylist.
- Managing clients, appointments, reminders, photos metadata, services, booking settings, availability, activity events, dashboard data, and profile overview data.
- Exposing a public booking contract that resolves a stylist by `stylists.slug`, applies booking rules, checks availability, matches or creates a client in that stylist's CRM, and writes an appointment into the same `appointments` table used by the private app.

There is no separate guest-booking subsystem. Public bookings feed directly into the same stylist-owned client and appointment records used by the authenticated app.

---

## 2. Architecture Overview

### Runtime and framework

- Runtime: Node.js 20+ (`package.json` engines)
- Language: TypeScript
- HTTP framework: Express 4
- Validation: Zod
- Auth/data platform: Supabase Auth + Postgres
- Deployment target reflected in repo: Railway via `railway.json`

### Main entry points

- `src/server.ts`
  - Starts the Express app on `PORT` or `3000`.
- `src/app.ts`
  - Configures:
    - `helmet()`
    - `cors(...)`
    - `express.json({ limit: "1mb" })`
    - `morgan(...)`
  - Mounts `apiRouter`
  - Mounts `notFoundHandler`
  - Mounts `errorHandler`
- `src/routes/index.ts`
  - Registers public routes first.
  - Applies auth middleware to `/me` and `/api`.

### Route structure

- Public, no auth:
  - `GET /health`
  - `/api/public/*`
- Internal, no user auth:
  - `/internal/*`
  - protected by `x-internal-api-secret`
- Authenticated:
  - `GET /me`
  - `/api/account/*`
  - `/api/activity/*`
  - `/api/appointments/*`
  - `/api/calendar/*`
  - `/api/client-actions/*`
  - `/api/clients/*`
  - `/api/dashboard/*`
  - `/api/photos/*`
  - `/api/profile/*`
  - `/api/reminders/*`
  - `/api/services/*`
  - `/api/settings/*`

### Service layer structure

Most business logic lives in `src/services/*`:

- `usersService`
- `stylistsService`
- `clientsService`
- `appointmentsService`
- `servicesService`
- `availabilityService`
- `bookingRulesService`
- `publicBookingIntakeService`
- `publicBookingsService`
- `appointmentEmailEventsService`
- `appointmentEmailDeliveryService`
- `activityEventsService`
- `dashboardService`
- `calendarService`
- `clientActionsService`
- `profileOverviewService`
- `entitlementsService`
- `remindersService`
- `photosService`
- `businessTimeZoneService`
- `rebookService`

Controllers are thin and primarily:

- load `userId` via `getAuthUserId()`
- read params/query/body
- call one service
- shape the HTTP response

### Validator and schema structure

Validators live in `src/validators/*` and are route-specific:

- `accountValidators.ts`
- `activityValidators.ts`
- `appointmentValidators.ts`
- `calendarValidators.ts`
- `clientValidators.ts`
- `photoValidators.ts`
- `profileValidators.ts`
- `publicBookingValidators.ts`
- `reminderValidators.ts`
- `serviceValidators.ts`
- `settingsValidators.ts`
- `common.ts`

Important contract detail:

- Some routes accept camelCase request bodies and return camelCase responses.
- Some routes accept snake_case bodies and return raw DB-style snake_case rows.
- Public and private service routes intentionally do not use the same response shape.

### Supabase/Postgres usage

- `src/lib/supabase.ts` creates two clients:
  - `supabaseAdmin` using `SUPABASE_SERVICE_ROLE_KEY`
  - `supabaseAnon` using `SUPABASE_ANON_KEY`
- Runtime data reads and writes are done through `supabaseAdmin`.
- JWT verification is done through `supabaseAnon.auth.getClaims(token)`.
- Because the backend uses the service-role client for business data, application-level scoping in the service layer is the primary access-control mechanism inside this API.

### Public vs authenticated boundary

- Public routes are slug-based and never take a stylist `user_id` directly from the client.
- Authenticated routes are scoped to `req.auth.userId` / `req.user.id`.
- Public booking routes do not bypass stylist ownership. They resolve `stylists.slug -> stylists.user_id`, then all downstream reads and writes are constrained to that stylist.

---

## 3. Environment and Configuration

### Required environment variables

Defined in `src/config/env.ts`:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

### Optional environment variables

- `PORT`
- `NODE_ENV`
- `AUTH_MODE`
- `ENABLE_DEV_AUTH_FALLBACK`
- `SUPABASE_JWT_SECRET`
- `DEV_AUTH_USER_ID`
- `DEV_AUTH_USER_EMAIL`
- `CLIENT_APP_URL`
- `WEB_APP_URL`
- `INTERNAL_API_SECRET`

### How env loading works

- `dotenv.config()` runs at module load in `src/config/env.ts`.
- `parseEnv()` validates env using Zod.
- Defaults:
  - `PORT=3000`
  - `NODE_ENV=development`
  - `AUTH_MODE=production`
  - `ENABLE_DEV_AUTH_FALLBACK=false`
- If `NODE_ENV=production` and `AUTH_MODE=dev`, startup throws.

### Local vs production behavior

- Request logging:
  - production: `morgan("combined")`
  - non-production: `morgan("dev")`
- API error details:
  - production: hides `error.details`
  - non-production: includes `error.details`
- Auth diagnostics logging:
  - enabled outside production in `src/middleware/auth.ts`

### CORS behavior

Configured in `src/app.ts`:

- Allowed origins list is built from `CLIENT_APP_URL` and `WEB_APP_URL`.
- If the request has no `Origin` header, it is allowed.
- If both env vars are unset, `allowedOrigins.length === 0`, so all origins are effectively allowed.
- `credentials: true` is enabled.

### Development auth bypass

Only active when all of the following are true:

- `AUTH_MODE=dev`
- `ENABLE_DEV_AUTH_FALLBACK=true`
- no bearer token is present
- `DEV_AUTH_USER_ID` is set

In that case, `requireAuth` injects:

- `req.auth = { userId, email, source: "dev" }`
- `req.user = { id, email }`

### Internal trigger authorization

Internal routes use `requireInternalApiSecret` instead of Supabase user auth.

- Header: `x-internal-api-secret`
- Expected value: `INTERNAL_API_SECRET`
- If `INTERNAL_API_SECRET` is unset, internal routes return `503`.
- If the header is missing or wrong, internal routes return `401`.

### Public booking context signing secret

`src/lib/publicBookingContext.ts` signs public booking context tokens with:

- `SUPABASE_JWT_SECRET` if present
- otherwise `SUPABASE_SERVICE_ROLE_KEY`

This token is independent of Supabase Auth user tokens.

### Railway assumptions reflected in code

`railway.json` explicitly uses:

- build: `npm run build`
- start: `npm run start`

The repo does not contain Railway-specific runtime logic beyond that file.

---

## 4. Authentication and Authorization

### Authenticated request validation

Implemented in `src/middleware/auth.ts`:

1. Reads `Authorization` header.
2. Expects `Bearer <token>`.
3. Calls `supabaseAnon.auth.getClaims(token)`.
4. If claims are valid and `sub` exists:
   - sets `req.auth.userId = sub`
   - sets `req.auth.email = claims.email`
   - sets `req.auth.source = "jwt"`
   - sets `req.user = { id: sub, email }`

Failure behavior:

- malformed header -> `401 Malformed authorization header`
- missing token -> `401 Missing bearer token`
- invalid/expired token -> `401 Invalid or expired token`
- missing `sub` claim -> `401 Invalid token subject`

### Authenticated user bootstrapping

`getAuthUserId()` and `getCurrentUser()` in `src/lib/request.ts` call `usersService.ensureAuthUser(userId, email)`.

`usersService.ensureAuthUser()`:

- checks `public.users` for the id
- if missing and email exists, inserts `{ id, email: lowercasedEmail }`
- if email is missing, returns `null` and does not create a user row

### Ownership enforcement

Private services enforce ownership through query filters such as:

- `.eq("user_id", userId)`
- `.eq("stylist_id", userId)`

Examples:

- clients: `id + user_id`
- appointments: `id + user_id`
- reminders: `id + user_id`
- photos: `user_id + client_id`
- activity events: `stylist_id`

`clientsService.assertOwned()` converts a cross-stylist or missing client lookup into:

- `400 Client does not belong to the authenticated user`

### Public booking authorization model

Public booking routes are authorized by stylist slug, not bearer token:

1. Resolve `stylists.slug`.
2. Read `stylists.user_id`.
3. Use that `user_id` for all downstream data access.

### Public booking context token

`POST /api/public/booking-intake` returns a short-lived token:

- issuer: `shearsync-public-booking`
- audience: `public-booking-context`
- type claim: `public_booking_context`
- TTL: 30 minutes

Claims only contain:

- `stylist_slug`
- `is_existing_client`

The token does not contain:

- client id
- service ids
- permissions beyond "treat this browser flow as existing/new client for this stylist"

### Service-role usage

All data access uses `supabaseAdmin`. The app does not rely on end-user JWTs for row-level data enforcement.

### RLS reality

`supabase/schema.sql` enables RLS on all business tables, but the only checked-in policy is:

- `activity_events_select_own`

Because the API uses the service role, these policies are not the primary runtime guard.

---

## 5. Global API Conventions

### Base paths

- health: `/health`
- auth identity: `/me`
- authenticated API: `/api/*`
- public API: `/api/public/*`

### Response wrappers

There are three major patterns:

1. Raw top-level object, no `{ data }`
   - `GET /health` -> `{ status: "ok" }`
   - `GET /me` -> `{ auth, auth_user, profile }`
   - `GET /api/calendar` -> `{ date, appointments, summary }`

2. Standard wrapper
   - most authenticated and public endpoints -> `{ data: ... }`

3. Wrapper plus upload metadata
   - `POST /api/photos` -> `{ data: photo, upload: { ... } }`

### Error response shape

All handled errors return:

```json
{
  "error": {
    "message": "Human-readable message",
    "details": "Optional, hidden in production for ApiError and unknown errors"
  }
}
```

### Validation error behavior

There are two active patterns:

1. Route-level `validate(...)` middleware
   - catches Zod parsing errors
   - wraps them in `new ApiError(400, "Validation failed", error)`
   - response is usually:
     - `status 400`
     - `error.message = "Validation failed"`
     - `error.details = raw ZodError object` in non-production

2. Service-level direct Zod parsing
   - example: `bookingRulesService.updateForUser()` calls `bookingRulesSchema.parse(...)`
   - if that throws a `ZodError`, `errorHandler` returns:

```json
{
  "error": {
    "message": "Validation failed",
    "details": {
      "formErrors": [],
      "fieldErrors": { ... }
    }
  }
}
```

### Common status codes

- `200` success
- `201` created
- `204` delete success / no content
- `400` validation failures, disabled booking, invalid state transitions, invalid public booking rules usage
- `401` missing/invalid auth
- `403` plan-based feature denial
- `404` missing routes or missing resources
- `409` slot conflicts and duplicate public booking race/idempotency cases
- `500` unhandled or database failures

### Pagination conventions

Only the activity feed is paginated.

- `GET /api/activity`
- query `limit`, default 25, max 100
- query `cursor`
- cursor is a base64url-encoded JSON payload of:
  - `occurred_at`
  - `id`

Important implementation detail:

- the service fetches all matching events first, then applies cursor slicing in memory
- pagination is by event count, not by day-group count

### Date and time serialization

- Stored appointment timestamps are ISO 8601 UTC strings in `timestamptz` columns.
- Many public slot responses are returned in business-local offset format, for example:
  - `2026-05-05T09:00:00+00:00`
  - `2030-05-05T16:30:00-06:00`
- Public booking confirmation mixes both:
  - `appointment_date`: stored UTC ISO
  - `appointment_end`: business-local offset string
- Weekly availability settings return `HH:MM`.
- Booking rules same-day cutoff returns and accepts `HH:MM` or `HH:MM:SS` depending on endpoint:
  - settings validator accepts both
  - service returns DB value, usually `HH:MM:SS`

---

## 6. Database Model Overview

Only tables that are actually referenced by code are documented below.

### `public.users`

Purpose:

- Auth-linked business owner record.
- Source of business timezone.
- Holds plan and profile metadata used by settings, entitlements, dashboard, and public profile assembly.

Fields actively used by code:

- `id`
- `email`
- `full_name`
- `phone_number`
- `business_name`
- `timezone`
- `location_label` (referenced by code; not guaranteed in all schema snapshots)
- `avatar_image_id` (referenced by code; not guaranteed in all schema snapshots)
- `plan_tier` (referenced by code; not in checked-in base schema)
- `plan_status` (referenced by code; not in checked-in base schema)
- `sms_monthly_limit` (referenced by code; not in checked-in base schema)
- `sms_used_this_month` (referenced by code; not in checked-in base schema)
- `plan_updated_at` (written by code; not in checked-in base schema)

Relationships:

- PK referenced by most other tables through `user_id` or `stylist_id`.
- `id` references `auth.users(id)` in `schema.sql`.

Ownership rules:

- One row per authenticated stylist user id.

Important notes:

- `usersService.ensureAuthUser()` lazily creates the row with `id` and `email`.
- `resolveBusinessTimeZone()` falls back to `"UTC"` if timezone is missing or invalid.

### `public.stylists`

Purpose:

- Stores public booking page identity and settings per stylist.

Fields actively used:

- `id`
- `user_id`
- `slug`
- `display_name`
- `bio`
- `cover_photo_url`
- `booking_enabled`

Relationships:

- `user_id` uniquely references `users.id`.

Ownership rules:

- One stylist row per user.
- `settingsController.getBooking()` and `stylistsService.ensureByUserId()` auto-create this row if missing.

Important constraints:

- `slug` is unique.
- code handles slug collision by probing `slug`, `slug-2`, `slug-3`, ... up to `slug-100`

### `public.clients`

Purpose:

- Stylist-owned CRM client records.

Fields actively used:

- `id`
- `user_id`
- `first_name`
- `last_name`
- `preferred_name`
- `phone`
- `phone_normalized`
- `email`
- `instagram`
- `birthday`
- `notes`
- `preferred_contact_method`
- `tags`
- `source`
- `reminder_consent`
- `total_spend`
- `last_visit_at`
- `created_at`
- `updated_at`

Relationships:

- `user_id -> users.id`
- `appointments.client_id -> clients.id`
- `photos.client_id -> clients.id`
- `reminders.client_id -> clients.id`

Ownership rules:

- clients are stylist-scoped; there is no global customer identity table

Important constraints and assumptions:

- `phone_normalized` is indexed by `(user_id, phone_normalized)`
- matching is always stylist-scoped
- duplicate prevention in public booking is based on phone/email matching, not name

Compatibility behavior:

- `clientsService` has defensive logic to strip optional columns from writes if the target database is missing them.
- Current migrations indicate these columns should exist, but the code still contains backwards-compatibility shims.

### `public.appointments`

Purpose:

- Stores both internal and public bookings.

Fields actively used:

- `id`
- `user_id`
- `client_id`
- `appointment_date`
- `service_name`
- `duration_minutes`
- `price`
- `notes`
- `status`
- `booking_source`
- `created_at`
- `updated_at`

Relationships:

- `user_id -> users.id`
- `client_id -> clients.id`

Ownership rules:

- appointments belong to a stylist through `user_id`

Enum/status values accepted by API:

- `pending`
- `scheduled`
- `completed`
- `cancelled`
- `no_show`

Booking source values:

- `public`
- `internal`

Important constraints:

- unique active-start index:
  - `appointments_user_id_appointment_date_active_idx`
  - unique on `(user_id, appointment_date)` where `status <> 'cancelled'`
- code also checks duration overlaps in application logic, not only exact start-time uniqueness

Important modeling note:

- appointments do not store `service_id`
- they store service snapshot fields:
  - `service_name`
  - `duration_minutes`
  - `price`

### `public.services`

Purpose:

- Stylist service catalog.

Fields actively used:

- `id`
- `user_id`
- `name`
- `description`
- `category`
- `duration_minutes`
- `price`
- `is_active`
- `is_default`
- `sort_order`
- `created_at`

Relationships:

- `user_id -> users.id`

Ownership rules:

- services are stylist-owned

Important notes:

- private service endpoints transform rows into camelCase catalog objects
- public service endpoint returns raw DB rows
- `is_active` is the source of public visibility and private `visible`
- `is_default` is used by booking intake service recommendation fallback

### `public.availability`

Purpose:

- Weekly recurring availability windows.

Fields actively used:

- `id`
- `user_id`
- `day_of_week`
- `start_time`
- `end_time`
- `client_audience`
- `is_active`

Relationships:

- `user_id -> users.id`

Ownership rules:

- rows are stylist-owned

Audience values:

- `all`
- `new`
- `returning`

Important constraints:

- `day_of_week` must be `0..6`
- `client_audience` check constraint in latest migration

Important modeling note:

- this is recurring weekly availability only
- date-specific full-day closures are stored separately in `public.stylist_off_days`
- there is no partial-day exception or special-hours table in this repo

### `public.stylist_off_days`

Purpose:

- Stores stylist-defined full calendar dates that should not be bookable through the public booking page.
- This supports holidays, vacation days, and other full-day closures.

Fields actively used:

- `id`
- `user_id`
- `date`
- `label`
- `reason`
- `is_recurring`
- `created_at`
- `updated_at`

Relationships:

- `user_id -> users.id`

Ownership rules:

- rows are stylist-owned by `user_id`
- API reads/writes are always scoped to the authenticated user
- updating or deleting another user's off day returns `404`

Important constraints:

- `date` is a Postgres `date`, interpreted as the stylist's local business date
- unique constraint: `(user_id, date)`
- duplicate creates or duplicate-date updates return `409`

Current limitations:

- full-day only
- no automatic recurring holiday generation yet
- no Google Calendar sync
- creating an off day does not cancel or modify existing appointments

### `public.booking_rules`

Purpose:

- Stores public booking policy settings.

Fields actively used:

- `lead_time_hours`
- `same_day_booking_allowed`
- `same_day_booking_cutoff`
- `max_booking_window_days`
- `cancellation_window_hours`
- `late_cancellation_fee_enabled`
- `late_cancellation_fee_type`
- `late_cancellation_fee_value`
- `allow_cancellation_after_cutoff`
- `reschedule_window_hours`
- `max_reschedules`
- `same_day_rescheduling_allowed`
- `preserve_appointment_history`
- `new_client_approval_required`
- `new_client_booking_window_days`
- `restrict_services_for_new_clients`
- `restricted_service_ids`

Relationships:

- unique `user_id -> users.id`

Ownership rules:

- one row per stylist

Important constraints:

- auto-created on first read/update if missing
- `lead_time_hours <= max_booking_window_days * 24`
- `new_client_booking_window_days >= 0`
- `max_reschedules` nullable means "unlimited" in API responses

### `public.reminders`

Purpose:

- Reminder records for client follow-up or appointment reminders.

Fields actively used:

- `id`
- `user_id`
- `client_id`
- `appointment_id`
- `title`
- `due_date`
- `status`
- `channel`
- `reminder_type`
- `sent_at`
- `notes`
- `created_at`
- `updated_at`

Relationships:

- `user_id -> users.id`
- `client_id -> clients.id`
- `appointment_id -> appointments.id` nullable

Status values:

- `open`
- `done`
- `dismissed`
- `sent`

Channel values:

- `sms`
- `email`

Reminder type values:

- `appointment_reminder`
- `follow_up`
- `general`

Important note:

- the backend records reminder activity when reminder status becomes `sent`
- it does not actually send SMS or email

### `public.photos`

Purpose:

- Metadata only for client photos.

Fields actively used:

- `id`
- `user_id`
- `client_id`
- `file_path`
- `photo_type`
- `caption`
- `created_at`

Relationships:

- `user_id -> users.id`
- `client_id -> clients.id`

Photo type values:

- `before`
- `after`
- `inspiration`
- `other`

Important note:

- this backend does not upload bytes to Supabase Storage
- it only records metadata and returns an `upload` helper block in the response

### `public.activity_events`

Purpose:

- Canonical activity feed / appointment history events.

Fields actively used:

- `id`
- `stylist_id`
- `client_id`
- `appointment_id`
- `activity_type`
- `title`
- `description`
- `occurred_at`
- `metadata`
- `dedupe_key`
- `created_at`

Relationships:

- `stylist_id -> users.id`
- `client_id -> clients.id`
- `appointment_id -> appointments.id`

Activity types:

- `booking_created`
- `appointment_cancelled`
- `appointment_rescheduled`
- `reminder_sent`

Important constraints:

- unique index on `(stylist_id, dedupe_key)`
- code pre-checks dedupe, then insert races are handled by the unique index

---

## 7. Route-by-Route API Reference

All route declarations are defined in `src/routes/*`. Controllers are in `src/controllers/*`. The main auth boundary is in `src/routes/index.ts`.

### 7.1 `GET /health`

- Auth: public
- Route file: `src/routes/healthRoutes.ts`
- Purpose: liveness check
- Request params/query/body: none
- Response:

```json
{ "status": "ok" }
```

- Validation: none
- Errors: none in normal operation

### 7.2 `GET /me`

- Auth: required
- Controller: `authController.getMe`
- Purpose: returns auth context plus current user profile
- Request body/query: none
- Main logic:
  - `getCurrentUser(req)`
  - bootstraps `users` row if possible
- Response:

```json
{
  "auth": { "userId": "uuid", "email": "user@example.com", "source": "jwt|dev" },
  "auth_user": { "id": "uuid", "email": "user@example.com" },
  "profile": { "...raw users row..." }
}
```

- Errors:
  - `401 Authentication required`
  - `404 Authenticated user not found`

### 7.3 `GET /api/account/plan`

- Auth: required
- Controller: `accountController.getPlan`
- Validator: none
- Purpose: returns current plan entitlements
- Main service: `entitlementsService.getEntitlementsForUser(userId)`
- Response: `{ data: UserEntitlements }`
- Fields include:
  - `tier`
  - `status`
  - `displayName`
  - `smsMonthlyLimit`
  - `smsUsedThisMonth`
  - `smsRemainingThisMonth`
  - `features`

### 7.4 `PATCH /api/account/plan`

- Auth: required
- Validator: `updateAccountPlanSchema`
- Request body:
  - `tier`: `basic|pro|premium`
  - `status?`: `trialing|active|past_due|cancelled`
- Purpose: updates the current user's plan fields directly
- Main service: `entitlementsService.updatePlanForUser`
- Response: `{ data: UserEntitlements }`
- Important note:
  - There is no admin-role guard in this repo. Any authenticated user can hit this endpoint for their own row.

### 7.5 `GET /api/activity`

- Auth: required
- Controller: `activityController.list`
- Validator: `listActivityQuerySchema`
- Query params:
  - `limit` default `25`, max `100`
  - `cursor?`
  - `activity_type?`
  - `start_date?` as `YYYY-MM-DD`
  - `end_date?` as `YYYY-MM-DD`
- Purpose: grouped activity feed
- Main service: `activityEventsService.getFeed`
- Response:
  - `{ data: { groups, next_cursor } }`
- Group shape:
  - `date`
  - `label`
  - `summary`
  - `events`
- Appointment-related events are enriched from the current appointment row when available:
  - top-level `current_appointment_status`
  - `booking_created.metadata.current_appointment_status`
  - this value means the appointment status now, not status at the time the activity row was written
- Filters use business-local day boundaries.

### 7.6 `GET /api/client-actions`

- Auth: required
- Controller: `clientActionsController.getSummary`
- Purpose: action-center summary for the authenticated stylist
- Main service: `clientActionsService.getSummary`
- Response: `{ data: { items } }`
- Current `items` types:
  - `pending_appointment_approvals`
  - `clients_requiring_rebook`

### 7.7 `GET /api/clients`

- Auth: required
- Controller: `clientsController.list`
- Purpose: list stylist-owned clients with summary metadata
- Validator: none
- Main service: `clientsService.list`
- Response: `{ data: Row[] }`
- Additional derived fields per row:
  - `next_appointment_at`
  - `has_future_appointment`
  - `needs_rebook`
  - `last_service`
- Important implementation detail:
  - The code query explicitly selects a narrow field list, then fills missing optional fields with defaults in memory.
  - Needs verification: mock tests do not enforce column projection, so live Supabase responses may be narrower than test snapshots suggest.

### 7.8 `POST /api/clients`

- Auth: required
- Controller: `clientsController.create`
- Validator: `createClientSchema`
- Request body:
  - `first_name`, `last_name`
  - optional/nullable:
    - `preferred_name`
    - `phone`
    - `email`
    - `instagram`
    - `birthday`
    - `preferred_contact_method`
    - `notes`
    - `tags`
    - `source`
    - `reminder_consent`
    - `total_spend`
    - `last_visit_at`
- Main logic:
  - normalizes email to lowercase
  - strips `@` from instagram
  - dedupes tags
  - computes `phone_normalized` when `phone` is present
  - writes compatibility-safe payload through `executeClientWriteWithCompatibility`
- Response: `{ data: fullClientRowWithDerivedSummaryFields }`

### 7.9 `GET /api/clients/:id`

- Auth: required
- Validator: `uuidParamSchema`
- Controller: `clientsController.getById`
- Purpose: full client detail + derived summary metadata
- Main service: `clientsService.getById`
- Response: `{ data: Row }`

### 7.10 `PATCH /api/clients/:id`

- Auth: required
- Validator: `uuidParamSchema` + `updateClientSchema`
- Purpose: partial client update
- Main logic: same sanitization path as create
- Response: `{ data: updatedClientRowWithDerivedSummaryFields }`

### 7.11 `DELETE /api/clients/:id`

- Auth: required
- Validator: `uuidParamSchema`
- Purpose: hard-delete client
- Main service: `clientsService.remove`
- Response: `204 No Content`
- Important note:
  - There is no archive/soft-delete behavior.

### 7.12 `GET /api/clients/:id/appointments`

- Auth: required
- Validator: `uuidParamSchema`
- Controller: `appointmentsController.listByClient`
- Purpose: list appointments for one client
- Main service: `appointmentsService.listByClient`
- Response: `{ data: Row[] }`
- Order: `appointment_date desc`

### 7.13 `GET /api/clients/:id/photos`

- Auth: required
- Validator: `uuidParamSchema`
- Controller: `photosController.listByClient`
- Purpose: list photo metadata for one client
- Main service: `photosService.listByClient`
- Response: `{ data: Row[] }`
- Order: `created_at desc`

### 7.14 `GET /api/appointments/internal-context`

- Auth: required
- Validator: `getInternalAppointmentContextSchema`
- Query params:
  - `date` as `YYYY-MM-DD`
  - `durationMinutes`
- Purpose:
  - internal scheduling helper
  - suggests overlap-safe slots for a full local day
- Main service: `appointmentsService.getInternalContext`
- Response: `{ data: { date, availableSlots, existingAppointments, blockedTimes } }`
- Important implementation details:
  - ignores saved availability windows
  - ignores public booking rules
  - scans the full 24-hour local day in 15-minute increments
  - `blockedTimes` is always `[]` today

### 7.15 `GET /api/appointments/:id/activity`

- Auth: required
- Validator: `uuidParamSchema`
- Controller: `appointmentsController.listActivity`
- Purpose: appointment-specific activity history
- Main service: `activityEventsService.listByAppointment`
- Response: `{ data: { events } }`

### 7.16 `POST /api/appointments`

- Auth: required
- Validator: `createAppointmentSchema`
- Request body:
  - `client_id`
  - `appointment_date`
  - `service_name`
  - `duration_minutes`
  - optional `price`
  - optional `notes`
  - optional `status`, default `scheduled`
  - optional `booking_source`, default `internal`
- Main logic:
  - verifies client ownership
  - checks overlap conflicts unless `status === "cancelled"`
  - inserts appointment
  - records `booking_created` activity event for every created appointment, including internal ones
- Response: `{ data: appointmentRow }`
- Errors:
  - `400 Client does not belong to the authenticated user`
  - `409 This time slot is already booked.`

### 7.17 `PATCH /api/appointments/:id`

- Auth: required
- Validator: `uuidParamSchema` + `updateAppointmentSchema`
- Purpose: generic appointment mutation
- Fields allowed by schema:
  - `client_id`
  - `appointment_date`
  - `service_name`
  - `duration_minutes`
  - `price`
  - `notes`
  - `status`
  - `booking_source`
- Main logic:
  - verifies appointment ownership
  - verifies new client ownership if `client_id` changes
  - re-checks conflicts if date/duration/status changes and resulting status is not `cancelled`
  - creates activity rows for:
    - transition into `cancelled`
    - date or duration change while not cancelled
- Response: `{ data: updatedAppointment }`
- Important note:
  - There is no strict status transition state machine beyond the special pending decision endpoint.

### 7.18 `PATCH /api/appointments/:id/decision`

- Auth: required
- Validator: `uuidParamSchema` + `pendingAppointmentDecisionSchema`
- Body:
  - `decision: "accept" | "reject"`
- Purpose: accept or reject a `pending` appointment
- Main logic: `appointmentsService.applyPendingDecision`
  - `accept` -> updates status to `scheduled`
  - `reject` -> updates status to `cancelled`
- Response: `{ data: updatedAppointment }`
- Errors:
  - `400 Only pending appointments can be accepted or rejected`

### 7.19 `GET /api/calendar`

- Auth: required
- Validator: `getCalendarDaySchema`
- Query:
  - `date` as `YYYY-MM-DD`
- Purpose: one-day calendar payload for the authenticated stylist
- Main service: `calendarService.getDay`
- Response is not wrapped:

```json
{
  "date": "YYYY-MM-DD",
  "appointments": [...],
  "summary": {
    "selected_date_label": "...",
    "total_appointments": 0,
    "booked_revenue": 0,
    "open_slots": 0
  }
}
```

- Important implementation details:
  - excludes `status = cancelled`
  - joins client first/last name
  - returns derived `start_time`, `end_time`, `services`, `revenue`, `client_name`, `location: null`
  - `open_slots` is `floor((availableMinutes - bookedMinutes) / 60)`, not a literal list of slots

### 7.20 `GET /api/dashboard`

- Auth: required
- Controller: `dashboardController.getSummary`
- Purpose: dashboard/home summary payload
- Main service: `dashboardService.getSummary`
- Response: `{ data: dashboardSummary }`
- Top-level fields:
  - `total_clients`
  - `upcoming_reminders`
  - `appointments`
  - `today_appointments`
  - `upcoming_appointments`
  - `next_appointment`
  - `recent_appointments`
  - `top_clients_by_spend`
  - `monthly_revenue_summary`

### 7.21 `POST /api/photos`

- Auth: required
- Validator: `createPhotoSchema`
- Body:
  - `client_id`
  - `file_path`
  - `photo_type`
  - optional `caption`
- Purpose: record photo metadata only
- Main service: `photosService.create`
- Response:

```json
{
  "data": { "...photo row..." },
  "upload": {
    "storage_provider": "supabase",
    "expected_file_path": "same-as-file_path",
    "status": "metadata_recorded"
  }
}
```

### 7.22 `GET /api/reminders`

- Auth: required
- Controller: `remindersController.list`
- Purpose: list reminders
- Main service: `remindersService.list`
- Response: `{ data: Row[] }`
- Order: `due_date asc`

### 7.23 `POST /api/reminders`

- Auth: required
- Validator: `createReminderSchema`
- Body:
  - `client_id`
  - optional `appointment_id`
  - `title`
  - `due_date`
  - optional `status`, default `open`
  - optional `channel`
  - optional `reminder_type`
  - optional `sent_at`
  - optional `notes`
- Main logic:
  - verifies client ownership
  - inserts reminder
- Response: `{ data: reminderRow }`
- Important note:
  - current code does not verify that `appointment_id` belongs to the same stylist or client

### 7.24 `PATCH /api/reminders/:id`

- Auth: required
- Validator: `uuidParamSchema` + `updateReminderSchema`
- Purpose: update reminder
- Main logic:
  - verifies reminder ownership
  - verifies new `client_id` ownership if changed
  - auto-fills `sent_at = now` if resulting status is `sent` and `sent_at` is absent
  - writes `reminder_sent` activity when resulting status is `sent`
- Response: `{ data: reminderRow }`

### 7.25 `GET /api/profile/overview`

- Auth: required
- Validator: `profileOverviewQuerySchema`
- Query:
  - `performancePeriod? = week | month`
- Purpose: richer profile/settings overview payload
- Main service: `profileOverviewService.getOverview`
- Response: `{ data: ProfileOverviewResponse }`
- Important note:
  - This endpoint bootstraps booking rules if missing.
  - It does not auto-create a `stylists` row.

### 7.26 `GET /api/services`

- Auth: required
- Controller: `servicesController.list`
- Purpose: list service catalog for current stylist
- Main service: `servicesService.listByUserId`
- Response: `{ data: ServiceCatalogItem[] }`
- Returned field names are camelCase:
  - `duration`, `durationMinutes`
  - `price`, `priceAmount`
  - `visible`
  - `isDefault`
  - `sortOrder`

### 7.27 `POST /api/services`

- Auth: required
- Validator: `createServiceSchema`
- Body:
  - `name`
  - `duration` or `durationMinutes`
  - `price` or `priceAmount`
  - `visible`
  - optional `category`
  - optional `description`
  - optional `isDefault`
  - optional `sortOrder`
- Main logic:
  - normalizes to DB fields
  - if `sortOrder` absent, computes `max(sort_order) + 1`
- Response: `{ data: ServiceCatalogItem }`

### 7.28 `PATCH /api/services/reorder`

- Auth: required
- Validator: `reorderServicesSchema`
- Body:
  - `serviceIds: uuid[]`
- Purpose: reorder service catalog
- Main logic:
  - rejects duplicates
  - verifies all ids belong to current user
  - updates `sort_order = index + 1` in parallel
- Response: `{ data: ServiceCatalogItem[] }`
- Errors:
  - `400 serviceIds must not contain duplicates`
  - `400 serviceIds must all belong to services owned by the authenticated user`

### 7.29 `PATCH /api/services/:id`

- Auth: required
- Validator: `uuidParamSchema` + `updateServiceSchema`
- Purpose: partial service update
- Accepted body keys:
  - same shape as create, but all optional
- Response: `{ data: ServiceCatalogItem }`
- Errors:
  - `404 Service not found`

### 7.30 `DELETE /api/services/:id`

- Auth: required
- Validator: `uuidParamSchema`
- Purpose: hard-delete a service row
- Response: `204 No Content`
- Important note:
  - appointments do not reference `service_id`, so deleting a service does not affect historical appointment snapshots

### 7.30A `GET /api/off-days`

- Auth: required
- Validator: `listOffDaysQuerySchema`
- Query:
  - optional `startDate` as `YYYY-MM-DD`
  - optional `endDate` as `YYYY-MM-DD`
- Purpose: list the authenticated stylist's holidays and off days
- Main service: `offDaysService.listOffDays`
- Response:

```json
{
  "data": [
    {
      "id": "uuid",
      "date": "2026-12-25",
      "label": "Christmas Day",
      "reason": "Closed for holiday",
      "isRecurring": false,
      "createdAt": "...",
      "updatedAt": "..."
    }
  ]
}
```

### 7.30B `POST /api/off-days`

- Auth: required
- Validator: `createOffDaySchema`
- Body:
  - `date` required, `YYYY-MM-DD`
  - optional `label`, max 100 chars
  - optional `reason`, max 500 chars
  - optional `isRecurring`, defaults false
- Purpose: create one full-day closure
- Main service: `offDaysService.createOffDay`
- Response: `{ data: OffDay }`
- Errors:
  - `409 An off day already exists for this date`

### 7.30C `POST /api/off-days/bulk`

- Auth: required
- Validator: `bulkCreateOffDaysSchema`
- Body:
  - `offDays: OffDayCreateInput[]`
- Purpose: create multiple full-day closures
- Main service: `offDaysService.createOffDays`
- Response: `{ data: OffDay[] }`

### 7.30D `PATCH /api/off-days/:id`

- Auth: required
- Validator: `uuidParamSchema` + `updateOffDaySchema`
- Accepted body keys:
  - `date`
  - `label`
  - `reason`
  - `isRecurring`
- Purpose: update an owned off day
- Response: `{ data: OffDay }`
- Errors:
  - `404 Off day not found`
  - `409 An off day already exists for this date`

### 7.30E `DELETE /api/off-days/:id`

- Auth: required
- Validator: `uuidParamSchema`
- Purpose: delete an owned off day
- Response: `204 No Content`
- Errors:
  - `404 Off day not found`

### 7.31 `GET /api/settings/profile`

- Auth: required
- Controller: `settingsController.getProfile`
- Purpose: return current `users` row
- Response: `{ data: userRow }`

### 7.32 `PATCH /api/settings/profile`

- Auth: required
- Validator: `updateProfileSchema`
- Accepted body:
  - `full_name`
  - `phone_number`
  - `business_name`
  - `location_label`
  - `avatar_image_id`
  - `timezone`
- Main service: `usersService.updateProfile`
- Response: `{ data: updatedUserRow }`
- Important note:
  - unknown keys are stripped by Zod and do not reach the service
  - for example, `plan_tier` sent here is ignored rather than updated

### 7.33 `GET /api/settings/booking`

- Auth: required
- Controller: `settingsController.getBooking`
- Purpose: return booking page settings (`stylists` row)
- Main logic:
  - `stylistsService.ensureByUserId(userId)`
  - auto-creates row if missing
- Response: `{ data: stylistRow }`

### 7.34 `PATCH /api/settings/booking`

- Auth: required
- Validator: `updateBookingSettingsSchema`
- Accepted body:
  - `slug`
  - `display_name`
  - `bio`
  - `cover_photo_url`
  - `booking_enabled`
- Main logic:
  - creates row if missing
  - enforces plan gates:
    - changing `cover_photo_url` requires `customCoverPhoto`
    - changing to a custom slug requires `customSlug`
  - existing duplicate slug -> `409 Booking slug is already in use`
- Response: `{ data: stylistRow }`

### 7.35 `GET /api/settings/availability`

- Auth: required
- Controller: `settingsController.getAvailability`
- Purpose: normalized weekly availability settings
- Main service: `availabilityService.getWeeklyForUser`
- Response:

```json
{
  "data": {
    "timezone": "IANA/timezone",
    "days": [
      {
        "dayOfWeek": 0,
        "isOpen": false,
        "windows": []
      }
    ]
  }
}
```

### 7.36 `PUT /api/settings/availability`

- Auth: required
- Validator: `replaceAvailabilitySchema`
- Body:
  - `days`: exactly 7 day objects
  - each day:
    - `dayOfWeek`
    - `isOpen`
    - `windows[]`
  - each window:
    - `startTime`
    - `endTime`
    - optional `clientAudience`, default `"all"`
- Main logic:
  - validates one entry per day
  - validates open/closed consistency
  - validates non-overlap per audience only
  - deletes all existing availability rows for the user
  - inserts new rows
- Response: `{ data: AvailabilitySettingsResponse }`

### 7.37 `GET /api/settings/booking-rules`

- Auth: required
- Controller: `settingsController.getBookingRules`
- Purpose: return booking rules
- Main service: `bookingRulesService.getByUserId`
- Main behavior:
  - auto-creates row with defaults if missing
- Response: `{ data: BookingSettings }`

### 7.38 `PATCH /api/settings/booking-rules`

- Auth: required
- Validator: `updateBookingRulesSchema`
- Purpose: partial booking rules update
- Main logic:
  - bootstraps row if missing
  - merges current rules with incoming patch
  - validates merged state through `bookingRulesSchema`
  - verifies `restrictedServiceIds` all belong to current user
  - only writes provided keys
- Response: `{ data: BookingSettings }`

### 7.39 `GET /api/public/stylists/:slug`

- Auth: public
- Validator: `slugParamSchema`
- Controller: `publicController.getStylist`
- Purpose: public stylist lookup by slug
- Main service: `stylistsService.getPublicProfileBySlug`
- Response: `{ data: PublicStylistProfile }`
- Important behavior:
  - works even when `booking_enabled = false`
  - this is how the public frontend knows to show an unavailable state

### 7.40 `GET /api/public/services/:slug`

- Auth: public
- Validator: `slugParamSchema` + `getPublicServicesSchema`
- Query:
  - optional `booking_context_token`
- Purpose: return active public services
- Main service: `servicesService.listActiveByStylistSlug`
- Response: `{ data: rawServiceRows[] }`
- Filters:
  - requires `booking_enabled = true`
  - filters to `is_active = true`
  - if no valid booking context token, treats caller as new client
  - if new client and booking rules restrict services, restricted service ids are removed
- Important note:
  - response is raw DB rows, not `ServiceCatalogItem`

### 7.41 `GET /api/public/availability/:slug`

- Auth: public
- Validator: `slugParamSchema` + `getPublicAvailabilitySchema`
- Query:
  - optional `booking_context_token`
- Purpose: return raw weekly availability windows after audience filtering
- Main service: `availabilityService.listActiveByStylistSlug`
- Response: `{ data: rawAvailabilityRows[] }`
- Filters:
  - requires `booking_enabled = true`
  - only `is_active = true`
  - audience-filtered using booking context token when present
- Important note:
  - this endpoint does not apply lead time, max window, same-day, or conflict filtering

### 7.42 `GET /api/public/availability/:slug/slots`

- Auth: public
- Validator: `slugParamSchema` + `getPublicAvailabilitySlotsSchema`
- Query:
  - `service_id`
  - `date`
  - optional `booking_context_token`
- Purpose: generate final bookable slots for one service on one date
- Main service: `availabilityService.getBookableSlotsByStylistSlug`
- Response:

```json
{
  "data": {
    "date": "YYYY-MM-DD",
    "timezone": "IANA/timezone",
    "service": {
      "id": "uuid",
      "name": "Service Name",
      "duration_minutes": 60,
      "price": 95
    },
    "slots": [
      { "start": "...offset datetime...", "end": "...offset datetime..." }
    ]
  }
}
```

- Main filtering logic:
  - requires `booking_enabled = true`
  - service must exist and be active for stylist
  - returns no slots when the requested local date is in `stylist_off_days`
  - slot increment is 15 minutes
  - excludes past instants
  - applies same-day rules
  - applies lead time
  - applies max booking window
  - applies new-client booking window
  - applies new-client restricted services
  - applies audience-specific availability windows
  - excludes overlapping active appointments
  - dedupes slot starts across DST transitions

### 7.43 `POST /api/public/booking-intake`

- Auth: public
- Validator: `createPublicBookingIntakeSchema`
- Body:
  - `stylist_slug`
  - `full_name`
  - `phone`
  - `email`
- Purpose:
  - classify visitor as existing/new/ambiguous
  - generate `bookingContextToken`
  - preview booking behavior
  - recommend a service for returning clients
- Main service: `publicBookingIntakeService.lookupBookingIntake`
- Response: `{ data: PublicBookingIntakeResponse }`
- Matching behavior:
  - stylist-scoped only
  - normalized phone first if column exists
  - raw phone next
  - email last
- `matchStatus` values:
  - `matched`
  - `not_found`
  - `ambiguous`

### 7.44 `POST /api/public/bookings`

- Auth: public
- Validator: `createPublicBookingSchema`
- Body:
  - `stylist_slug`
  - `service_id`
  - `requested_datetime`
  - `guest_first_name`
  - `guest_last_name`
  - `guest_email`
  - `guest_phone`
  - optional `notes`
- Purpose: final public booking creation
- Main service: `publicBookingsService.create`
- Response: `{ data: PublicBookingConfirmation }`
- Important behavior:
  - does not accept or require `booking_context_token`
  - rematches the client directly from submitted contact info
  - can create `status = scheduled` or `status = pending`
  - writes `booking_source = public`
  - on exact duplicate repeat submission for the same client/service/start/duration, returns the existing appointment confirmation instead of creating a second row

---

## 8. Booking Logic Deep Dive

This is the most important runtime path. The current implementation is split between:

- `stylistsService.getBySlug()`
- `servicesService.listActiveByStylistSlug()`
- `availabilityService.getBookableSlotsByStylistSlug()`
- `publicBookingIntakeService.lookupBookingIntake()`
- `publicBookingsService.create()`
- `appointmentsService.createForBooking()`

### 8.1 How a public booking page identifies a stylist

- Public routes use `:slug`.
- `stylistsService.getBySlug(slug)` does:
  - `select * from stylists where slug = ? maybeSingle`
  - throws `404 Stylist not found` if missing

### 8.2 Slug generation and persistence

For authenticated stylist settings bootstrapping:

- display name fallback order:
  - payload `display_name`
  - `users.business_name`
  - `users.full_name`
  - email prefix
  - `"My Booking Page"`
- slug fallback order:
  - payload `slug`
  - payload `display_name`
  - `users.business_name`
  - `users.full_name`
  - `users.email`
  - fallback `"stylist"`
- slug normalization:
  - lowercase
  - non-alphanumeric collapsed to `-`
  - trim leading/trailing `-`
  - collapse duplicate `-`
- uniqueness probe:
  - `slug`
  - `slug-2`
  - `slug-3`
  - ...

### 8.3 Public profile vs public booking enabled

- `GET /api/public/stylists/:slug` always returns the stylist profile, even if `booking_enabled = false`.
- Public services, availability, slots, and final booking all call `stylistsService.assertPublicBookingEnabled()` and reject when disabled:
  - `400 Online booking is not enabled for this stylist`

`POST /api/public/booking-intake` is different:

- it does not error when booking is disabled
- it returns `bookingEnabled: false`
- it always returns a token with `isExistingClient: false`
- it behaves like a new-client preview, even if the submitted contact might match an existing client

### 8.4 Service selection and validation

Final booking validates the service in `publicBookingsService.create()`:

1. load stylist by slug
2. assert booking enabled
3. call `servicesService.getActiveForStylist(userId, serviceId)`
4. if no active row:
   - `400 Selected service is not available`

Services used in booking are snapshots only. The created appointment stores:

- `service_name`
- `duration_minutes`
- `price`

It does not store `service_id`.

### 8.5 Public service visibility

Public services are filtered in `servicesService.listActiveByStylistSlug()`:

- always require `is_active = true`
- if booking context token marks caller as existing client:
  - all active services are returned
- otherwise:
  - load `booking_rules`
  - if `restrictServicesForNewClients = true` and `restrictedServiceIds` non-empty
  - exclude those service ids

No other public service visibility logic exists.

### 8.6 Public client matching / intake matching

Shared matching behavior lives in `clientsService.findBookingMatches()` and `findMatchingForBooking()`.

Order of matching:

1. normalized phone match on `phone_normalized`, if a normalized phone can be computed
2. raw `phone`
3. `email`

Matching is always scoped by `user_id`.

Name is not used for matching.

Consequences:

- two different people sharing a phone or email can be merged
- ambiguous phone duplicates are only surfaced during intake, not during final booking

### 8.7 Phone normalization

Implemented in `src/lib/phone.ts`.

Behavior:

- trims input
- strips non-digits except leading `+`
- rejects multiple plus signs or embedded plus signs
- if value begins with `+`:
  - allows 10 to 15 digits after `+`
  - returns `+<digits>`
- if value has no `+`:
  - 10 digits -> prepends `+1`
  - 11 digits starting with `1` -> returns `+<digits>`
  - otherwise invalid

Examples:

- `(720) 555-0148` -> `+17205550148`
- `720-555-0148` -> `+17205550148`
- `1 720 555 0148` -> `+17205550148`

### 8.8 Booking intake response logic

`publicBookingIntakeService.lookupBookingIntake()`:

1. resolves stylist
2. reads `booking_enabled`
3. normalizes phone
4. lowercases email
5. splits `full_name` into:
   - `firstName = first token`
   - `lastName = rest joined by spaces`
6. loads booking rules
7. masks phone to `***-***-1234`
8. if booking disabled:
   - returns `matchStatus = not_found`
   - `bookingEnabled = false`
   - no recommendation
   - new-client behavior preview
9. otherwise finds stylist-scoped matches

Possible outcomes:

- `matched`
  - `clientFound = true`
  - `isExistingClient = true`
  - returns matched client preview
  - returns `bookingBehavior` with `requiresApproval: false`
  - returns `recommendedService` if found
- `not_found`
  - `clientFound = false`
  - `isExistingClient = false`
  - returns new-client preview behavior
- `ambiguous`
  - multiple matches
  - still `isExistingClient = false`
  - `candidateCount`
  - `nextStep = "collect_email_or_name"`
  - note: current backend does not actually use `full_name` for disambiguation after this step

### 8.9 Recommended service logic

`publicBookingIntakeService.getRecommendedService(userId, clientId)`:

1. load active services via `servicesService.listActiveByUserId()`
2. load client's non-cancelled appointments ordered by `appointment_date desc`
3. build a map from normalized service name text to active service row
4. choose first match in this order:
   - most recent `status === "completed"` appointment whose `service_name` matches an active service name
   - otherwise most recent non-cancelled appointment whose `service_name` matches an active service name
   - otherwise first active default service (`is_default = true`)
   - otherwise `null`

Service recommendation is text-based, not foreign-key-based.

### 8.10 Final public booking creation

`publicBookingsService.create(payload)` performs:

1. resolve stylist by `stylist_slug`
2. assert `booking_enabled`
3. load active service by `service_id`
4. resolve business timezone with `businessTimeZoneService.getForUser(userId)`
5. normalize `requested_datetime` into business-local wall-clock time
6. normalize guest phone
7. lowercase guest email
8. rematch existing client by phone/email
9. decide whether caller is existing client from that direct match
10. validate booking rules
11. validate availability
12. find or create client
13. create appointment with `booking_source = "public"`
14. return confirmation payload

### 8.11 Datetime normalization during final booking

`normalizeRequestedDateTimeForBusinessTimeZone()` is important:

- it parses the submitted timestamp string
- extracts the date and wall-clock time pieces
- ignores the submitted offset for booking semantics
- reinterprets the local wall-clock time in the stylist's business timezone
- converts that to the canonical UTC timestamp that gets stored

This means:

- if the client sends a stale offset during DST transitions, the backend corrects it
- final booking is based on stylist-local wall time, not on trusting the caller's UTC offset

### 8.12 Booking rule enforcement during final booking

Implemented in `validateBookingRules(...)` inside `src/services/publicBookingsService.ts`.

Rules enforced today:

- requested time must be in the future
- `leadTimeHours`
- `maxBookingWindowDays`
- `sameDayBookingAllowed`
- `sameDayBookingCutoff`
- `newClientApprovalRequired`
- `newClientBookingWindowDays`
- `restrictServicesForNewClients` + `restrictedServiceIds`

Effects:

- if `newClientApprovalRequired = true` and client is new:
  - appointment status becomes `pending`
- otherwise:
  - appointment status is `scheduled`

### 8.13 Booking rules stored but not enforced in public booking

These fields are persisted and returned but not used in booking/runtime enforcement today:

- `cancellationWindowHours`
- `lateCancellationFeeEnabled`
- `lateCancellationFeeType`
- `lateCancellationFeeValue`
- `allowCancellationAfterCutoff`
- `rescheduleWindowHours`
- `maxReschedules`
- `sameDayReschedulingAllowed`
- `preserveAppointmentHistory`

### 8.14 Slot generation

`availabilityService.getBookableSlotsByStylistSlug()`:

1. resolves stylist and timezone
2. verifies active service
3. loads booking rules
4. resolves booking context token, if present
5. determines `isExistingClient`
6. checks `stylist_off_days` for the requested local date and returns an empty `slots` array when blocked
7. loads active availability windows for the local day, filtered by audience
8. loads active appointments for that local date
9. iterates candidate start times in 15-minute steps inside each window
10. filters candidates by:
   - uniqueness of `candidateIso`
   - not in the past
   - same-day rules
   - max booking window
   - lead time
   - new-client restricted service logic
   - new-client booking window
   - overlap with existing appointments
11. returns `{ date, timezone, service, slots }`

### 8.15 Audience-specific availability

Audience handling rules:

- new/no-token caller can use windows with:
  - `all`
  - `new`
- returning-client token caller can use windows with:
  - `all`
  - `returning`

Final booking itself does not accept the token, but it re-derives `isExistingClient` from direct match and applies the same audience logic in `availabilityService.isRequestedTimeAvailable(...)`.

### 8.16 Existing appointments blocking time

Blocking logic is overlap-based, not exact-start-only:

- candidate start must not overlap any non-cancelled appointment
- overlap check:
  - `start < existingEnd`
  - `end > existingStart`

This same overlap logic is used for:

- authenticated appointment create
- authenticated appointment update
- public booking create
- internal appointment context
- public slot generation

### 8.17 Today calculation and timezone handling

Business-local "today" comes from:

- `getCurrentLocalDate(timeZone, now)`

Day boundaries come from:

- `getStartOfLocalDayUtc(dateText, timeZone)`
- `getEndOfLocalDayUtc(dateText, timeZone)`

Day-of-week comes from:

- `getLocalDayOfWeekForDate(dateText, timeZone)`
- `getLocalDayOfWeekForInstant(instant, timeZone)`

### 8.18 What happens for invalid dates/times

- invalid request format is rejected by Zod before controller/service logic
- invalid slot date query -> `400 Validation failed`
- invalid phone -> `400 Validation failed` on public endpoints, or `400 Phone number is invalid` if it reaches `normalizePhoneOrThrow()`
- invalid booking context token -> `400 Booking context is invalid or expired`
- invalid requested datetime string in booking -> `400 Requested datetime is invalid`

### 8.19 What happens if the requested time is unavailable

Possible errors:

- service inactive/missing -> `400 Selected service is not available`
- booking disabled -> `400 Online booking is not enabled for this stylist`
- same-day or lead-time or max-window rule failure -> `400`
- request outside allowed availability or overlapping another appointment -> `409 Requested time is no longer available`

### 8.20 Activity rows created during booking

Public booking creation ultimately calls `appointmentsService.createForBooking()` -> `appointmentsService.create()` -> `activityEventsService.recordBookingCreated()`.

This creates:

- `activity_type = "booking_created"`
- title like `"Jane booked Silk Press"`
- metadata:
  - `client_name`
  - `service_name`
  - `appointment_start_time`

This happens for both `scheduled` and `pending` public bookings.

### 8.21 Known booking gaps visible in code

- final booking does not accept `booking_context_token`; it re-derives existing/new client status instead
- intake ambiguity suggests `collect_email_or_name`, but name is not actually used for final disambiguation
- no public cancel or reschedule routes
- no payment capture or deposit logic
- no waitlist
- no calendar sync
- no exception dates / PTO / holiday overrides

---

## 9. Appointment Lifecycle

### Creation paths

Authenticated creation:

- route: `POST /api/appointments`
- service: `appointmentsService.create()`
- default `booking_source = internal`
- only enforces client ownership + overlap conflict
- ignores booking rules and saved availability

Public creation:

- route: `POST /api/public/bookings`
- service: `publicBookingsService.create()`
- always writes `booking_source = public`
- applies public booking rules and availability

### Default status behavior

- authenticated create default: `scheduled`
- public create default:
  - `pending` if new client approval is required
  - otherwise `scheduled`

### Status values

Accepted by validators:

- `pending`
- `scheduled`
- `completed`
- `cancelled`
- `no_show`

### Status changes

Generic `PATCH /api/appointments/:id` can set status to any allowed value.

Special behavior:

- non-cancelled -> `cancelled`
  - writes `appointment_cancelled` activity
- changing date/duration while resulting status is not cancelled
  - writes `appointment_rescheduled` activity

There is no special activity for:

- `completed`
- `no_show`
- `pending -> scheduled` through generic patch

### Pending-appointment decision endpoint

`PATCH /api/appointments/:id/decision`:

- only works if current status is `pending`
- `accept` -> `scheduled`
- `reject` -> `cancelled`

### Reschedule behavior

Any change to:

- `appointment_date`
- `duration_minutes`

while resulting status is not `cancelled` is treated as reschedule/timing update for activity purposes.

### Cancellation behavior

Current code only writes `"cancelled_by": "stylist"` in created cancellation activity events.

The metadata type also supports `"client"`, and the feed can read it, but no current route writes client-originated cancellations.

### Completion and no-show behavior

Implemented only as status values:

- API accepts them
- calendar/dashboard/profile queries include them unless specifically excluding only `cancelled`
- no lifecycle events are written for them

### Appointment history fetching

- by client:
  - `GET /api/clients/:id/appointments`
- by appointment activity:
  - `GET /api/appointments/:id/activity`

### Activity written per action

- create appointment -> `booking_created`
- update to cancelled -> `appointment_cancelled`
- move/update duration -> `appointment_rescheduled`

No other appointment-specific activity is currently written.

---

## 10. Client Logic

### Client creation

Implemented in `clientsService.create()`:

- stylist ownership set by `user_id`
- sanitizes and normalizes:
  - email lowercasing
  - optional empty string trimming
  - phone normalization into `phone_normalized`
  - instagram leading `@` removal
  - tag dedupe

### Client update

Implemented in `clientsService.update()` with the same sanitization path.

Optional fields can generally be cleared with `null` where schema allows it.

### Client deletion

- `DELETE /api/clients/:id`
- hard delete only
- no archive state

### Ownership enforcement

- all client routes scoped by `user_id`
- `clientsService.assertOwned()` is reused by photos, appointments, and reminders

### Search/sort/filter behavior

There is no general text search or filtering API for clients in this repo.

Current list behavior:

- order by `updated_at desc`

### Client detail aggregation

Both `list()` and `getById()` enrich base client rows with:

- `next_appointment_at`
- `has_future_appointment`
- `needs_rebook`
- `last_service`

Important implementation nuance:

- despite variable naming, `last_service` is based on the most recent non-cancelled appointment in the past, not strictly the most recent completed appointment

### Rebook logic

Implemented in `rebookService.evaluateClientRebookStatus()`:

- if client has any future non-cancelled appointment -> `needsRebook = false`
- otherwise find most recent past non-cancelled appointment
- mark `needsRebook = true` only if that last local appointment date is between:
  - 6 months ago
  - and 3 months ago

This same logic powers:

- `GET /api/clients` derived `needs_rebook`
- `GET /api/client-actions` item `clients_requiring_rebook`

### Public booking interaction with client records

Public booking can:

- match an existing client
- create a new client

Client matching uses only stylist-scoped phone/email matching.

Public booking-created client rows use:

- `first_name`
- `last_name`
- `email`
- `phone`
- `notes`

### Validation

`createClientSchema` / `updateClientSchema` enforce:

- `first_name` and `last_name` required on create
- optional valid email
- `preferred_contact_method` in:
  - `text`
  - `call`
  - `email`
  - `instagram`
- `source` in:
  - `referral`
  - `instagram`
  - `walk-in`
  - `existing-client`
  - `other`

---

## 11. Service Logic

### Service creation and update

Private service routes use camelCase request contracts and transformed responses.

Accepted input aliases:

- `duration` or `durationMinutes`
- `price` or `priceAmount`

Validation ensures:

- if both duration fields are sent, they must match
- if both price fields are sent, they must match

Create requires:

- `name`
- one duration field
- one price field
- `visible`

### Private response shape

`servicesService.toServiceCatalogItem()` returns:

- `id`
- `name`
- `duration`
- `durationMinutes`
- `price`
- `priceAmount`
- `visible`
- optional `category`
- optional `description`
- `isDefault`
- `sortOrder`

### Public response shape

`GET /api/public/services/:slug` returns raw DB rows from `services`:

- `id`
- `user_id`
- `name`
- `duration_minutes`
- `price`
- `is_active`
- `is_default`
- `sort_order`
- and any other selected `*` fields

### Visibility and active state

- `visible` in private API maps directly to `services.is_active`
- public service list only exposes `is_active = true`

### Default service assumptions

- `is_default` is only used today by booking intake recommendation fallback
- there is no seed/default service creation in code

### Service delete behavior

- hard delete
- no guard against deleting services referenced by historical appointments because appointments only store snapshots

### Relevant mismatches and notes

- Private and public service contracts do not match.
- Historical appointments are not relationally tied to services.

---

## 12. Availability and Booking Settings Logic

### How availability is stored

- table: `availability`
- one row per weekly window
- fields:
  - `day_of_week`
  - `start_time`
  - `end_time`
  - `client_audience`
  - `is_active`

### How availability is read and updated

- private settings read:
  - `availabilityService.getWeeklyForUser()`
  - groups rows into 7 `days`
- private settings write:
  - `availabilityService.replaceWeeklyForUser()`
  - deletes all current rows for the user
  - inserts new rows for open windows

Important implementation detail:

- replacement is not wrapped in a transaction

### Availability validation rules

From `replaceAvailabilitySchema` and `assertValidWindows()`:

- exactly 7 days must be sent
- each `dayOfWeek` must appear once
- closed day cannot contain windows
- open day must contain at least one window
- within the same audience on a day:
  - windows cannot overlap
  - start must be before end
- overlapping windows are allowed across different audiences

### Public available slot generation

Generated by `availabilityService.getBookableSlotsByStylistSlug()`.

Slot generation uses:

- active availability rows for the local day
- audience filtering
- booking rules
- active appointments for that local day
- stylist off days for that local date
- 15-minute increments
- service duration

If the requested `date` exists in `stylist_off_days` for that stylist, the endpoint returns the normal response shape with `slots: []`. The final public booking and public reschedule checks also call `availabilityService.isRequestedTimeAvailable(...)`, which returns `false` on off days so bookings cannot be created by bypassing slot lookup.

### Booking settings storage

Booking page settings live in `stylists`:

- `slug`
- `display_name`
- `bio`
- `cover_photo_url`
- `booking_enabled`

### Booking settings plan gates

Enforced in `stylistsService.upsertForUser()`:

- `cover_photo_url` update requires plan feature `customCoverPhoto`
- a custom slug requires plan feature `customSlug`
- all plans currently have `bookingPage = true`

### Booking settings stored but not fully enforced

From `booking_rules`, stored today but not enforced:

- cancellation fee fields
- reschedule limit fields
- preserve history

### Reminder/notification preference fields

Stored in the database or entitlement config:

- `clients.reminder_consent`
- `reminders.channel`
- `reminders.reminder_type`
- `users.sms_monthly_limit`
- `users.sms_used_this_month`
- plan features:
  - `emailReminders`
  - `smsReminders`

### Actual email/SMS sending status

Actual provider delivery is not implemented in this repo.

What exists today:

- reminder rows
- reminder `sent` state
- reminder activity events
- plan entitlement helpers such as `assertSmsAvailable()`
- appointment email outbox rows in `appointment_email_events`
- appointment email event queueing for scheduled, pending, confirmed, cancelled, and rescheduled appointments
- email-ready appointment template data including business identity, formatted appointment time range, appointment end time, timezone, contact info, management token, and management URL when app URL env is configured
- provider-neutral appointment email rendering and queue processing in `appointmentEmailDeliveryService`
- an explicit opt-in noop email provider that marks appointment email events as `skipped`
- provider state fields on appointment email events: `status`, `provider`, `provider_message_id`, `sent_at`, and `error`
- delivery retry fields on appointment email events: `attempt_count` and `last_attempt_at`
- retry handling for `failed` rows and stale `sending` rows

Internal trigger:

- `POST /internal/appointment-emails/process`
- requires `x-internal-api-secret`
- optional query:
  - `limit`, default `25`, max `100`
  - `allow_noop`, default `false`
- processes queued appointment email events through the configured provider abstraction
- refuses to process without a real provider unless `allow_noop=true`
- claims retryable rows by marking them `sending`, increments `attempt_count`, and records `last_attempt_at`
- retries failed rows and stale `sending` rows up to the configured max attempt count

What does not exist:

- provider integrations
- external scheduler configuration for calling the appointment email queue trigger
- reminder delivery pipeline
- automatic reminder send triggers

---

## 13. Activity Feed Logic

### Activity event model

Implemented in `activity_events` plus `activityEventsService`.

Canonical activity types:

- `booking_created`
- `appointment_cancelled`
- `appointment_rescheduled`
- `reminder_sent`

Legacy handling:

- migration `202605010001_activity_type_contract_cleanup.sql` converts legacy `appointment_created` rows to `booking_created`
- validators and route filters no longer accept `appointment_created`

### When activity rows are created

- appointment create -> `recordBookingCreated()`
- appointment cancellation -> `recordAppointmentCancelled()`
- appointment date/duration change -> `recordAppointmentRescheduled()`
- reminder marked sent -> `recordReminderSent()`

### Dedupe model

Each writer builds a deterministic `dedupe_key`.

Examples:

- booking created: `booking_created:<appointmentId>`
- cancellation: `appointment_cancelled:<appointmentId>:<appointmentDate>`
- reminder sent: `reminder_sent:<reminderId>:<channel>:<occurredAt>`

`createIfMissing()`:

1. checks for existing `(stylist_id, dedupe_key)`
2. returns early if found
3. tries insert
4. ignores unique violation race

### Feed filtering

`GET /api/activity` supports:

- `activity_type`
- `start_date`
- `end_date`
- `cursor`
- `limit`

Filtering happens by:

- `activity_type` equality
- `occurred_at >= business-local start_of_day(start_date)`
- `occurred_at < business-local start_of_next_day(end_date)`

### Global feed vs appointment-specific feed

Global feed:

- `activityEventsService.getFeed()`
- returns grouped-by-day structure with summaries and cursor
- enriches paged appointment-related rows with the appointment's current `status` as `current_appointment_status`

Appointment-specific feed:

- `activityEventsService.listByAppointment()`
- first confirms the appointment belongs to the stylist
- returns flat `events[]` newest first
- includes the same current appointment status enrichment

### Smart context / daily summary logic

The feed groups events by business-local day and generates labels:

- `Today`
- `Yesterday`
- otherwise formatted weekday/month/day

Per-day summary counts:

- `new_bookings`
- `cancellations`
- `reschedules`
- `reminders_sent`

### Feed copy generation

The backend generates user-facing titles and descriptions.

Examples:

- booking: `"Sarah booked Balayage"`
- cancellation: `"Jessica cancelled Haircut"`
- reminder: `"SMS reminder sent to Amanda"`

### Known feed limitations

- pagination is implemented in memory after fetching matching rows
- no write path exists for client-originated cancellation events, although the schema supports `cancelled_by: "client"`

---

## 14. Dashboard/Home Summary Logic

### Dashboard route

- route: `GET /api/dashboard`
- service: `dashboardService.getSummary()`

### Data included

- total client count
- upcoming open reminders with `due_date >= now`
- today's non-cancelled appointments
- up to 100 upcoming non-cancelled appointments
- next upcoming non-cancelled appointment
- up to 100 past non-cancelled appointments
- top clients ordered by `total_spend desc` or `updated_at desc` fallback
- monthly completed revenue summary

### Next appointment logic

`next_appointment` is the first non-cancelled appointment where:

- `appointment_date >= now`

This query is independent of the 100-row upcoming list and is limited to 1, so it still works even if there are many older upcoming rows.

### Revenue calculations

Dashboard `monthly_revenue_summary.completed_revenue` uses only:

- `appointments.status = completed`
- `appointment_date >= business-local month start`

By contrast, some profile overview metrics and forecasts use all non-cancelled appointments, not only completed ones.

### Date range and timezone assumptions

- local "today" uses business timezone
- month start uses business-local month start converted to UTC

### Client action logic

Separate route: `GET /api/client-actions`

Returns:

- pending appointment approvals
- rebook candidates

This route is likely the backend for a dashboard action center / home follow-up section.

---

## 15. Timezone and Date Handling

Core utilities live in `src/lib/timezone.ts`.

### Where timezone is stored

- primary source: `users.timezone`

### Default timezone behavior

- fallback: `"UTC"`
- invalid timezone strings also fall back to `"UTC"`

### How timezone is resolved

- `businessTimeZoneService.getForUser(userId)`
  - loads `users` row
  - calls `resolveBusinessTimeZone(user)`

### Day boundaries

Used by activity, calendar, dashboard, profile overview, and availability logic:

- start of local day -> `getStartOfLocalDayUtc(dateText, timeZone)`
- end of local day -> `getEndOfLocalDayUtc(dateText, timeZone)`

### Public booking timezone behavior

Public booking is always normalized into the stylist's business timezone before being written.

Public slot responses are returned in offset-aware business-local datetimes.

### DST handling

Tests in `src/__tests__/publicAvailability.test.ts` verify:

- nonexistent spring-forward local times are skipped
- fall-back duplicate-hour starts remain unique

### Utilities used

- `addDays`
- `formatDateInTimeZone`
- `getCurrentLocalDate`
- `getLocalDateForInstant`
- `getLocalDayOfWeekForDate`
- `getLocalDayOfWeekForInstant`
- `getMinutesSinceMidnightForInstant`
- `getStartOfCurrentLocalMonthUtc`
- `formatInstantInTimeZoneOffset`
- `zonedDateTimeToUtc`

### Important UTC/local conversion considerations

- `appointment_date` is stored as UTC ISO
- many public slot fields are returned in local offset form
- `normalizeRequestedDateTimeForBusinessTimeZone()` intentionally reinterprets submitted wall-clock time in the business timezone and does not trust the caller's offset as the final source of truth

---

## 16. Error Handling and Validation

### Zod validation patterns

- params validation via `uuidParamSchema` / `slugParamSchema`
- request-level query/body validation via `validate(...)`
- direct service-level Zod parsing in a few places like booking rules merge validation

### Common validation errors

- invalid UUID params
- invalid slug format
- invalid `YYYY-MM-DD`
- invalid phone
- invalid timezone
- inconsistent service duration/price alias fields
- invalid booking rules merged state

### Not-found behavior

- unknown route -> `404 Route not found`
- missing stylist -> `404 Stylist not found`
- missing client/service/appointment/reminder -> resource-specific 404 messages

### Unauthorized behavior

- missing auth -> `401`
- invalid token -> `401`
- plan feature denied -> `403 This feature is not available for the current plan.`

### Database error handling

`handleSupabaseError()` converts Supabase/PostgREST errors into:

- `500 <fallbackMessage>`
- details include:
  - `code`
  - `message`
  - `details`
  - `hint`

Some code paths special-case DB constraint errors:

- duplicate active appointment start -> `409 This time slot is already booked.`
- duplicate stylist slug -> `409 Booking slug is already in use`

### Public booking error behavior

Common public booking errors:

- stylist not found -> `404`
- booking disabled -> `400`
- service unavailable -> `400`
- invalid/expired booking context token -> `400`
- requested time no longer available -> `409`

### Centralized error middleware

Defined in `src/middleware/errorHandler.ts`:

- `notFoundHandler()` throws `ApiError(404, "Route not found")`
- `errorHandler` serializes:
  - `ZodError`
  - `ApiError`
  - unknown errors

---

## 17. Current Limitations / Known Gaps

These are visible in the current code and should be treated as implementation realities, not future promises.

### Messaging and reminders

- Appointment email queueing and provider-neutral processing exist, but no real email provider adapter is configured. Processing refuses to use the noop provider unless explicitly requested.
- No SMS delivery implementation exists.
- Reminder records and activity events exist, but sending is out of scope in this repo.
- `entitlementsService.assertSmsAvailable()` exists but is not wired into reminder mutation routes.

### Payments and fees

- Booking-rule fields for late cancellation fees are stored but never enforced.
- There is no payment collection, deposits, card hold, or refund flow.

### Cancellation and reschedule policy enforcement

- Cancellation/reschedule rule fields are stored but unused in runtime booking flows.
- Public cancel/reschedule routes exist for token-based appointment management.

### Google Calendar and external sync

- `googleCalendarSync` exists as a plan feature flag in `src/lib/plans.ts`.
- No Google Calendar integration code exists in the current backend.
- `calendarService` is internal-only view assembly, not external sync.

### Weekly business recap and client export

- `weeklyBusinessRecap` and `clientExport` exist as plan features only.
- No implementation exists in routes or services.

### Photos

- Photo endpoints record metadata only.
- No upload signing, storage bucket write, signed read URL, or deletion flow is implemented.

### Booking context token limitations

- The token only carries `isExistingClient` and stylist slug.
- Final booking does not accept this token; it rematches directly from submitted contact info.

### Intake ambiguity gap

- Ambiguous intake returns `nextStep: "collect_email_or_name"`.
- Current matching logic only uses phone and email.
- Name is not currently used to resolve ambiguity.

### Client list projection needs verification

- `clientsService.list()` only selects a small fixed set of columns.
- The mock test helper does not enforce real Supabase column projection.
- Live behavior for optional client fields in list responses should be verified against a real database.

### Profile overview availability audience gap

- `profileOverviewService` selects availability rows without `client_audience`.
- `availabilitySettings` returned from profile overview therefore normalizes missing audience values to `"all"`.
- Audience-specific availability is preserved in `GET /api/settings/availability`, but not faithfully represented in profile overview today.

### Calendar open-slots approximation

- `calendarService.getDay()` computes `open_slots` as remaining whole hours, not actual candidate slot count.
- It sums all availability minutes for the day without audience-aware deduping.
- If overlapping `new` and `returning` windows exist, `open_slots` can overstate real general availability.

### Transactions

- service reorder updates run in parallel, not in a transaction
- weekly availability replacement is delete-then-insert, not transactional

### Schema/code drift

- Code references `users.location_label`, `avatar_image_id`, `plan_tier`, `plan_status`, `sms_monthly_limit`, `sms_used_this_month`, and `plan_updated_at`.
- These columns are not present in the checked-in base `supabase/schema.sql`.
- They may exist in the live database but are not fully represented in the baseline schema file.

### RLS coverage

- RLS is enabled in checked-in SQL for many tables.
- Only one policy is included in the repo.
- Because the backend uses the service-role key, application-layer scoping remains the actual protection in this codebase.

---

## 18. Developer Notes

### How to run locally

From `README.md` and `package.json`:

```bash
npm install
cp .env.example .env
npm run dev
```

### Scripts

```bash
npm run dev
npm run typecheck
npm run build
npm run test
npm run start
```

### Manual verification flows

Recommended high-signal checks before changing backend behavior:

1. Authenticated appointment create:
   - verify `booking_source` defaults to `internal`
   - verify overlap conflicts return `409`
   - verify `booking_created` activity is written

2. Public intake flow:
   - verify `matched`, `not_found`, and `ambiguous` responses
   - verify `bookingContextToken` issuance
   - verify service filtering for new vs returning client

3. Public slot generation:
   - verify same-day cutoff
   - verify lead-time filtering
   - verify new-client restricted services
   - verify audience-specific availability windows
   - verify DST slot generation for non-UTC timezones

4. Final public booking:
   - verify scheduled vs pending status
   - verify normalized phone matching
   - verify idempotent repeat submission
   - verify cross-client conflict still rejects

5. Availability settings:
   - verify full-week replacement
   - verify same-audience overlap rejection
   - verify different-audience overlap acceptance

### Tests present in repo

- `src/__tests__/apiRoutes.test.ts`
- `src/__tests__/activity.test.ts`
- `src/__tests__/clientActions.test.ts`
- `src/__tests__/profileDashboard.test.ts`
- `src/__tests__/publicAvailability.test.ts`

These tests are useful for:

- route contract snapshots
- auth/dev-auth behavior
- activity event generation
- public booking and availability edge cases
- DST slot handling
- plan entitlement behavior

### What to check before deploying to Railway

- environment variables exist and validate
- `AUTH_MODE` is not `dev` in production
- Supabase schema/migrations reflect the columns the code expects
- public slug uniqueness and booking settings creation still work
- public booking contract remains compatible:
  - `GET /api/public/stylists/:slug`
  - `POST /api/public/booking-intake`
  - `GET /api/public/services/:slug`
  - `GET /api/public/availability/:slug`
  - `GET /api/public/availability/:slug/slots`
  - `POST /api/public/bookings`

### How to avoid breaking public booking contracts

- Do not change public route paths.
- Do not silently change the `PublicBookingIntakeResponse` shape.
- Do not change slot datetime formatting without updating clients.
- Remember that public services route returns raw DB rows today; changing it to the private camelCase catalog shape would be a breaking API change.
- Remember that final public booking currently does not accept `booking_context_token`; adding a requirement there would be breaking.
