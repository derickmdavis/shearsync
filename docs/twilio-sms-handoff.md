# Twilio SMS Handoff — ShearSync API

**Repository reviewed:** `main` at `97b7d7b`  
**Status:** The backend SMS system is implemented and tested, but it is intentionally disabled by default. Remaining work is Twilio configuration, production deployment configuration/migrations, scheduled workers, and frontend consent wiring. This repository cannot prove that those external steps have been completed.

## Executive summary

The API already has:

- A Twilio SMS provider using API-key authentication and a Messaging Service.
- A durable, idempotent SMS outbox with leases, retry handling, monthly usage limits, and delivery-state reconciliation.
- Automatic appointment-confirmation and appointment-reminder queueing.
- Explicit SMS consent and per-client preference controls.
- Signed Twilio inbound-message and delivery-status webhooks.
- STOP, START, and HELP processing with audit trails and inbound-event idempotency.
- Raw inbound-message and phone-data redaction after a configurable retention period.

The initial production environment is intentionally safe:

```dotenv
SMS_PROVIDER=none
SMS_DELIVERY_ENABLED=false
SMS_APPOINTMENT_CONFIRMATIONS_ENABLED=false
SMS_APPOINTMENT_REMINDERS_ENABLED=false
```

With those values, the API sends no SMS and both Twilio callback URLs return `404`.

## Implemented architecture

```text
appointment / reminder event
  → database-backed outbox (`sms_messages`)
  → trusted internal SMS worker
  → account, consent, appointment, and monthly-cap checks
  → Twilio Messages API via Messaging Service
  → Twilio Message SID persisted
  → signed Twilio delivery-status callback updates final state
```

### Outbound Twilio provider

The provider in `src/services/twilioSmsProvider.ts`:

- Authenticates with `TWILIO_API_KEY_SID` and `TWILIO_API_KEY_SECRET`, under `TWILIO_ACCOUNT_SID`.
- Sends with `messagingServiceSid: TWILIO_MESSAGING_SERVICE_SID`.
- Never selects a `From` number. Twilio selects a sender from the Messaging Service sender pool.
- Saves Twilio's returned Message SID as `provider_message_id`.
- Normalizes Twilio errors to non-sensitive internal error codes; provider payloads/recipient data are not exposed in application errors.
- Fails closed before any outbox row is claimed if account SID, API-key SID, API-key secret, or Messaging Service SID is missing.

### Durable SMS outbox and sending behavior

`src/services/smsDeliveryService.ts` provides the provider-neutral outbox worker.

- Table: `sms_messages`.
- Deduplication: unique `(user_id, idempotency_key)`.
- Default worker page: 25 messages.
- Default maximum attempts: 4.
- Retry delays: 1 minute, 5 minutes, and 20 minutes; final failures are not retried.
- Work lease: five minutes, refreshed while the provider request is in progress.
- Provider request timeout: up to two minutes (bounded by the lease).
- A timeout with an ambiguous provider outcome becomes `unknown` and is **not retried** automatically, preventing a possible duplicate text.
- Provider failures become `failed`; the monthly reservation is released where safely confirmed.
- SMS queue metrics report pending, failed, unknown, and oldest queued age.

Before sending, the worker checks:

1. The account is active.
2. `users.sms_delivery_enabled` is true.
3. The recipient number is valid.
4. The recipient has explicit SMS consent for the message type.
5. A reminder's appointment still exists, is scheduled, and has not changed occurrence.
6. The account has remaining monthly SMS capacity.

The monthly SMS cap is enforced in Postgres. The current migration initializes and caps accounts at **500 messages/month**. The count is reserved only immediately before provider submission.

## Automatic SMS currently implemented

### Appointment confirmations

Database migration `202608180002_appointment_sms_confirmation_jobs.sql` creates a durable confirmation-job table and trigger.

- A job is created when an appointment is inserted as `scheduled`, or transitions to `scheduled`.
- `POST /internal/sms/process` first drains these jobs, then processes the normal outbox.
- Confirmation outbox key: `appointment-confirmation:<appointment-id>`.
- A confirmation is queued only when the account is active, account SMS delivery is enabled, the client has a valid phone/first name, the account has business identity, and the client has transactional SMS consent.
- Default confirmation includes the business name, client first name, service when present, local appointment date/time, and `Reply STOP to opt out.`
- Confirmation sending is independently controlled by `SMS_APPOINTMENT_CONFIRMATIONS_ENABLED`.

