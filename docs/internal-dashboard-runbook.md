# Internal Usage And Health Dashboard Runbook

Created: 2026-06-24

This runbook verifies the backend-only internal usage and health dashboard implementation. It assumes the required Supabase SQL changes already exist in the target environment.

## Environment

Set `APP_ENV` explicitly per deployment:

- local/dev: `development`
- automated tests: `test`
- staging: `staging`
- production: `production`

The backend falls back to `NODE_ENV` when `APP_ENV` is omitted, but explicit `APP_ENV` makes dashboard filtering safer.

Useful env values:

- `APP_ENV=staging`
- `API_REQUEST_LOG_RETENTION_DAYS=30`
- `INTERNAL_API_SECRET=<secret>` for internal cleanup endpoints

## SQL Contract

Verify the required tables exist:

```sql
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in (
    'admin_users',
    'product_events',
    'notification_events',
    'job_runs',
    'api_request_logs',
    'booking_error_events',
    'admin_account_notes'
  )
order by table_name;
```

Verify guardrail columns:

```sql
select table_name, column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and (
    (table_name in ('product_events', 'notification_events', 'job_runs', 'api_request_logs', 'booking_error_events')
      and column_name = 'environment')
    or (table_name = 'product_events' and column_name in ('dedupe_key', 'metadata'))
    or (table_name = 'booking_error_events' and column_name = 'severity')
    or (table_name = 'api_request_logs' and column_name in ('severity', 'created_at'))
  )
order by table_name, column_name;
```

Verify product-event dedupe support:

```sql
select indexname, indexdef
from pg_indexes
where schemaname = 'public'
  and tablename = 'product_events'
  and indexdef ilike '%dedupe_key%';
```

## Enable An Admin

Admin endpoints require a normal authenticated user whose email appears in `admin_users`.

```sql
insert into public.admin_users (email, is_active)
values ('admin@example.com', true)
on conflict (email)
do update set is_active = excluded.is_active;
```

Deactivate access:

```sql
update public.admin_users
set is_active = false
where email = 'admin@example.com';
```

## Telemetry Checks

Product events by environment:

```sql
select environment, event_type, count(*) as events
from public.product_events
where created_at >= now() - interval '24 hours'
group by environment, event_type
order by events desc;
```

Product event dedupe check:

```sql
select environment, event_type, dedupe_key, count(*) as duplicates
from public.product_events
where dedupe_key is not null
group by environment, event_type, dedupe_key
having count(*) > 1;
```

Notification queue health:

```sql
select environment, channel, status, count(*) as events
from public.notification_events
where created_at >= now() - interval '24 hours'
group by environment, channel, status
order by environment, channel, status;
```

Failed jobs:

```sql
select environment, job_name, status, error_code, error_message, created_at
from public.job_runs
where created_at >= now() - interval '24 hours'
  and status in ('failed', 'skipped')
order by created_at desc;
```

API request log severity:

```sql
select environment, severity, status_code, count(*) as requests
from public.api_request_logs
where created_at >= now() - interval '24 hours'
group by environment, severity, status_code
order by environment, severity, status_code;
```

Booking errors:

```sql
select environment, severity, step, error_code, count(*) as errors
from public.booking_error_events
where created_at >= now() - interval '24 hours'
group by environment, severity, step, error_code
order by errors desc;
```

## Cleanup

Run API request log retention cleanup from the app host:

```bash
npm run cleanup:api-request-logs
```

Or call the protected internal endpoint:

```bash
curl -X POST "$API_BASE_URL/internal/api-request-logs/cleanup" \
  -H "x-internal-api-secret: $INTERNAL_API_SECRET"
```

Confirm cleanup recorded a job run:

```sql
select environment, job_name, status, records_processed, records_succeeded, records_failed, created_at
from public.job_runs
where job_name = 'api-request-logs-cleanup'
order by created_at desc
limit 5;
```

## Admin Endpoint Manual Checks

Non-admin should receive `403`:

```bash
curl "$API_BASE_URL/api/admin/system-health" \
  -H "Authorization: Bearer $NON_ADMIN_TOKEN"
```

Admin should receive `200`:

```bash
curl "$API_BASE_URL/api/admin/system-health" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

Compare admin business overview counts with SQL. Example for public bookings:

```sql
select count(*) as public_bookings
from public.appointments
where booking_source = 'public'
  and created_at >= now() - interval '30 days';
```

Compare revenue source behavior:

```sql
select coalesce(sum(price), 0) as completed_revenue
from public.appointments
where status = 'completed'
  and appointment_date >= now() - interval '30 days';
```

Dashboard responses should label this as `appointment_price_fallback`. Do not reintroduce `appointment_payments` or paid/unpaid appointment state.

## Sensitive Data Audit

Inspect recent analytics metadata:

```sql
select 'product_events' as table_name, metadata
from public.product_events
where created_at >= now() - interval '24 hours'
union all
select 'notification_events', metadata
from public.notification_events
where created_at >= now() - interval '24 hours'
union all
select 'booking_error_events', metadata
from public.booking_error_events
where created_at >= now() - interval '24 hours'
union all
select 'api_request_logs', metadata
from public.api_request_logs
where created_at >= now() - interval '24 hours'
limit 100;
```

Metadata must not contain:

- full message bodies
- raw phone numbers
- raw emails
- raw IP addresses
- auth tokens
- public appointment action tokens
- signed URLs
- payment URLs
- QR storage paths

Safe values include internal IDs, stylist slugs, status values, provider names, booleans such as `has_payment_url`, counts, and durations.

## Smoke Checklist

1. Hit `GET /api/health`.
2. Hit `GET /me` with an authenticated token.
3. Hit `POST /me/open` with an authenticated token.
4. Trigger one validation error on a safe endpoint.
5. Confirm `api_request_logs` has `environment` and `severity`.
6. Create a staging public booking.
7. Confirm `product_events` has `public_booking_submitted` with a dedupe key.
8. Trigger a safe booking validation miss.
9. Confirm `booking_error_events` has `severity = 'warning'`.
10. Run API request log cleanup.
11. Confirm non-admin cannot access `/api/admin/system-health`.
12. Confirm admin can access `/api/admin/system-health`.
13. Confirm dashboard/calendar/admin revenue responses include `appointment_price_fallback`.
