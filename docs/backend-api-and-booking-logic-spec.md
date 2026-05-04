# ShearSync Backend API & Booking Logic Specification

Generated from codebase inspection. This document describes the current implementation unless explicitly marked as planned or recommended.

## 1. Executive Summary

ShearSync is a single Express + TypeScript backend that powers two related experiences: an authenticated stylist-facing CRM/mobile app and an unauthenticated public booking flow. The stylist side handles clients, appointments, reminders, services, activity feed data, booking settings, and availability. The public side lets a guest load a stylist booking page, view public services and open slots, and submit a booking request.

Supabase is the operational source of truth. Supabase Auth is used to validate bearer tokens for authenticated requests. Supabase Postgres stores users, stylists, clients, appointments, services, booking rules, availability windows, reminders, photos metadata, and activity events. Supabase Storage is only partially represented today: photo endpoints record file metadata and expected paths, but the backend does not yet upload files or generate signed URLs.

The backend splits into two trust models. Authenticated stylist routes are scoped by the authenticated user id and behave like a private CRM. Public routes are keyed off a stylist slug and expose only the data needed for the booking page. Public booking creation resolves the slug to a stylist, looks up the selected service, checks current booking rules and availability, matches or creates a client inside that stylist's CRM, and creates an appointment plus an activity event.

The product direction is clearly CRM-first. Appointments are treated as a business record attached to a stylist-owned client. Public booking feeds the same CRM rather than creating a separate guest-booking subsystem. That makes the client matching, ownership scoping, and activity creation logic especially important.

## 2. System Overview

At a high level, the system has one backend API serving two frontends:

- A mobile stylist app for authenticated CRM workflows
- A public booking web app for guests
- One Express API for both
- Supabase Auth for stylist authentication
- Supabase Postgres for application data
- Supabase Storage only as a placeholder/integration point today
- Railway deployment for this API
- A separate web frontend is implied by `WEB_APP_URL`; this repo does not contain Vercel-specific backend code

Text diagram:

```text
Client Mobile App
   ↓
ShearSync API
   ↓
Supabase Auth / Postgres / Storage

Public Booking Page
   ↓
Public Booking API Routes
   ↓
Supabase Postgres
```

Backend boot flow:

- `src/server.ts` starts the Express app on `PORT` or `3000`
- `src/app.ts` configures `helmet`, `cors`, JSON parsing, and request logging
- CORS allows `CLIENT_APP_URL` and `WEB_APP_URL`
- `src/routes/index.ts` mounts public routes first, then applies auth middleware to `/me` and `/api`
- Errors are centralized in `src/middleware/errorHandler.ts`

Deployment/runtime notes:

- `railway.json` runs `npm run build` then `npm run start`
- `AUTH_MODE=production` is the normal mode
- A development auth fallback exists, but production mode explicitly rejects `AUTH_MODE=dev`

## 3. Core Data Model

The backend is mostly centered on stylist-owned records. Almost every business entity carries a `user_id` that points to the owning stylist in `public.users`.

Important implementation detail: appointments do not store a `service_id`. They store a snapshot of `service_name`, `duration_minutes`, and `price` at booking time. That is good for historical accuracy, but it also means historical appointments are not strongly linked to the current service catalog.

Another important detail: the checked-in `supabase/schema.sql` is not fully aligned with what the code expects. The code reads and writes extra `users` columns such as `location_label`, `avatar_image_id`, `plan_tier`, `plan_status`, `sms_monthly_limit`, and `sms_used_this_month`, but those fields are not present in the base schema file in this repo.

| Entity | Purpose | Key Fields | Owned By | Used In |
|---|---|---|---|---|
| `users` | Auth-linked stylist/business profile row | `id`, `email`, `full_name`, `phone_number`, `business_name`, `timezone` | Stylist | Auth, settings, public profile, timezone resolution |
| `stylists` | Public booking profile/settings per stylist | `user_id`, `slug`, `display_name`, `bio`, `cover_photo_url`, `booking_enabled` | Stylist | Public booking page, booking settings |
| `clients` | CRM contact/customer record | `user_id`, `first_name`, `last_name`, `phone`, `phone_normalized`, `email`, `notes`, `preferred_name`, `instagram`, `tags`, `source`, `reminder_consent`, `total_spend`, `last_visit_at` | Stylist | Client list/detail, public booking matching |
| `appointments` | Scheduled/pending/cancelled/completed bookings | `user_id`, `client_id`, `appointment_date`, `service_name`, `duration_minutes`, `price`, `status`, `booking_source` | Stylist | Calendar, public booking, dashboard, activity |
| `services` | Service catalog for the stylist | `user_id`, `name`, `duration_minutes`, `price`, `is_active`, `is_default`, `sort_order`, `category`, `description` | Stylist | Public service list, booking selection, profile overview |
| `availability` | Weekly recurring open windows with optional client audience targeting | `user_id`, `day_of_week`, `start_time`, `end_time`, `client_audience`, `is_active` | Stylist | Settings, public slot generation |
| `booking_rules` | Rules/policies for public booking | `user_id`, `lead_time_hours`, `same_day_booking_allowed`, `max_booking_window_days`, `new_client_approval_required`, `new_client_booking_window_days`, `restrict_services_for_new_clients`, `restricted_service_ids` plus cancellation/reschedule fields | Stylist | Public booking validation, slot generation, settings |
| `photos` | Client photo metadata only | `user_id`, `client_id`, `file_path`, `photo_type`, `caption` | Stylist | Client photos, future storage integration |
| `reminders` | Manual or system reminders | `user_id`, `client_id`, `appointment_id`, `title`, `due_date`, `status`, `channel`, `reminder_type`, `sent_at` | Stylist | Reminder UI, activity feed |
| `activity_events` | Business timeline entries | `stylist_id`, `client_id`, `appointment_id`, `activity_type`, `title`, `description`, `occurred_at`, `metadata`, `dedupe_key` | System-generated under stylist | Activity feed, appointment history |

Entity notes:

- `users`
  - Purpose: authenticated business owner identity and business timezone source of truth
  - Public/private: private, but selected fields are exposed through the public stylist profile
  - System behavior: `usersService.ensureAuthUser` lazily creates the row when an authenticated user first hits the API and an email is available

- `stylists`
  - Purpose: public booking page identity layer
  - Public/private: partially public
  - Slug logic:
    - default slug comes from explicit slug, then display name, then business name, then full name, then email prefix
    - slug is normalized to lowercase hyphenated tokens
    - uniqueness is handled by probing `slug`, then `slug-2`, `slug-3`, etc.

- `clients`
  - Purpose: CRM record per stylist, not global person identity
  - Public/private: private record, but public booking may match or create it
  - Matching helpers:
    - `phone_normalized` is the preferred match key when present
    - matching is always scoped to `user_id`

- `appointments`
  - Purpose: appointment record and historical snapshot
  - Public/private: private CRM record, though public booking creates them
  - Important fields:
    - `status`: app validators accept `pending`, `scheduled`, `completed`, `cancelled`, `no_show`
    - `booking_source`: `public` or `internal`
  - Relationships:
    - belongs to one stylist by `user_id`
    - belongs to one client by `client_id`
  - Constraint nuance:
    - DB unique index only prevents same `user_id + appointment_date` for non-cancelled rows
    - code also checks overlapping durations in application logic

- `services`
  - Purpose: active catalog for booking
  - Public/private: public only when `is_active=true`
  - Important nuance:
    - authenticated API returns transformed service objects (`duration`, `durationMinutes`, `priceAmount`, `visible`)
    - public API returns raw DB rows

