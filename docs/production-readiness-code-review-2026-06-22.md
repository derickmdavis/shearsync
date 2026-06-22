# Production Readiness Code Review

Review date: 2026-06-22

Scope reviewed: Express app entry points, auth and error middleware, public booking and appointment management flows, appointment conflict handling, client/dashboard/profile services, email queue worker, Supabase schema and migrations, tests, build/typecheck, deployment config, and dependency audit.

## Executive Summary

ShearSync API is close to a production-minded MVP, but I would not yet open it to unsupervised real customer traffic without a short hardening sprint. The core product logic is much stronger than a prototype: validation is centralized, most data access is scoped by `user_id`, there is meaningful automated test coverage, public booking is revalidated server-side, email sending has idempotency and retry mechanics, and the app fails fast when part of the schema is missing.

My readiness estimate: **70-75% ready for real customers**.

Recommended launch posture:

- **Not ready for broad launch today.**
- **Reasonable for private beta with trusted stylists** if traffic is low, support is hands-on, and the known risks below are accepted.
- **Ready for paid/public customers after addressing the P0/P1 list**, especially database overlap constraints, rate limiting, observability, dependency vulnerabilities, and production migration verification.

The biggest theme is operational hardening, not missing business logic. The app has the right shape, but public unauthenticated endpoints plus service-role backend access mean correctness, throttling, logging, and DB-level constraints need to carry a lot of safety.

## What Is Working Well

1. **Clear Express structure**
   - `src/app.ts` applies security headers with `helmet`, CORS, JSON/body limits, logging, routes, 404 handling, and a centralized error handler.
   - `src/server.ts` blocks startup if schema readiness fails.
   - Routes are separated by feature and most controllers are thin wrappers over services.

2. **Production auth defaults**
   - `AUTH_MODE` defaults to production.
   - Production rejects `AUTH_MODE=dev`.
   - Dev auth fallback is explicit and gated by `ENABLE_DEV_AUTH_FALLBACK`.
   - Auth logs are suppressed in production except normal request logs.

3. **Good validation coverage**
   - Zod validators protect route params, query strings, and request bodies.
   - Public booking phone/email/date inputs are bounded and normalized.
   - JSON body size is capped at `1mb`.

4. **Booking rules are enforced server-side**
   - Public booking does not trust frontend availability.
   - It re-checks stylist, service, booking rules, availability, off-days, client status, and appointment conflicts before creating.
   - Public reschedule paths also call scheduling policy evaluation.

5. **Tests are meaningful**
   - `npm run typecheck` passes.
   - `npm test` passes: 290 tests, 19 suites.
   - Coverage includes appointment conflicts, DST slot behavior, public booking referrals, images, account deletion, email delivery, activity feeds, waitlist, and auth behavior.

6. **Email queue is thoughtfully designed**
   - Appointment email events use idempotency keys.
   - Processing claims queued records before sending.
   - Retry limits and stale `sending` recovery exist.
   - Communication preferences and global unsubscribes are checked before sending.
   - Email telemetry is recorded.

7. **Schema has many useful indexes**
   - Clients list/search/sort paths are indexed.
   - Appointment date queries are indexed.
   - Email queues, activity feed, waitlist, images, communication events, and automation queues have purpose-built indexes.

## Launch Blockers

### P0: Appointment overlap protection appears to be only application-level

`src/services/appointmentsService.ts` checks conflicts before writes and catches database errors for constraint names like `appointments_user_active_time_no_overlap`. The schema and migrations I found create a GiST index on `appointment_time_range`, but I did not find an actual exclusion constraint that prevents overlapping active appointments.

Why this matters:

- Two public booking requests can pass the pre-insert conflict query at the same time.
- Without a DB-level exclusion constraint or transactional lock, both can insert overlapping appointments.
- The code is prepared to catch a DB overlap violation, but the checked-in DB does not appear to enforce it.

Relevant code:

- `appointmentsService.create` performs app-level conflict check before insert.
- `appointmentsService.listSlotConflicts` queries a bounded window and filters overlaps in Node.
- `supabase/schema.sql` has `appointments_time_range_gist_idx`, but no `exclude using gist` constraint.