### Appointment reminders

`POST /internal/sms/appointment-reminders/process` identifies appointments due in an approximately 24-hour window.

- Default scan interval: 10 minutes.
- Intended schedule: every 5–10 minutes.
- It **queues only**; it does not send directly to Twilio.
- `POST /internal/sms/process` must run separately to deliver queued reminders.
- Reminder outbox key: `appointment-reminder:<appointment-id>:<appointment-start-at>`.
- Overlapping scheduler runs are idempotent.
- The sender revalidates a queued reminder after claim so cancelled/rescheduled appointments are skipped.
- Reminder sending is independently controlled by `SMS_APPOINTMENT_REMINDERS_ENABLED`.
- Reminder templates are one printable-ASCII SMS segment (maximum 160 characters), must include business identity, client first name, appointment date/time, and `Reply STOP to opt out.`

## SMS consent, client preferences, and public booking

### Consent model

SMS is **opt-in only**. A recipient cannot receive SMS if there is no preference record, no `sms_opted_in_at`, or `opted_out_all_sms=true`.

An SMS opt-in enables:

- Transactional appointment messages.
- Appointment reminders.

It does **not** enable marketing or rebooking messages.

Authenticated client-management endpoints already exist:

```text
GET   /api/clients/:id/sms-preferences
PATCH /api/clients/:id/sms-preferences
POST  /api/clients/:id/sms-preferences/opt-in
POST  /api/clients/:id/sms-preferences/opt-out
```

Manual opt-ins require staff/client-portal/admin source information and exact consent text. Mutations write a communication-consent audit event and link it from the preference row.

### Public booking consent

`POST /api/public/bookings` accepts:

```json
{
  "sms_opt_in": true
}
```

When true, the backend records a server-controlled consent disclosure, disclosure version, appointment ID, IP address, and user agent. It enables only transactional and reminder SMS, then safely re-attempts confirmation queueing after the consent write. Repeated booking requests cannot create duplicate consent events for the same appointment/contact.

The audited disclosure is:

> I agree to receive appointment-related text messages. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help. See our Terms of Service.

**Important outstanding frontend work:** `docs/frontend-booking-sms-consent-handoff.md` says the public-booking UI still needs to lift its checkbox state and submit `sms_opt_in` in the final booking request. This repository does not include that frontend, so completion cannot be verified here. Until it is complete, public bookers will not generate consent and will not receive SMS.

## Inbound Twilio SMS, opt-out handling, and delivery-status callbacks

### Callback endpoints

| Twilio function | API endpoint | Effect |
|---|---|---|
| Incoming message | `POST /api/communications/sms/inbound` | Stores/deduplicates inbound event, applies STOP/START/HELP, returns TwiML where required. |
| Delivery status | `POST /api/communications/sms/status` | Reconciles the matching outbox row to sent, delivered, or failed. |

Both endpoints:

- Expect Twilio form-encoded POSTs.
- Require a valid `X-Twilio-Signature`.
- Validate the signature using `TWILIO_AUTH_TOKEN` and `PUBLIC_API_BASE_URL + original request path`.
- Return `404` while `SMS_PROVIDER` is not `twilio`.

`TWILIO_AUTH_TOKEN` is for webhook validation; it is not the outbound API-key secret.

### STOP, START, and HELP behavior

The application uses Twilio `OptOutType` when present. Without it, it recognizes these full-message keywords:

| Classification | Recognized keywords |
|---|---|
| STOP | `STOP`, `STOPALL`, `UNSUBSCRIBE`, `CANCEL`, `END`, `QUIT`, `REVOKE`, `OPTOUT` |
| START | `START`, `YES`, `UNSTOP` |
| HELP | `HELP`, `INFO` |

Inbound events are keyed by Twilio `MessageSid`, claim a short processing lease, and are idempotent. Duplicate completed callbacks receive empty TwiML and do not repeat state changes or audit entries.

When Twilio Advanced Opt-Out has already handled STOP, START, or HELP and supplies `OptOutType`, the API returns empty TwiML to avoid a duplicate response. Otherwise its fallback responses are:

```text
STOP:  You are unsubscribed from DripDesk text messages. Reply START to opt back in.
START: You are opted back in to appointment text updates from DripDesk. Reply STOP to opt out.
HELP:  DripDesk sends appointment messages for your stylist or barber. Reply STOP to opt out.
```

### Shared-service consent scope