- `availability`
  - Purpose: weekly recurring windows, not dated exceptions
  - Public/private: used privately in settings and publicly in slot generation
  - Important nuance:
    - this is the only availability source today
    - there is no separate holidays/blackouts/exceptions table

- `booking_rules`
  - Purpose: controls public booking behavior
  - Public/private: private settings, indirectly shape public booking
  - Important nuance:
    - some rules are enforced now
    - some are stored for future use only

- `photos`
  - Purpose: metadata record only
  - Public/private: stylist-owned
  - Storage note:
    - `file_path` looks like a Storage path, but the backend currently does not upload or fetch image bytes

- `activity_events`
  - Purpose: operational timeline, not chat/messaging
  - Public/private: private CRM data
  - Event types currently supported:
    - `booking_created`
    - `appointment_cancelled`
    - `appointment_rescheduled`
    - `reminder_sent`

- Public-facing profile/media fields
  - `stylists.slug`
  - `stylists.display_name`
  - `stylists.bio`
  - `stylists.cover_photo_url`
  - `stylists.booking_enabled`
  - `users.business_name`
  - `users.phone_number`
  - `users.timezone`

- Avatar/cover/image fields
  - `stylists.cover_photo_url` is a plain URL string and is public-facing
  - `photos.file_path` is an internal metadata path for client photos
  - `users.avatar_image_id` is referenced by code but not present in the checked-in base schema

## 4. Authentication & Authorization

Authenticated routes:

- `GET /me`
- Everything under `/api/*` except `/api/public/*`

Public routes:

- `GET /health`
- Everything under `/api/public/*`

Authentication flow:

- `requireAuth` reads the `Authorization: Bearer <token>` header
- The backend verifies the JWT through `supabaseAnon.auth.getClaims(token)`
- If valid, `req.auth.userId` and `req.user.id` are set from the token subject
- `getAuthUserId()` also calls `usersService.ensureAuthUser()` so authenticated usage can bootstrap a `users` row

Ownership scoping:

- Private business tables are scoped in service queries with `.eq("user_id", userId)` or `.eq("stylist_id", userId)`
- Client ownership is explicitly checked before related writes such as appointments, reminders, and photos
- Appointment activity first confirms the appointment belongs to the stylist before loading events
- Booking rules can reference restricted service ids only if those services belong to the same user

How cross-stylist access is prevented:

- Authenticated services query by both id and owner id
- Example:
  - client lookup: `where id = :clientId and user_id = :currentUserId`
  - appointment lookup: `where id = :appointmentId and user_id = :currentUserId`
- Public flows never search globally; they first resolve `stylists.slug -> stylist.user_id` and then use that user id for all downstream client/service/appointment queries

Local development auth bypass:

- Enabled only when:
  - `AUTH_MODE=dev`
  - `ENABLE_DEV_AUTH_FALLBACK=true`
  - no bearer token is present
  - `DEV_AUTH_USER_ID` exists
- In that case the backend injects a fake authenticated user from env
- Production config explicitly rejects `NODE_ENV=production` with `AUTH_MODE=dev`

Examples:

- Authenticated: `GET /api/clients`, `PATCH /api/settings/booking-rules`, `POST /api/appointments`
- Public: `GET /api/public/stylists/:slug`, `GET /api/public/availability/:slug/slots`, `POST /api/public/bookings`

Security note:

- The code scopes access correctly at the service layer
- The checked-in schema enables RLS on many tables, but only an `activity_events` select policy is present in `schema.sql`
- Because the backend uses the Supabase service-role client for data access, application-layer scoping is currently the primary protection inside this API

## 5. API Route Inventory

### 5.1 Health / System

| Method | Path | Auth? | Purpose | Request | Response | Main service/function | Tables touched | Validation | Common errors |
|---|---|---:|---|---|---|---|---|---|---|
| GET | `/health` | No | Liveness check | none | `{ status: "ok" }` | route inline handler | none | none | none |

### 5.2 Authenticated User / Profile

| Method | Path | Auth? | Purpose | Request | Response | Main service/function | Tables touched | Validation | Common errors |
|---|---|---:|---|---|---|---|---|---|---|
| GET | `/me` | Yes | Return auth context plus current user profile | bearer token | `{ auth, auth_user, profile }` | `authController.getMe -> getCurrentUser` | `users` | auth only | `401`, `404` |
| GET | `/api/settings/profile` | Yes | Get raw authenticated user profile row | none | `{ data: userRow }` | `settingsController.getProfile -> getCurrentUser` | `users` | auth only | `401`, `404` |
| PATCH | `/api/settings/profile` | Yes | Update user profile/business fields | body: `full_name`, `phone_number`, `business_name`, `location_label`, `avatar_image_id`, `timezone` | `{ data: userRow }` | `settingsController.updateProfile -> usersService.updateProfile` | `users` | `updateProfileSchema` | `400`, `401`, `404` |
| GET | `/api/profile/overview` | Yes | Profile/settings summary screen data | query: `performancePeriod=week|month` | `{ data: profileOverview }` | `profileController.getOverview -> profileOverviewService.getOverview` | `users`, `stylists`, `booking_rules`, `services`, `appointments`, `availability` | `profileOverviewQuerySchema` | `401`, `500` |
| GET | `/api/dashboard` | Yes | Dashboard summary | none | `{ data: dashboardSummary }` | `dashboardController.getSummary -> dashboardService.getSummary` | `clients`, `reminders`, `appointments` | auth only | `401`, `500` |
| GET | `/api/calendar` | Yes | Calendar view for one local business day | query: `date=YYYY-MM-DD` | `{ date, appointments, summary }` | `calendarController.getDay -> calendarService.getDay` | `appointments`, `clients`, `availability`, `users` | `getCalendarDaySchema` | `400`, `401` |
| GET | `/api/client-actions` | Yes | Action-center items like pending approvals and rebook prompts | none | `{ data: { items } }` | `clientActionsController.getSummary -> clientActionsService.getSummary` | `appointments`, `clients`, `users` | auth only | `401`, `500` |
| GET | `/api/account/plan` | Yes | Current plan/feature entitlements | none | `{ data: entitlements }` | `accountController.getPlan -> entitlementsService.getEntitlementsForUser` | `users` | auth only | `401`, `500` |
| PATCH | `/api/account/plan` | Yes | Update plan tier/status | body: `tier`, optional `status` | `{ data: entitlements }` | `accountController.updatePlan -> entitlementsService.updatePlanForUser` | `users` | `updateAccountPlanSchema` | `400`, `401`, `500` |

### 5.3 Clients