Recommended fix:

- Add `btree_gist` extension if needed.
- Add an exclusion constraint like:

```sql
alter table public.appointments
  add constraint appointments_user_active_time_no_overlap
  exclude using gist (
    user_id with =,
    appointment_time_range with &&
  )
  where (status <> 'cancelled');
```

- Backfill `appointment_time_range` for all existing rows first.
- Add migration tests or a production verification query that confirms the constraint exists.

### P0: Public endpoints have no rate limiting or abuse controls

Unauthenticated endpoints include public stylist lookup, services, availability slots, booking intake, booking creation, waitlist creation, referral resolution, early access, reference photo upload intents/finalize, and appointment manage links.

Risk:

- Availability slot generation can be repeatedly called and is CPU/DB expensive.
- Booking intake can be used for client enumeration unless responses are carefully generic.
- Short appointment action links can be brute-forced over time.
- Early access and waitlist endpoints can be spammed.
- Reference photo upload intent/finalize can pressure Supabase Storage and DB.

Recommended fix:

- Add IP and route-family rate limits.
- Use stricter limits for mutation endpoints.
- Add bot/abuse telemetry for public routes.
- Consider per-stylist public endpoint quotas.
- Return uniform error messages on invalid/expired manage links.

### P0: Dependency audit has actionable vulnerabilities

`npm audit --audit-level=moderate` found 5 advisories:

- `ws`: high severity memory disclosure / memory exhaustion DoS.
- `qs` via `express` / `body-parser`: moderate remotely triggerable DoS.
- `esbuild`: moderate/low dev-server issue.

Recommended fix:

- Run `npm audit fix`.
- Re-run typecheck/tests.
- Verify Express/body-parser update does not change request parsing behavior.
- Treat this as required before production launch.

### P1: Schema readiness check only verifies users and clients columns

`schemaReadinessService.assertReady()` checks required columns for `users` and `clients`, but the API now depends on many newer tables/columns: appointment images, appointment action links, appointment email events, rebook nudges, birthday reminders, waitlist entries, booking rules cutoff, communication preferences, and storage bucket setup.

Risk:

- App can start with a partially migrated database and fail at runtime on customer actions.
- README says required schema version is through `202606160001_client_soft_delete_retention`, but the repo includes later migrations such as `202606210002_appointment_action_links`.

Recommended fix:

- Track a real schema migration version table.
- On startup, assert all required launch-era migrations are applied.
- Include existence checks for critical tables, constraints, indexes, and storage buckets.
- Specifically assert the appointment overlap constraint exists.

### P1: Observability is too thin for production support

Current logging is mostly `morgan`, startup errors, and selected `console.warn` paths. There is no request ID, structured logging, latency histogram, queue processing metrics, route-level error rates, or alerting integration visible in the repo.

Risk:

- Hard to diagnose slow bookings, email delivery stalls, Supabase latency, or customer-specific failures.
- Public endpoint abuse may not be visible until Supabase costs or error reports spike.

Recommended fix:

- Add request IDs and structured logs.
- Log route, method, status, latency, user ID when authenticated, public slug when safe, and error code.
- Track Supabase query failure count, email queue lag, pending email count, failed email count, public booking success/failure count, and availability latency.
- Add alerts for 5xx rate, email backlog, failed job count, and slow public booking responses.

## Performance And Speed Review

### Public slot generation is the hottest path

`availabilityService.getBookableSlotsByStylistSlug` loads stylist, timezone, service, booking rules, off-day status, windows, and same-day appointments. It then loops through every 15-minute candidate inside availability windows and awaits `schedulingPolicyService.evaluateRequestedSlot` for each candidate.

The good news:

- Existing appointments and windows can be passed into evaluation, so it avoids one DB query per candidate in this path.
- Candidate count per day is naturally bounded by business hours.
- DST behavior is tested.

The concern:

- It is still sequential async evaluation for every candidate.
- Each candidate recalculates several time/rule checks.
- For high traffic, public slot views can become one of the first latency/cost problems.