The code deliberately treats inbound STOP/START as scoped to **DripDesk's shared Messaging Service**, not to one stylist. A matching phone number is updated across every matching preference record.

Do not move to individual stylist Messaging Services/sender pools without new application work to map sender or Messaging Service ownership to an account. The current shared-scope behavior would otherwise be incorrect.

### Delivery status behavior

Twilio status mappings:

| Twilio status | Internal status |
|---|---|
| `accepted`, `queued`, `sending`, `sent` | `sent` |
| `delivered` | `delivered` |
| `failed`, `undelivered` | `failed` |

The service preserves terminal states against later callbacks. A final delivered/failed callback can reconcile a previous local `unknown` outcome.

If a callback has an unknown Twilio Message SID, the app writes it to `sms_unmatched_delivery_status_callbacks` for manual review and never guesses a match by phone number. There is no operator UI or automated reconciliation workflow for those records yet.

### Retention

Raw inbound body and phone fields are redacted from processed/failed `sms_inbound_events` after `SMS_INBOUND_EVENT_RETENTION_DAYS` (90 by default). Event classification and audit linkage remain.

Run this daily:

```bash
npm run cleanup:sms-inbound-events
```

## Required Twilio setup

1. Create or identify the one shared Messaging Service and collect its `MG...` SID.
2. Add approved sender(s) to the Messaging Service sender pool. The application relies on the Messaging Service for sender selection; do not add `From` logic to the API without a product/design decision.
3. Complete the compliance and sender-registration process applicable to the countries and sender type in use. For US 10DLC traffic, this normally includes Trust Hub business/brand registration and a matching A2P campaign associated with the Messaging Service and sender. The campaign must accurately describe the appointment-message use case, web-form consent, STOP/HELP, and sample content. See [Twilio A2P 10DLC overview](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc).
4. Configure the Messaging Service's common incoming-message webhook, rather than deferring to individual sender webhooks:

   ```text
   POST https://<public-api-host>/api/communications/sms/inbound
   ```