| Method | Path | Auth? | Purpose | Request | Response | Main service/function | Tables touched | Validation | Common errors |
|---|---|---:|---|---|---|---|---|---|---|
| GET | `/api/clients` | Yes | List clients plus summary metadata | none | `{ data: clients[] }` | `clientsController.list -> clientsService.list` | `clients`, `appointments`, `users` | auth only | `401`, `500` |
| POST | `/api/clients` | Yes | Create client | body: client profile fields | `{ data: client }` | `clientsController.create -> clientsService.create` | `clients` | `createClientSchema` | `400`, `401`, `500` |
| GET | `/api/clients/:id` | Yes | Get one full client record plus summary metadata | param: UUID | `{ data: client }` | `clientsController.getById -> clientsService.getById` | `clients`, `appointments`, `users` | `uuidParamSchema` | `400`, `401`, `404` |
| PATCH | `/api/clients/:id` | Yes | Update client | param: UUID, body partial client fields | `{ data: client }` | `clientsController.update -> clientsService.update` | `clients` | `uuidParamSchema`, `updateClientSchema` | `400`, `401`, `404` |
| DELETE | `/api/clients/:id` | Yes | Delete client | param: UUID | `204` | `clientsController.remove -> clientsService.remove` | `clients` | `uuidParamSchema` | `400`, `401`, `404` |
| GET | `/api/clients/:id/appointments` | Yes | List all appointments for a client | param: UUID | `{ data: appointments[] }` | `appointmentsController.listByClient -> appointmentsService.listByClient` | `clients`, `appointments` | `uuidParamSchema` | `400`, `401`, `404` |

### 5.4 Appointments

| Method | Path | Auth? | Purpose | Request | Response | Main service/function | Tables touched | Validation | Common errors |
|---|---|---:|---|---|---|---|---|---|---|
| GET | `/api/appointments/internal-context` | Yes | Return conflict-free internal slot suggestions for a date/duration | query: `date`, `durationMinutes` | `{ data: { date, availableSlots, existingAppointments, blockedTimes } }` | `appointmentsController.getInternalContext -> appointmentsService.getInternalContext` | `appointments`, `users` | `getInternalAppointmentContextSchema` | `400`, `401` |
| POST | `/api/appointments` | Yes | Create internal appointment | body: `client_id`, `appointment_date`, `service_name`, `duration_minutes`, `price`, `notes`, `status?`, `booking_source?` | `{ data: appointment }` | `appointmentsController.create -> appointmentsService.create` | `clients`, `appointments`, `activity_events` | `createAppointmentSchema` | `400`, `401`, `409` |
| PATCH | `/api/appointments/:id` | Yes | Update appointment | param: UUID, body partial appointment fields | `{ data: appointment }` | `appointmentsController.update -> appointmentsService.update` | `appointments`, `clients`, `activity_events` | `uuidParamSchema`, `updateAppointmentSchema` | `400`, `401`, `404`, `409` |
| PATCH | `/api/appointments/:id/decision` | Yes | Accept/reject a pending appointment | param: UUID, body: `decision=accept|reject` | `{ data: appointment }` | `appointmentsController.applyPendingDecision -> appointmentsService.applyPendingDecision` | `appointments`, `activity_events` | `uuidParamSchema`, `pendingAppointmentDecisionSchema` | `400`, `401`, `404`, `409` |

### 5.5 Services

| Method | Path | Auth? | Purpose | Request | Response | Main service/function | Tables touched | Validation | Common errors |
|---|---|---:|---|---|---|---|---|---|---|
| GET | `/api/services` | Yes | List service catalog in transformed frontend shape | none | `{ data: services[] }` | `servicesController.list -> servicesService.listByUserId` | `services` | auth only | `401`, `500` |
| POST | `/api/services` | Yes | Create service | body: `name`, `duration/durationMinutes`, `price/priceAmount`, `visible`, optional metadata | `{ data: service }` | `servicesController.create -> servicesService.create` | `services` | `createServiceSchema` | `400`, `401` |
| PATCH | `/api/services/reorder` | Yes | Reorder services | body: `serviceIds[]` | `{ data: services[] }` | `servicesController.reorder -> servicesService.reorder` | `services` | `reorderServicesSchema` | `400`, `401` |
| PATCH | `/api/services/:id` | Yes | Update service | param: UUID, body partial service fields | `{ data: service }` | `servicesController.update -> servicesService.update` | `services` | `uuidParamSchema`, `updateServiceSchema` | `400`, `401`, `404` |
| DELETE | `/api/services/:id` | Yes | Delete service | param: UUID | `204` | `servicesController.delete -> servicesService.delete` | `services` | `uuidParamSchema` | `400`, `401`, `404` |

### 5.6 Photos / Storage

| Method | Path | Auth? | Purpose | Request | Response | Main service/function | Tables touched | Validation | Common errors |
|---|---|---:|---|---|---|---|---|---|---|
| GET | `/api/clients/:id/photos` | Yes | List photo metadata for a client | param: UUID | `{ data: photos[] }` | `photosController.listByClient -> photosService.listByClient` | `clients`, `photos` | `uuidParamSchema` | `400`, `401`, `404` |
| POST | `/api/photos` | Yes | Record client photo metadata and expected storage path | body: `client_id`, `file_path`, `photo_type`, `caption` | `{ data: photo, upload: { storage_provider, expected_file_path, status } }` | `photosController.create -> photosService.create` | `clients`, `photos` | `createPhotoSchema` | `400`, `401`, `404` |

### 5.7 Activity Feed

| Method | Path | Auth? | Purpose | Request | Response | Main service/function | Tables touched | Validation | Common errors |
|---|---|---:|---|---|---|---|---|---|---|
| GET | `/api/activity` | Yes | Business activity feed grouped by day | query: `limit`, `cursor`, `activity_type`, `start_date`, `end_date` | `{ data: { groups, next_cursor } }` | `activityController.list -> activityEventsService.getFeed` | `activity_events`, `users` | `listActivityQuerySchema` | `400`, `401` |
| GET | `/api/appointments/:id/activity` | Yes | Activity history for one appointment | param: UUID | `{ data: { events } }` | `appointmentsController.listActivity -> activityEventsService.listByAppointment` | `appointments`, `activity_events` | `uuidParamSchema` | `400`, `401`, `404` |
| GET | `/api/reminders` | Yes | List reminders | none | `{ data: reminders[] }` | `remindersController.list -> remindersService.list` | `reminders` | auth only | `401`, `500` |
| POST | `/api/reminders` | Yes | Create reminder | body: `client_id`, `title`, `due_date`, optional `appointment_id`, `channel`, `reminder_type`, `notes` | `{ data: reminder }` | `remindersController.create -> remindersService.create` | `clients`, `reminders` | `createReminderSchema` | `400`, `401`, `404` |
| PATCH | `/api/reminders/:id` | Yes | Update reminder; setting status to `sent` also creates activity | param: UUID, body partial reminder fields | `{ data: reminder }` | `remindersController.update -> remindersService.update` | `reminders`, `clients`, `activity_events` | `uuidParamSchema`, `updateReminderSchema` | `400`, `401`, `404` |

### 5.8 Booking Settings / Business Settings

| Method | Path | Auth? | Purpose | Request | Response | Main service/function | Tables touched | Validation | Common errors |
|---|---|---:|---|---|---|---|---|---|---|
| GET | `/api/settings/booking` | Yes | Get stylist public booking settings row; auto-creates if missing | none | `{ data: stylistRow }` | `settingsController.getBooking -> stylistsService.ensureByUserId` | `stylists`, `users` | auth only | `401`, `500` |
| PATCH | `/api/settings/booking` | Yes | Update slug/display name/bio/cover image/booking toggle | body partial stylist settings | `{ data: stylistRow }` | `settingsController.updateBooking -> stylistsService.upsertForUser` | `stylists`, `users` | `updateBookingSettingsSchema` | `400`, `401`, `403`, `409` |
| GET | `/api/settings/availability` | Yes | Get normalized weekly availability schedule and timezone | none | `{ data: { timezone, days } }` where each window includes `clientAudience` | `settingsController.getAvailability -> availabilityService.getWeeklyForUser` | `availability`, `users` | auth only | `401`, `500` |
| PUT | `/api/settings/availability` | Yes | Replace full weekly availability schedule | body: `days[7]` with windows; each window supports `clientAudience=all|new|returning` | `{ data: { timezone, days } }` | `settingsController.replaceAvailability -> availabilityService.replaceWeeklyForUser` | `availability`, `users` | `replaceAvailabilitySchema` | `400`, `401` |
| GET | `/api/settings/booking-rules` | Yes | Get booking rules; auto-creates defaults if missing | none | `{ data: bookingRules }` | `settingsController.getBookingRules -> bookingRulesService.getByUserId` | `booking_rules` | auth only | `401`, `500` |
| PATCH | `/api/settings/booking-rules` | Yes | Update booking rules | body partial booking rules | `{ data: bookingRules }` | `settingsController.updateBookingRules -> bookingRulesService.updateForUser` | `booking_rules`, `services` | `updateBookingRulesSchema` | `400`, `401` |