Recommended improvement:

- Split slot evaluation into a pure in-memory batch function for already-loaded day state.
- Compute invariant policy facts once per request.
- Add a lightweight in-memory or CDN-compatible cache for low-risk reads like stylist profile/services/availability windows, but keep slots `no-store` or very short TTL because they reflect live inventory.
- Add response-time tests or a synthetic load test for 1, 10, 50, and 100 simultaneous slot requests.

### Dashboard and activity dashboard are high fanout

`dashboardService.getSummary` runs 8 Supabase queries in parallel. `activityDashboardService.getDashboard` runs many more feature-specific queries in parallel, then additional automation health/impact queries.

This is acceptable for low traffic, but it will become noisy with real customers opening the app frequently.

Recommended improvement:

- Measure p50/p95/p99 latency per dashboard route before optimizing.
- Add per-route query count logging in development/staging.
- Consider materialized summary tables or RPCs for high-cardinality metrics after usage patterns are known.
- Split dashboard endpoints if the frontend does not need every panel on first paint.

### Clients list is better than expected, with one scaling caveat

`clientsService.list` paginates client rows and enriches only the page with appointment metadata. That is a good design.

Caveat:

- For each page, it loads all non-cancelled appointments for those client IDs. A stylist with very appointment-heavy clients could pull more rows than necessary.

Recommended improvement:

- If this gets slow, replace enrichment with SQL queries for next appointment and last service per client.
- Consider a denormalized client summary table after customer volume justifies it.

### Email processing is stable but throughput-limited

The email worker processes claimed events sequentially. This is safest for MVP and avoids provider bursts, but throughput is bounded by one send at a time per worker run.

Recommended improvement:

- Keep sequential sending for beta.
- Add queue lag metrics first.
- Later add bounded concurrency, provider-specific rate limits, and exponential backoff fields.

## Stability Review

### Strong areas

- Startup fails on some schema drift.
- Public booking catches write conflicts and attempts idempotent recovery for duplicate public submissions.
- Email sends are claimed before delivery, and stale sends can be retried.
- Appointment reminders verify appointment freshness before sending.
- Image upload/finalize validates content type, file size, dimensions, and storage paths.
- Account deletion has idempotent request creation and internal secret protection.

### Main stability gaps

1. **No global async crash handling**
   - `start().catch` handles startup.
   - I did not see process-level handlers for `unhandledRejection` or `uncaughtException`.
   - Add crash logging and rely on Railway restart after fatal errors.

2. **No request timeout policy**
   - Express does not enforce route timeouts.
   - Supabase/provider calls can stall user requests.
   - Add upstream timeout strategy where possible and monitor slow requests.

3. **No graceful shutdown**
   - Railway can stop/restart containers.
   - Add SIGTERM handling so the server stops accepting requests and exits cleanly.

4. **Background work depends on external scheduling**
   - `process:appointment-emails` exists, but production scheduling is not shown in repo.
   - Confirm Railway cron or another scheduler invokes it at the right cadence.
   - Add monitoring for missed runs.

5. **Service role requires discipline**
   - Backend service-role access is valid for this architecture, but every query must scope by `user_id`.
   - Most reviewed service paths do this, but production readiness needs an explicit audit because RLS is bypassed by service role.

## Security Review

### Good

- CORS allowlist is configurable.
- Helmet is enabled.
- Auth uses Supabase JWT claims and production-safe defaults.
- Public JWT-like tokens are signed, typed, issued with audience/issuer, and validated.
- Public booking context tokens expire after 30 minutes.
- Email unsubscribe tokens are hashed according to tests.
- Image storage paths are server-generated and verified.

### Needs improvement before launch

1. **Rate limiting**
   - Required for public endpoints and auth-protected mutation endpoints.

2. **Dependency updates**
   - Required because audit found high/moderate advisories.

3. **RLS/policy completeness**
   - `supabase/schema.sql` enables RLS for many tables, but visible policies in the schema snapshot are concentrated on newer tables.
   - The README says RLS policies should be added before production traffic.
   - If browser/mobile direct Supabase access is not used, this is defense-in-depth rather than the primary boundary, but it still matters.