5. Configure the Messaging Service delivery-status callback:

   ```text
   POST https://<public-api-host>/api/communications/sms/status
   ```

   Twilio supports both incoming-message handling and a delivery-status callback at the Messaging Service level. See [Twilio Messaging Services](https://www.twilio.com/docs/messaging/services).

6. Enable **Advanced Opt-Out** on the Messaging Service before launch. It is disabled by default. Configure STOP/START/HELP keywords and the three response messages above. Keep inbound-message delivery to the API enabled so the consent audit stays synchronized. Twilio supplies `OptOutType` to the incoming webhook when Advanced Opt-Out is enabled and configured; its own response is why the API avoids returning a second TwiML message. See [Twilio Advanced Opt-Out](https://www.twilio.com/docs/messaging/tutorials/advanced-opt-out).
7. Create an API key with only the outbound Messaging permissions needed to create messages. Store the key SID/secret only in the API service environment.
8. Generate or retrieve the Twilio Auth Token from the same account and set it only in the API service environment for callback signature validation.

## Required API/deployment configuration

Set the following secrets and feature flags in the deployed API service:

```dotenv
SMS_PROVIDER=twilio
SMS_DELIVERY_ENABLED=true
SMS_APPOINTMENT_CONFIRMATIONS_ENABLED=true
SMS_APPOINTMENT_REMINDERS_ENABLED=true

TWILIO_ACCOUNT_SID=AC...
TWILIO_API_KEY_SID=SK...
TWILIO_API_KEY_SECRET=...
TWILIO_MESSAGING_SERVICE_SID=MG...
TWILIO_AUTH_TOKEN=...

PUBLIC_API_BASE_URL=https://<public-api-host>
INTERNAL_API_SECRET=<at-least-16-random-characters>
SMS_INBOUND_EVENT_RETENTION_DAYS=90
```

Notes:

- `PUBLIC_API_BASE_URL` must be the exact public HTTPS base that Twilio uses: correct scheme, hostname, and any path prefix. A mismatch causes signature validation to fail with `403`.
- Do not expose any Twilio credentials or `INTERNAL_API_SECRET` to frontend/mobile clients.
- Enable the feature flags only after sender approval, webhooks, workers, and activation preflight are complete.

## Required database deployment

Use the normal Supabase migration process. At minimum, the complete SMS migration chain must be applied:

```text
202608120001_sms_outbox.sql
202608130001_sms_inbound_events.sql
202608130002_harden_sms_event_processing.sql
202608130003_atomic_twilio_delivery_status.sql
202608130004_redact_retained_sms_inbound_events.sql
202608130005_unique_sms_provider_message_id.sql
202608140001_sms_template_settings.sql
202608140002_limit_sms_template_settings_to_single_segment.sql
202608140003_atomic_sms_template_settings_upsert.sql
202608140004_manual_sms_consent_preferences.sql
202608140005_atomic_inbound_sms_consent.sql
202608180001_audit_idempotent_inbound_sms_consent.sql
202608180002_appointment_sms_confirmation_jobs.sql
202608180003_sms_monthly_usage.sql
202608180004_appointment_sms_reminder_failures.sql
202608180005_unmatched_twilio_delivery_statuses.sql
202608180006_public_booking_sms_consent.sql
```

`supabase/schema.sql` represents the final schema state, but it is not evidence that the production project has received these migrations.

## Required scheduled work

No Railway Cron configuration is checked into this repository. `railway.json` starts the normal API only. Create external trusted schedules:

| Purpose | Invocation | Suggested cadence |
|---|---|---|
| Deliver outbox and drain confirmation jobs | `POST /internal/sms/process` with `x-internal-api-secret` | Choose deliberately based on expected confirmation latency and throughput. |
| Queue 24-hour reminders | `POST /internal/sms/appointment-reminders/process` with `x-internal-api-secret` | Every 5–10 minutes. |
| Redact inbound raw data | `npm run cleanup:sms-inbound-events` | Daily. |

The first endpoint also processes confirmation jobs. The reminder endpoint does not send SMS itself.

## Activation hazard — resolve before enabling confirmations

Before setting `SMS_APPOINTMENT_CONFIRMATIONS_ENABLED=true`, inspect pending rows in `appointment_sms_confirmation_jobs`.

The trigger creates jobs for scheduled appointments, and the worker has **no age cutoff**. Turning it on can process historical pending jobs and send late confirmation messages to any eligible recipients.

Decide explicitly whether historical pending jobs should be:

- sent;
- marked skipped; or
- handled by a narrowly scoped migration/release plan.

Do not enable confirmation processing before this decision.

## Not yet implemented / intentionally out of scope

- Public booking frontend wiring for `sms_opt_in` cannot be verified in this repository.
- Production worker/cron configuration is not checked in.
- There are no client/admin HTTP routes for reminder-template configuration, though the service/table exist.
- Confirmation copy is fixed; reminder customization is internal only.
- No automatic SMS for cancellations or reschedules.
- Marketing and rebooking SMS are intentionally unavailable.
- No sender/service-to-account mapping for per-stylist Twilio identities.
- No operator UI or automatic resolver for unknown sends or unmatched Twilio delivery-status callbacks.

## Recommended live verification sequence

1. Apply migrations and deploy the API with SMS feature flags still disabled.
2. Verify `PUBLIC_API_BASE_URL` resolves publicly over HTTPS.
3. Configure the Twilio Messaging Service, sender pool, compliance registration, Advanced Opt-Out, and both callback URLs.
4. Use a non-production/staging Messaging Service and approved test number first where possible.
5. Confirm a signed inbound STOP, START, and HELP callback reaches the API; verify exactly one inbound event and audit record per Twilio `MessageSid`.
6. Create an explicitly consented test client/booking and a new scheduled test appointment.
7. Enable confirmation delivery only after the historical-job decision, then invoke `/internal/sms/process` with the internal secret.
8. Verify `sms_messages` stores the Twilio SID and changes through `sent` to `delivered` after the status callback.
9. Test failed/undelivered delivery and inspect the persisted error code.
10. Enable reminder queueing, run both reminder and delivery jobs, and verify no duplicate reminder is created by overlapping scheduler executions.
11. Monitor `unknown` outbox records and `sms_unmatched_delivery_status_callbacks` during initial rollout.

## Validation already performed

- `npm run typecheck` passed.
- SMS/Twilio-focused tests passed for consent preferences, outbox idempotency/retry/lease/usage-cap logic, confirmation queueing, reminder queueing, inbound signatures and Advanced Opt-Out behavior, delivery-status handling, retention, and HTTP-level webhook behavior.
- The HTTP-level tests initially could not bind a local test port inside the restricted sandbox; rerunning them with local-port permission passed.

## Documentation caveat

README contains an old “Current limitations” statement saying outbound SMS delivery/reminders are not implemented. That statement is stale. The implementation and migration set described in this handoff are the current code.