### 5.9 Public Booking Routes

| Method | Path | Auth? | Purpose | Request | Response | Main service/function | Tables touched | Validation | Common errors |
|---|---|---:|---|---|---|---|---|---|---|
| GET | `/api/public/stylists/:slug` | No | Load public stylist profile | param: slug | `{ data: { id, slug, display_name, bio, cover_photo_url, booking_enabled, business_name, phone_number, timezone } }` | `publicController.getStylist -> stylistsService.getPublicProfileBySlug` | `stylists`, `users` | `slugParamSchema` | `400`, `404` |
| GET | `/api/public/services/:slug` | No | Load public active services for a stylist, filtered by client-specific rules when booking context is supplied, only when online booking is enabled | param: slug, optional query: `booking_context_token` | `{ data: serviceRows[] }` | `publicController.getServices -> servicesService.listActiveByStylistSlug` | `stylists`, `services`, `booking_rules` | `slugParamSchema`, `getPublicServicesSchema` | `400`, `404` |
| GET | `/api/public/availability/:slug` | No | Load raw active weekly availability rows, filtered by client-specific audience rules and only when online booking is enabled | param: slug, optional query: `booking_context_token` | `{ data: availabilityRows[] }` | `publicController.getAvailability -> availabilityService.listActiveByStylistSlug` | `stylists`, `availability` | `slugParamSchema`, `getPublicAvailabilitySchema` | `400`, `404` |
| GET | `/api/public/availability/:slug/slots` | No | Generate bookable slots for one service and date, filtered by client-specific rules when booking context is supplied, only when online booking is enabled | param: slug, query: `service_id`, `date`, optional `booking_context_token` | `{ data: { date, timezone, service, slots[] } }` | `publicController.getAvailabilitySlots -> availabilityService.getBookableSlotsByStylistSlug` | `stylists`, `users`, `services`, `booking_rules`, `availability`, `appointments` | `slugParamSchema`, `getPublicAvailabilitySlotsSchema` | `400`, `404` |
| POST | `/api/public/booking-intake` | No | Match guest to existing client, preview booking behavior, and mint booking context for later service/slot calls | body: `stylist_slug`, `full_name`, `phone`, optional `email` | `{ data: intakeResponse }` | `publicController.createBookingIntake -> publicBookingIntakeService.lookupBookingIntake` | `stylists`, `booking_rules`, `clients`, `services`, `appointments` | `createPublicBookingIntakeSchema` | `400`, `404` |
| POST | `/api/public/bookings` | No | Final public booking create | body: `stylist_slug`, `service_id`, `requested_datetime`, guest info, optional notes | `{ data: confirmation }` | `publicController.createBooking -> publicBookingsService.create` | `stylists`, `users`, `services`, `booking_rules`, `availability`, `clients`, `appointments`, `activity_events` | `createPublicBookingSchema` | `400`, `404`, `409` |

## 6. Public Booking Flow: End-to-End

This is the actual end-to-end public booking flow as implemented in the backend.

1. Client opens stylist booking link
   - Endpoint: none yet; frontend route contains the stylist slug
   - Required data: slug in URL
   - Backend logic: none until frontend calls API
   - Failure cases: invalid or missing slug will fail on later API calls

2. Frontend loads public stylist profile by slug
   - Endpoint: `GET /api/public/stylists/:slug`
   - Backend logic:
     - loads `stylists` row by slug
     - loads `users` row for `business_name`, `phone_number`, `timezone`
   - Failure cases:
     - `404 Stylist not found`
   - Note:
     - profile can be fetched even when `booking_enabled=false`

3. Client enters details
   - Endpoint: `POST /api/public/booking-intake`
   - Required data:
     - `stylist_slug`
     - `full_name`
     - valid phone
     - optional email
   - Backend logic:
     - normalizes phone
     - looks for matching clients under that stylist only
     - returns `matched`, `not_found`, or `ambiguous`
     - returns `bookingContextToken`, a short-lived signed token scoped to this stylist and client-status result
     - may recommend a service based on previous appointment history
   - Failure cases:
     - invalid phone
     - invalid slug
   - Important nuance:
     - this is the intended first step before showing services or slots
     - if the response says `bookingEnabled=false`, the frontend should stop before loading services or slots
     - final booking creation does not trust the token alone; it re-matches the client server-side

4. Frontend loads services
   - Endpoint: `GET /api/public/services/:slug?booking_context_token=...`
   - Backend logic:
     - resolves slug to `stylists.user_id`
     - rejects when `stylists.booking_enabled=false`
     - verifies the booking context token when supplied
     - returns active `services` for that user ordered by `sort_order`, `created_at`, `name`
     - if the token represents a new/unknown client and `restrictServicesForNewClients` is enabled, filters out `restrictedServiceIds`
     - if no token is supplied, falls back to new-client filtering
   - Failure cases:
     - invalid slug
     - `400 Online booking is not enabled for this stylist`
     - `400 Booking context is invalid or expired`

5. Client chooses service
   - Endpoint used next: usually `GET /api/public/availability/:slug/slots`
   - Required data: `service_id`
   - Backend logic:
     - validates that the service exists for that stylist and is active
   - Failure cases:
     - `400 Selected service is not available`

6. Client chooses date/time
   - Endpoint: `GET /api/public/availability/:slug/slots?service_id=...&date=YYYY-MM-DD&booking_context_token=...`
   - Backend logic:
     - rejects when `stylists.booking_enabled=false`
     - resolves business timezone
     - loads weekly availability for the local weekday
     - filters availability windows by `client_audience`, using `all + new` for new clients and `all + returning` for returning clients
     - loads booking rules
     - verifies the booking context token when supplied
     - loads non-cancelled appointments for that local day
     - generates 15-minute candidate starts inside each active window
     - removes candidates that violate current rules or overlap existing appointments
     - applies returning-client vs new-client slot rules based on the token
   - Failure cases:
     - invalid service
     - `400 Online booking is not enabled for this stylist`
     - `400 Booking context is invalid or expired`
     - date with no slots

7. Backend checks/uses availability
   - Final endpoint: `POST /api/public/bookings`
   - Backend logic:
     - re-normalizes requested datetime into the business timezone
     - validates booking rules again
     - confirms requested time still fits active availability windows
     - checks for overlap conflicts
   - Failure cases:
     - `400 Requested time must be in the future`
     - `400 Same-day booking is not allowed`
     - `400 Appointments require at least X hour(s) of notice`
     - `409 Requested time is no longer available`