4. **Public manage links**
   - Short codes are 10 characters from a random alphabet and backed by a unique index, which is probably adequate entropy for normal use.
   - They can live for 90 days or 30 days after appointment, whichever is later.
   - Add rate limiting, access logs, optional revocation after cancellation, and maybe shorter expiry for action-capable links.

5. **CORS behavior with empty allowed origins**
   - If `CLIENT_APP_URL` and `WEB_APP_URL` are both unset, the app allows all origins.
   - That is helpful locally but risky in production.
   - Add a production env guard requiring at least one allowed origin.

## Data And Migration Readiness

The database is doing a lot of real work: constraints, indexes, RLS, queue idempotency, image limits, soft delete retention, and communication preference uniqueness.

Before production:

- Apply all migrations to a fresh database and run tests/smokes against it.
- Apply all migrations to a copy of production-like data and verify no failures.
- Confirm required extensions: `pg_trgm`, `pgcrypto`, likely `btree_gist` if adding overlap exclusion.
- Confirm Supabase Storage bucket `appointment-images` exists, is private, and has intended MIME/size limits.
- Confirm all policies and grants match the intended backend-only/direct-client access model.
- Confirm old rows have `appointment_time_range` populated.

## Prioritized Improvement List

### P0: Must fix before real customers

1. Add DB-level active appointment overlap exclusion constraint.
2. Add public and authenticated rate limiting.
3. Run `npm audit fix`, retest, and commit lockfile updates.
4. Expand schema readiness to cover all launch-critical migrations, tables, columns, constraints, indexes, and storage bucket.
5. Add production observability: request IDs, structured logs, latency, error counts, email queue health, and alerts.

### P1: Strongly recommended before paid/broad beta

1. Add production CORS guard requiring configured origins.
2. Add graceful shutdown and process-level fatal error logging.
3. Add route timeout/slow request monitoring.
4. Load test public availability, public booking create, dashboard summary, and activity dashboard.
5. Audit every service-role query for `user_id` scoping and direct-object access.
6. Verify all RLS policies are complete or document that RLS is defense-in-depth only.
7. Add integration smoke tests against a real Supabase staging project.

### P2: Important soon after launch

1. Batch/optimize public slot generation.
2. Reduce dashboard fanout or split first-paint dashboard data from secondary panels.
3. Add queue worker concurrency controls and exponential backoff.
4. Add denormalized metrics/client summary tables if dashboard and clients list become slow.
5. Add admin/support tooling for viewing booking failures, email failures, and account deletion state.

### P3: Product/maintenance improvements

1. Replace broad `select("*")` calls in some services with narrow selects.
2. Add more comments around public token/link lifecycle.
3. Document production runbooks for email processing, failed migrations, Supabase outage, and high public traffic.
4. Add contract tests for frontend handoff docs that are most likely to drift.

## Suggested Launch Plan

1. **Hardening sprint**
   - Fix P0 items.
   - Retest.
   - Run staging migration from empty DB and production-like DB.

2. **Private beta**
   - 3-5 trusted stylists.
   - Watch public booking latency, booking conflicts, email queue lag, 4xx/5xx rates, and support tickets daily.
   - Keep support/manual correction path ready.

3. **Expanded beta**
   - 20-50 stylists after 1-2 clean weeks.
   - Add load tests based on real route usage.
   - Start optimizing dashboard/availability only where metrics prove pressure.

4. **General launch**
   - Only after no double-booking reports, email queue is healthy, error rate is low, and dependency/security audit is clean.

## Bottom Line

The backend is credible and thoughtfully built for an MVP. It has real tests, real validation, real booking policy logic, and reasonable data modeling. The main thing standing between this and real customer readiness is production hardening: DB-enforced conflict safety, rate limits, observability, migration confidence, and dependency cleanup.

If the team fixes the P0 list, I would be comfortable moving to a limited real-customer beta. For a larger paid launch, I would also want the P1 items complete and at least one staging load test pass.