8. Backend applies booking rules
   - Endpoint: `POST /api/public/bookings`
   - Logic:
     - may set `status="pending"` for new clients if approval is required
     - may block far-future new-client bookings
     - may block restricted services for new clients
   - Failure cases:
     - rules return `400`

9. Client is matched or created
   - Endpoint: `POST /api/public/bookings`
   - Logic:
     - attempts stylist-scoped client match by normalized phone, then raw phone, then email
     - if none found, creates a new client
   - Failure cases:
     - database write errors
   - Nuance:
     - if a duplicate exists and the frontend skipped or ignored intake ambiguity, final booking creation will use the first match returned by the backend

10. Appointment is created
   - Endpoint: `POST /api/public/bookings`
   - Logic:
     - creates appointment with:
       - `client_id`
       - normalized business-timezone `appointment_date`
       - service snapshot fields
       - `status` = `scheduled` or `pending`
       - `booking_source` = `public`
   - Failure cases:
     - overlap conflict
     - exact-start unique index conflict

11. Activity record is created
   - Trigger:
     - `appointmentsService.create` always calls `activityEventsService.recordBookingCreated`
   - Result:
     - inserts `booking_created` into `activity_events`

12. Confirmation screen is shown
   - Endpoint response:
     - `POST /api/public/bookings` returns a confirmation payload including stylist, service, appointment start/end, timezone, and status
   - Failure cases:
     - if conflict occurred and it was not a duplicate submission, client sees error instead of confirmation

13. Future notification hooks
   - Current state:
     - no email or SMS confirmation is sent when public booking is created
   - Best future insertion points:
     - immediately after successful appointment creation
     - or via a queued background job triggered from that event

## 7. Where Public Booking Data Comes From

| Public field | Table/field | API route | Editable in app? | Public-facing? | Notes |
|---|---|---|---|---|---|
| Stylist display name | `stylists.display_name` | `GET /api/public/stylists/:slug` | Yes, `/api/settings/booking` | Yes | Falls back to generated value when stylist row is first bootstrapped |
| Business name | `users.business_name` | `GET /api/public/stylists/:slug` | Yes, `/api/settings/profile` | Yes | Also returned in booking confirmation |
| Profile photo/avatar | no dedicated public avatar field in current public profile | none | `avatar_image_id` exists in code via `/api/settings/profile` | Not currently through public API | Code references avatar internally but public stylist route does not expose it |
| Booking cover image | `stylists.cover_photo_url` | `GET /api/public/stylists/:slug` | Yes, `/api/settings/booking` | Yes | Plain URL string; backend does not transform storage paths |
| Bio/description | `stylists.bio` | `GET /api/public/stylists/:slug` | Yes, `/api/settings/booking` | Yes | Public text |
| Public slug | `stylists.slug` | all public slug routes | Yes, `/api/settings/booking` | Yes | Custom slug is plan-gated |
| Available services | `services` where `user_id=stylist.user_id` and `is_active=true` | `GET /api/public/services/:slug` | Yes, `/api/services` | Yes | Ordered by `sort_order` |
| Service price | `services.price` | `GET /api/public/services/:slug`, slots response, booking confirmation | Yes | Yes | Copied into appointment snapshot |
| Service duration | `services.duration_minutes` | same as above | Yes | Yes | Used for slot generation and overlap checks |
| Business timezone | `users.timezone` resolved through `businessTimeZoneService` | `GET /api/public/stylists/:slug`, slots response, booking confirmation | Yes, `/api/settings/profile` | Indirectly yes | Defaults to `UTC` if missing/invalid |
| Availability/business hours | `availability.day_of_week/start_time/end_time/client_audience` | `GET /api/public/availability/:slug`, `GET /api/public/availability/:slug/slots` | Yes, `/api/settings/availability` | Raw windows and derived slots | Weekly recurring only; `client_audience` supports `all`, `new`, and `returning` |
| Booking policies | `booking_rules.*` | not returned directly to public page in one endpoint | Yes, `/api/settings/booking-rules` | Indirectly | Applied during slot generation and booking create |
| Existing appointments used to block times | `appointments` where non-cancelled and same stylist/day | `GET /api/public/availability/:slug/slots` and `POST /api/public/bookings` | No direct public editing | Indirectly | Blocks overlapping slots |
| Reminder/notification preferences | no public-booking preference object currently | none | not as booking notification settings | No | Only `clients.reminder_consent` and `reminders.channel/type` exist today |

## 8. Client Matching Logic

This is one of the most important parts of the public booking flow. The backend does not treat a person as global across all stylists. Matching is always scoped to the stylist who owns the CRM.

Why matching is stylist-scoped:

- the same guest may legitimately be a client of multiple stylists
- a public booking should create or reuse a client inside one stylist's CRM only
- matching across all stylists would leak data and attach bookings to the wrong business

Actual matching order in `clientsService.findBookingMatches`:

1. Normalize submitted email to lowercase
2. Normalize submitted phone into E.164-like form
3. If normalized phone exists:
   - search `clients where user_id = stylistUserId and phone_normalized = normalizedPhone`
4. If that fails and raw phone exists:
   - search `clients where user_id = stylistUserId and phone = rawPhone`
5. If that fails and email exists:
   - search `clients where user_id = stylistUserId and email = normalizedEmail`
6. Otherwise return no matches

Pseudo-code:

```text
normalize phone
normalize email

if normalized phone exists:
  search clients where user_id = stylist_id and phone_normalized = normalized phone
  if any match:
    return matches

if raw phone exists:
  search clients where user_id = stylist_id and phone = raw phone
  if any match:
    return matches

if email exists:
  search clients where user_id = stylist_id and email = normalized email
  return matches

return []
```

Phone normalization:

- implemented in `src/lib/phone.ts`
- accepts:
  - `+` prefixed international numbers with 10 to 15 digits
  - 10-digit US numbers, converted to `+1XXXXXXXXXX`
  - 11-digit US numbers beginning with `1`
- rejects malformed values

Booking-intake behavior:

- `POST /api/public/booking-intake` can return:
  - `matched`
  - `not_found`
  - `ambiguous`
- `ambiguous` happens when multiple stylist-owned client rows match the submitted identity
- the intake response also computes booking behavior:
  - returning client: direct booking preview
  - new client: new-client rules preview
  - ambiguous: asks frontend to collect more information

What happens if a match is found:

- final booking reuses `client_id`
- no new client row is created
- existing client name/email may be reused in intake response
- intake may recommend a service based on prior appointments

What happens if no match is found:

- `POST /api/public/bookings` creates a new client in that stylist's CRM
- client payload comes from guest name/email/phone
- for new clients only, booking notes are also passed into `clientsService.findOrCreateForBooking`, so the initial `clients.notes` may inherit the public booking notes

Recommended service logic in intake:

- loads active services for the stylist
- loads non-cancelled appointment history for the matched client
- tries in this order:
  1. last completed service name
  2. last booked non-cancelled service name
  3. active default service
- because appointments store only `service_name` text, recommendation depends on a name match to the current active service catalog

Current limitations:

- final `POST /api/public/bookings` does not reject ambiguous duplicates by itself
- it calls `findMatchingForBooking`, which just returns the first match
- if the frontend does not use intake or does not enforce ambiguity resolution, a booking can attach to an arbitrary duplicate client row
- matching by email is exact lowercase text only; there is no fuzzy matching
- matching is not identity-verified; there is no OTP or magic-link proof of phone/email ownership

## 9. Booking Rules & Policies

Current storage location:

- `booking_rules` table
- API:
  - `GET /api/settings/booking-rules`
  - `PATCH /api/settings/booking-rules`

Important distinction:

- Some rules are enforced in backend slot generation and booking creation
- Some rules are stored but not enforced yet
- Some notification/policy ideas in the product brief do not exist in the current schema at all

Rules currently enforced by backend:

| Rule | Stored where | Applied by | Behavior |
|---|---|---|---|
| `leadTimeHours` | `booking_rules.lead_time_hours` | slots endpoint and booking create | blocks times too close to now |
| `sameDayBookingAllowed` | `same_day_booking_allowed` | slots endpoint and booking create | blocks same-day booking entirely when false |
| `sameDayBookingCutoff` | `same_day_booking_cutoff` | slots endpoint and booking create | blocks same-day booking after cutoff |
| `maxBookingWindowDays` | `max_booking_window_days` | slots endpoint and booking create | blocks far-future booking beyond general window |
| `newClientApprovalRequired` | `new_client_approval_required` | booking create only | sets new-client appointments to `pending` |
| `newClientBookingWindowDays` | `new_client_booking_window_days` | slots endpoint and booking create | blocks far-future new-client booking; `0` means unlimited |
| `restrictServicesForNewClients` + `restrictedServiceIds` | `restrict_services_for_new_clients`, `restricted_service_ids` | slots endpoint and booking create | blocks selected services for new clients |

Rules stored but not currently backend-enforced in booking creation or availability:

| Rule | Stored where | Current state |
|---|---|---|
| `cancellationWindowHours` | `cancellation_window_hours` | stored for future cancellation policy; no public cancel endpoint uses it |
| `lateCancellationFeeEnabled` | `late_cancellation_fee_enabled` | stored only |
| `lateCancellationFeeType` | `late_cancellation_fee_type` | stored only |
| `lateCancellationFeeValue` | `late_cancellation_fee_value` | stored only |
| `allowCancellationAfterCutoff` | `allow_cancellation_after_cutoff` | stored only |
| `rescheduleWindowHours` | `reschedule_window_hours` | stored only |
| `maxReschedules` | `max_reschedules` | stored only |
| `sameDayReschedulingAllowed` | `same_day_rescheduling_allowed` | stored only |
| `preserveAppointmentHistory` | `preserve_appointment_history` | stored only |

Rules or settings mentioned in product planning but not present in the current schema/backend:

- email confirmation toggle
- reminder preference for public bookings (`email`, `sms`, `none`) as a booking-rule setting
- separate existing-client rules vs new-client rules beyond the few fields above
- service-level public visibility distinct from active/inactive

Very important implementation nuance:

- `POST /api/public/booking-intake` now returns a short-lived `bookingContextToken`
- `GET /api/public/services/:slug` and `GET /api/public/availability/:slug/slots` verify that token and apply client-specific rules from it
- the token is stylist-scoped and expires quickly; using it with the wrong slug or after expiry returns `400`
- if the frontend does not provide a token, both endpoints intentionally fall back to new-client filtering
- final booking creation still does a fresh server-side client match and rule validation rather than trusting the token alone

When a rule blocks booking:

- slots endpoint silently omits blocked times
- final booking create returns `400` with a message such as:
  - `"Appointments require at least X hour(s) of notice"`
  - `"Same-day booking is not allowed"`
  - `"The same-day booking cutoff has passed"`
  - `"Appointments can only be booked up to X day(s) in advance"`
  - `"New clients can only book up to X day(s) in advance"`
  - `"This service is not available for new clients online"`

## 10. Availability Calculation

Available public times are generated by `availabilityService.getBookableSlotsByStylistSlug`.

Inputs:

- stylist slug
- service id
- target local date (`YYYY-MM-DD`)

Data loaded:

- stylist row -> `user_id`
- business timezone from `users.timezone`
- active service row
- booking rules row
- active availability windows for the target weekday
- existing non-cancelled appointments for that local date

Slot algorithm:

```text
load stylist
load business timezone
load service and duration
load booking rules
load active availability windows for local weekday
load non-cancelled appointments for the local day

for each availability window:
  for each 15-minute candidate start within the window:
    convert local candidate start to UTC
    skip if duplicate start was already produced
    skip if candidate is in the past
    skip if same-day booking is disallowed
    skip if same-day cutoff has passed
    skip if beyond max booking window
    skip if before lead-time threshold
    treat guest as new client for slot filtering
    skip if restricted service / new-client window rules block it
    skip if overlapping any non-cancelled appointment
    add slot

return slots grouped in one payload for the requested date
```

What counts as availability:

- only active weekly windows in `availability`
- no holidays, time-off blocks, lunch blocks, or exceptions model
- no Google Calendar sync

Timezone handling:

- weekday is computed in the stylist business timezone
- candidate times are created as local business times and converted to UTC
- returned slot strings include the business offset for that instant
- DST transitions are handled:
  - nonexistent local times on spring-forward days are skipped
  - duplicate fallback-hour starts are deduped

Appointment statuses that block availability:

- every non-cancelled appointment blocks time
- in practice this includes:
  - `pending`
  - `scheduled`
  - `completed`
  - `no_show`

Appointment statuses that do not block:

- `cancelled` only

Slot granularity:

- 15-minute interval

Lead time and max window:

- both are enforced in slots and final booking creation

Days with no availability:

- if no active windows exist for the local weekday, the response returns an empty `slots` array

How blocked/booked times are excluded:

- overlap is checked by comparing candidate start/end against every existing appointment's start/end

How available slots are returned:

- response shape:
  - `date`
  - `timezone`
  - `service { id, name, duration_minutes, price }`
  - `slots [{ start, end }]`

How "Next available" would be derived:

- there is no dedicated next-available endpoint
- a frontend would need to call the slots endpoint across dates until it finds the first non-empty response

## 11. Appointment Creation Logic

### Public booking creation

Endpoint:

- `POST /api/public/bookings`

Required request body:

- `stylist_slug`
- `service_id`
- `requested_datetime`
- `guest_first_name`
- `guest_last_name`
- `guest_phone`
- optional `guest_email`
- optional `notes`

Actual creation steps:

1. Load stylist by slug
2. Reject if `booking_enabled=false`
3. Load active service for that stylist
4. Resolve business timezone
5. Normalize submitted datetime into business-local intended time
6. Normalize phone and email
7. Attempt stylist-scoped client match
8. Decide whether client is existing
9. Enforce booking rules
10. Confirm requested time fits active availability windows
11. Reuse matched client or create a new one
12. Create appointment with `booking_source="public"`
13. Auto-create `booking_created` activity event
14. Return confirmation payload

Public appointment fields created:

- `user_id`
- `client_id`
- `appointment_date`
- `service_name`
- `duration_minutes`
- `price`
- `notes`
- `status`
- `booking_source = "public"`

Appointment status assigned:

- `scheduled` by default
- `pending` if `newClientApprovalRequired=true` and no existing client match

Timezone handling:

- the backend intentionally reconstructs the submitted `requested_datetime` from the local date/time components using the stylist's business timezone
- this corrects stale client offsets, especially around DST
- it also means the backend treats the submitted clock time as "business local intent"

### Authenticated/internal appointment creation

Endpoint:

- `POST /api/appointments`

Differences from public create:

- requires auth
- requires existing `client_id`
- ignores public booking rules
- defaults `booking_source` to `internal`
- only enforces ownership and overlap/conflict checks

### Overlap and double-booking protection

Current protection:

- `appointmentsService.hasSlotConflict` checks overlap against all non-cancelled appointments
- `appointmentsService.create` checks again before insert
- there is also a DB unique index on exact same `user_id + appointment_date` for non-cancelled appointments

Direct answer to "Can two people book the same time at once?":

- Usually no in single-request conditions, because the API checks overlap and the DB blocks exact same start times
- But not perfectly, because the overlap check is not transactional
- Two concurrent requests for overlapping but not identical start times could potentially pass the read check before either insert commits
- The DB unique index only guarantees exact identical start-time prevention, not general overlap prevention

Recommended improvement:

- move conflict enforcement into a transaction or database-level exclusion strategy so overlap checks are atomic

Idempotency behavior:

- if the same guest re-submits the same public booking and the first request already created it, the backend tries to find a matching existing public appointment and return the same confirmation
- this only applies when the duplicate submission matches the same client, same datetime, same service name, same duration, and `booking_source="public"`

## 12. Activity Feed Logic

Activity is stored in `activity_events` and exposed through:

- `GET /api/activity`
- `GET /api/appointments/:id/activity`

Current event type enum:

- `booking_created`
- `appointment_cancelled`
- `appointment_rescheduled`
- `reminder_sent`

What creates activity records:

- appointment creation -> `booking_created`
- appointment updated from non-cancelled to `cancelled` -> `appointment_cancelled`
- appointment time or duration changed while still non-cancelled -> `appointment_rescheduled`
- reminder updated to `status="sent"` -> `reminder_sent`

How creation works:

- `appointmentsService.create` calls `activityEventsService.recordBookingCreated`
- `appointmentsService.update` calls cancel/reschedule recorders when conditions are met
- `remindersService.update` calls `recordReminderSent` when final status is `sent`

Payload format:

- every event stores:
  - `activity_type`
  - `title`
  - `description`
  - `occurred_at`
  - `client_id`
  - `appointment_id`
  - typed `metadata`
  - `dedupe_key`

Examples of metadata:

- `booking_created`
  - `client_name`
  - `service_name`
  - `appointment_start_time`
- `appointment_cancelled`
  - previous fields plus `cancelled_by`
- `appointment_rescheduled`
  - `old_start_time`
  - `new_start_time`
- `reminder_sent`
  - `client_name`
  - `channel`
  - `reminder_type`
  - `appointment_start_time`

How activity is filtered and returned:

- `GET /api/activity`
  - optional filters: `activity_type`, `start_date`, `end_date`
  - cursor pagination by `(occurred_at, id)`
  - grouped server-side by business-local day label
- `GET /api/appointments/:id/activity`
  - returns reverse chronological events for one appointment

Legacy handling:

- migration `202605010001_activity_type_contract_cleanup.sql` rewrites legacy `appointment_created` records to `booking_created`

Dedupe behavior:

- `dedupe_key` is unique per stylist
- reminder retries do not create duplicate `reminder_sent` feed items

## 13. Notifications: Current State & Future Hooks

Current state:

- Booking confirmation emails/SMS are not sent by the backend today
- Reminder records exist
- Reminder activity exists
- Plan entitlements include email/SMS-related feature flags
- But there is no job queue, no provider integration, and no booking-created notification sender in this repo

What notification-related data exists today:

- `clients.reminder_consent`
- `reminders.channel` (`sms` or `email`)
- `reminders.reminder_type`
- `reminders.sent_at`
- account entitlements for `emailReminders` and `smsReminders`

What does not currently exist as booking settings:

- email confirmation on/off setting
- booking reminder preference setting (`email`, `sms`, `none`) at booking-rule level
- a durable notification status table

Where future hooks should plug in:

```text
Appointment created
   ↓
Create activity record
   ↓
Queue notification job
   ↓
Send email/SMS
   ↓
Update notification/activity status
```

Recommended insertion points:

- after successful `appointmentsService.create`
- after public booking confirmation is assembled
- after reminder transitions to `sent`

Recommended future architecture:

- keep appointment creation synchronous
- publish a background job/event after commit
- let a worker send email/SMS
- write send outcome back to reminders/notifications/activity

## 14. Error Handling & Validation

Validation:

- request parsing uses Zod schemas in `src/validators/*`
- route middleware `validate()` parses `body`, `params`, and `query`
- on failure it wraps the error as `ApiError(400, "Validation failed", error)`

Response error shape:

```json
{
  "error": {
    "message": "Validation failed",
    "details": "..."
  }
}
```

Practical response behavior:

- Zod failures inside `validate()` return `400` with `error.message = "Validation failed"`
- `ApiError` responses include details outside production
- unhandled errors become `500 Internal server error`

Common error categories:

- `400`
  - bad slug/date/UUID/payload
  - invalid phone number
  - booking rule violation
  - approving a non-pending appointment
- `401`
  - missing bearer token
  - malformed auth header
  - invalid or expired JWT
- `403`
  - plan-gated feature such as custom cover photo or custom slug
- `404`
  - client, appointment, stylist, or user not found
- `409`
  - time slot conflict
  - public booking time no longer available

Examples seen in code/tests:

```json
{
  "error": {
    "message": "Requested time is no longer available"
  }
}
```

```json
{
  "error": {
    "message": "Malformed authorization header"
  }
}
```

## 15. Timezone Handling

Where timezone is stored:

- `users.timezone`

Fallback behavior:

- `resolveBusinessTimeZone()` returns `UTC` if the value is missing or invalid

How "today" is calculated:

- using business-local date helpers in `src/lib/timezone.ts`
- many services call `getCurrentLocalDate(timeZone)`

How appointment times are stored:

- as UTC ISO timestamps in `appointments.appointment_date`

How appointment times are displayed:

- converted back to business-local strings using helpers like `formatInstantInTimeZoneOffset()` and `formatDateInTimeZone()`

How public booking page uses timezone:

- `GET /api/public/stylists/:slug` returns `timezone`
- slots response returns `timezone` and slot timestamps with local offset
- booking confirmation returns `business_timezone`

Important public-booking nuance:

- submitted `requested_datetime` is normalized to the business timezone by reinterpreting the local clock components, not by trusting the incoming offset blindly

Known risks:

- missing timezone silently becomes `UTC`, which can hide setup mistakes
- slot generation endpoint cannot personalize "existing client" logic because it has no identity input
- if frontend assumptions about timezone differ from backend assumptions, users may see confusing local-to-business conversions

## 16. Frontend Data Flow Summary

### Mobile App

Dashboard:

1. `GET /api/dashboard`
2. `GET /api/client-actions`
3. optionally `GET /api/activity`

Clients:

1. `GET /api/clients`
2. `GET /api/clients/:id`
3. `GET /api/clients/:id/appointments`
4. `GET /api/clients/:id/photos`
5. `POST /api/clients` / `PATCH /api/clients/:id` / `DELETE /api/clients/:id`

Calendar:

1. `GET /api/calendar?date=YYYY-MM-DD`
2. `GET /api/appointments/internal-context?...` for internal scheduling suggestions
3. `POST /api/appointments`
4. `PATCH /api/appointments/:id`
5. `GET /api/appointments/:id/activity`

Activity:

1. `GET /api/activity`
2. `GET /api/appointments/:id/activity`

Profile/settings:

1. `GET /me`
2. `GET /api/settings/profile`
3. `PATCH /api/settings/profile`
4. `GET /api/settings/booking`
5. `PATCH /api/settings/booking`
6. `GET /api/settings/availability`
7. `PUT /api/settings/availability`
8. `GET /api/settings/booking-rules`
9. `PATCH /api/settings/booking-rules`
10. `GET /api/profile/overview`
11. `GET /api/account/plan`
12. `PATCH /api/account/plan`

### Public Booking Web App

Load stylist:

1. `GET /api/public/stylists/:slug`

Load services:

1. `GET /api/public/services/:slug`

Submit client details:

1. `POST /api/public/booking-intake`

Load/select availability:

1. `GET /api/public/availability/:slug/slots?service_id=...&date=YYYY-MM-DD`

Confirm booking:

1. `POST /api/public/bookings`

Optional raw-data endpoints:

- `GET /api/public/availability/:slug` if frontend wants raw weekly windows

## 17. Known Gaps / Risks / Technical Debt

- Double-booking protection is not transactional. The overlap check is app-level, while the DB unique index only protects exact same start times.
- Public services and slots depend on the frontend using `POST /api/public/booking-intake` first and passing `booking_context_token` afterward; without that token, the backend falls back to new-client filtering.
- Final public booking creation does not reject ambiguous duplicate-client matches by itself; it can attach to the first matched client row.
- Appointments store service snapshots but no `service_id`, which makes some downstream linkage and analytics harder.
- Public booking read routes now reject when `booking_enabled=false`, so the frontend must treat that as a disabled-booking state rather than a no-services state.
- The checked-in `schema.sql` appears behind the code for some `users` columns used by settings/profile/entitlements.
- Client list responses are not the same as client detail responses. `GET /api/clients` selects only a subset of columns and fills several optional CRM fields as `null`.
- There is no exception/blackout/holiday availability model.
- There is no guest identity verification by OTP or magic link.
- There is no notification sending on booking create.
- There is no payment integration.
- There is no Google Calendar sync source of truth.
- Supabase Storage integration is incomplete; photo upload is metadata-only.
- Response contracts are inconsistent across endpoints:
  - some return raw DB rows
  - some return transformed frontend-friendly objects
  - public and authenticated service responses differ

## 18. Recommended Next Improvements

P0:

- Enforce overlap protection atomically at the database or transaction level.
- Make `POST /api/public/bookings` explicitly detect and reject ambiguous duplicate-client matches unless the frontend supplies a resolved client identity.
- Reconcile checked-in schema files with the columns the code already expects.

P1:

- Add booking confirmation email/SMS sending after appointment creation.
- Add reminder job queue and delivery status tracking.
- Add availability exceptions/time-off/holiday support.
- Standardize API response shapes across raw-row and transformed endpoints.
- Add stronger public booking validation around stale client duplicates and guest verification.

P2:

- Add Google Calendar sync.
- Add payment/deposit support for online booking.
- Add better duplicate-client merge/resolution workflows.
- Add audit logging beyond the current activity feed.
- Add team/staff booking support if multi-provider scheduling is planned.

## 19. Glossary

- Stylist: the authenticated business owner using the CRM; represented mainly by `users` plus `stylists`
- Client: a stylist-owned CRM contact/customer record
- Public booking page: the unauthenticated booking experience loaded by stylist slug
- Service: a bookable catalog item with duration, price, and active visibility
- Appointment: a scheduled, pending, completed, cancelled, or no-show booking record
- Availability: recurring weekly open windows that define when online booking may occur
- Booking rule: a setting that constrains public booking timing or new-client behavior
- Activity event: a system-created timeline entry describing a business action
- Reminder preference: not a single current booking setting; today it is represented indirectly through client consent and reminder channel/type fields
- Booking source: whether an appointment came from `public` booking or `internal` creation
- Lead time: minimum notice required before a public booking can start
- Timezone: the business-local IANA timezone stored on the user and used for dates, slots, and activity grouping

## Verification Notes

These items are reasonable based on the repository, but they are not fully provable from code alone and should be manually confirmed in the live environment or companion frontend repos.

- Live database schema versus checked-in schema:
  - The spec calls out a mismatch between `supabase/schema.sql` and fields used by code such as `users.location_label`, `users.avatar_image_id`, `users.plan_tier`, `users.plan_status`, `users.sms_monthly_limit`, and `users.sms_used_this_month`.
  - This is directly observable in the repo, but it should be confirmed whether production already has these columns through migrations not checked in here.

- Live RLS policies:
  - The spec says only an `activity_events` select policy is present in the checked-in schema.
  - That is true for this repo, but it does not prove the deployed Supabase project has no additional policies configured manually or from missing migrations.

- Deployment topology outside this repo:
  - The spec references Railway for the API and notes that a separate public web app is implied by `WEB_APP_URL`.
  - Railway is supported by `railway.json`, but the existence, hosting platform, and behavior of the public booking frontend should be confirmed in the frontend repo or deployment settings.

- Public booking frontend sequence:
  - The spec describes `POST /api/public/booking-intake` as an advisory step before slot selection or final booking.
  - That is accurate from the backend contract, but it should be manually confirmed whether the current frontend always uses intake, optionally uses it, or bypasses it.

- Intake-token usage in real UX:
  - The backend now expects the frontend to call `POST /api/public/booking-intake` before loading services or slots and to pass the returned `booking_context_token` into those follow-up requests.
  - What should be confirmed is whether the current frontend will always follow that sequence or whether there are entry points that still skip intake and therefore fall back to new-client filtering.

- Double-booking risk severity:
  - The spec states overlap protection is not transactional and exact-start uniqueness is the only database-level safeguard in this repo.
  - That is code-supported, but the practical risk level should be verified with real concurrent booking tests against the production database.

- Public route gating expectations:
  - `GET /api/public/stylists/:slug` and `POST /api/public/booking-intake` remain readable when booking is disabled so the frontend can render the right state.
  - `GET /api/public/services/:slug`, `GET /api/public/availability/:slug`, `GET /api/public/availability/:slug/slots`, and `POST /api/public/bookings` now reject when `booking_enabled=false`.

- Notification capabilities outside this API:
  - The spec says there is no booking-created email/SMS sending, no job queue, and no provider integration in this repo.
  - That is accurate for this codebase, but it should be confirmed whether notifications are handled by a separate service, automation platform, or another repository.

- Storage/media handling outside this API:
  - The spec says photo upload is metadata-only and `cover_photo_url` is treated as a plain URL string.
  - That is supported by code here, but it should be confirmed whether another service or frontend layer is responsible for generating public URLs, signed URLs, or uploading to Supabase Storage.

- Product-direction language:
  - Phrases such as "CRM-first direction" are strongly suggested by the route design and README, but they are still a product interpretation rather than a hard backend invariant.
  - This should be confirmed with the founder or product owner if the document will be used as a source-of-truth product artifact.

## Open Questions

- Should `POST /api/public/bookings` hard-reject ambiguous duplicate matches instead of picking the first match?
- Should the web app require fresh re-intake whenever the guest edits phone/email after services have already loaded?
- Are `users.location_label`, `users.avatar_image_id`, `users.plan_tier`, and related plan fields expected to be added by future migrations, or is the checked-in base schema outdated?
- Should reminder/confirmation preferences live in `booking_rules`, in a separate notifications settings table, or per client?
- Should reminders be sent by email, SMS, or both by default for public bookings?
- Is payment/deposit collection planned before broader public rollout?
- Should Google Calendar eventually become a secondary sync target or a source of truth for availability?
- Is staff/team scheduling in scope later, or should the data model stay strictly single-stylist?
