# Account Deletion and Legal Links Backend Implementation Plan

## Summary

Recommended approach: ship a request-based deletion workflow first, backed by an admin/internal processor that can safely clean Storage, cancel/mark account state, disable public booking immediately, and then delete the Supabase Auth user with the service role after domain cleanup succeeds. This is the safer MVP path for App Store and Google Play review because it gives users an in-app account deletion path without risking half-deleted appointment, image, communication, or future billing records.

The backend does not currently have an account deletion endpoint or account deletion request endpoint. It also does not currently expose Privacy Policy, Terms of Service, or Support configuration. The existing `/api/account` router only supports `GET /api/account/plan` and `PATCH /api/account/plan`.

Current repo facts that shape the plan:

- Authenticated `/api/*` routes use `requireAuth`; user identity is resolved through Supabase JWT claims.
- Backend has a service-role Supabase client as `supabaseAdmin`.
- `public.users.id` references `auth.users(id) on delete cascade`.
- Most user-owned tables reference `public.users(id) on delete cascade` or `auth.users(id) on delete cascade`.
- Appointment images are stored in private Supabase Storage bucket `appointment-images` under `users/{user_id}/...`; DB cascades will not delete Storage objects.
- Client delete is already soft delete in `clientsService.remove()` with `deleted_at`, `deleted_reason`, and `purge_after`.
- Public booking is exposed through `stylists.slug` and gated by `stylists.booking_enabled`.
- No Stripe dependency or Stripe local schema exists in this checkout. The only plan state is local entitlement fields on `users`.

## A. Compliance Strategy

Use request-based deletion for the first compliant release:

- Frontend exposes an in-app "Delete Account" or "Request Account Deletion" row.
- Backend accepts `POST /api/account/deletion-request`.
- Request immediately disables public booking, queues/cancels pending automation, marks the account as pending deletion, and returns a clear pending state.
- Admin/internal processing performs the irreversible cleanup and Supabase Auth deletion.
- Backend also exposes legal/support links through a lightweight config endpoint.

Why not immediate hard delete as MVP:

- Supabase Auth deletion cascades database records but not Storage files.
- Appointment/client photos must be deleted from Storage before database metadata disappears.
- Email/SMS queues, consent events, public booking pages, public appointment management tokens, and future billing/provider records need intentional handling.
- Without a deletion job table and status model, immediate deletion is difficult to retry safely after partial failure.

App Store risk:

- Apple requires apps with account creation to let users initiate account deletion in-app. A request workflow can be acceptable when immediate deletion is complex, but the UI must be clear that the request was submitted and what happens next.
- For lower review risk, make the request endpoint self-service, authenticated, and deterministic. Do not require the user to email support as the only path.

Future upgrade:

- Add `DELETE /api/account` for immediate self-service deletion after the request workflow, job processing, Storage cleanup, and partial failure recovery are proven.

## B. API Endpoints

### `GET /api/legal-links`

Purpose: expose app-review-critical URLs and support contacts from backend-controlled config.

Auth: public or authenticated. Prefer public so the app can show links before auth and store reviewers can inspect behavior without sign-in friction.

Request body: none.

Response `200`:

```json
{
  "data": {
    "privacyPolicyUrl": "https://dripdesk.example/privacy",
    "termsOfServiceUrl": "https://dripdesk.example/terms",
    "supportUrl": "https://dripdesk.example/support",
    "supportEmail": "support@dripdesk.example",
    "accountDeletionSupportEmail": "privacy@dripdesk.example"
  }
}
```

Status codes:

- `200`: links returned.
- `500`: required production legal config is missing.

Implementation notes:

- Add env vars: `PRIVACY_POLICY_URL`, `TERMS_OF_SERVICE_URL`, `SUPPORT_URL`, `SUPPORT_EMAIL`, `ACCOUNT_DELETION_SUPPORT_EMAIL`.
- Validate URL/email shape in `env.ts`.
- In production, require privacy, terms, and at least one support contact.
- Route-order note: `src/routes/index.ts` currently applies `requireAuth` before general `/api` routers. If this endpoint is public, mount it before `apiRouter.use("/api", requireAuth)` or expose it under the existing public route tree.

### `GET /api/account/deletion-request`

Purpose: let frontend render current deletion status idempotently.

Auth: required.

Request body: none.

Response `200` when no request exists:

```json
{
  "data": {
    "status": "none",
    "requestedAt": null,
    "scheduledDeletionAt": null,
    "completedAt": null,
    "supportEmail": "privacy@dripdesk.example"
  }
}
```

Response `200` when pending:

```json
{
  "data": {
    "status": "pending",
    "requestId": "6bf7c638-5cb5-46ec-801a-7d2d8058e077",
    "requestedAt": "2026-06-20T18:30:00.000Z",
    "scheduledDeletionAt": "2026-06-27T18:30:00.000Z",
    "completedAt": null,
    "supportEmail": "privacy@dripdesk.example"
  }
}
```

Status codes:

- `200`: status returned.
- `401`: missing/invalid auth.

### `POST /api/account/deletion-request`

Purpose: create or return an account deletion request.

Auth: required.

Request body:

```json
{
  "confirmation": "DELETE",
  "reason": "No longer need the app",
  "clientRequestId": "optional-client-generated-id"
}
```

Validation:

- `confirmation` must equal `"DELETE"`.
- `reason` optional, trim to a bounded length such as 1000 chars.
- `clientRequestId` optional idempotency key, bounded length, unique per user if stored.

Response `202`:

```json
{
  "data": {
    "status": "pending",
    "requestId": "6bf7c638-5cb5-46ec-801a-7d2d8058e077",
    "requestedAt": "2026-06-20T18:30:00.000Z",
    "scheduledDeletionAt": "2026-06-27T18:30:00.000Z",
    "publicBookingDisabled": true,
    "message": "Your account deletion request has been received."
  }
}
```

Status codes:

- `202`: request accepted or existing pending request returned.
- `400`: confirmation missing/invalid.
- `401`: missing/invalid auth.
- `409`: account already deleted, deletion already completed, or account is in a state that requires support review.
- `429`: rate limit exceeded.
- `500`: request could not be recorded or public booking could not be disabled.

Idempotency:

- If a pending request already exists for the user, return the existing pending request with `202`.
- If the same `clientRequestId` is retried, return the original request.
- Never create multiple active deletion requests for one user.

Audit logging:

- Insert an `account_deletion_audit_events` row for request creation and duplicate/idempotent retries.
- Include request ID, user ID, source IP, user agent, auth source, and non-sensitive reason metadata.

Side effects at request time:

- Set `stylists.booking_enabled = false` for the user.
- Mark queued/pending automation as cancelled/skipped where safe: rebook nudges, birthday reminders, appointment email events, and appointment reminders.
- Mark user profile/account state as deletion pending.
- Do not delete Auth user yet.

### `DELETE /api/account`

Purpose: future immediate self-service deletion endpoint. Do not make this the first app-review blocker unless the deletion processor is robust.

Auth: required, with fresh-auth/re-auth signal if available from the mobile auth layer.

Request body:

```json
{
  "confirmation": "DELETE",
  "clientRequestId": "optional-client-generated-id"
}
```

Response `202` if implemented as async job:

```json
{
  "data": {
    "status": "processing",
    "requestId": "6bf7c638-5cb5-46ec-801a-7d2d8058e077",
    "signOutRequired": true
  }
}
```

Response `204` only if all cleanup and Auth deletion complete synchronously.

Recommendation: keep this unshipped until the request workflow and processor are proven.

### `POST /internal/account-deletions/process`

Purpose: internal job processor for pending account deletion requests.

Auth: `requireInternalApiSecret`.

Query/body:

```json
{
  "limit": 10,
  "dryRun": false
}
```

Response:

```json
{
  "data": {
    "processed": 3,
    "completed": 2,
    "failed": 1,
    "storageDeleted": 48,
    "requestIds": ["..."],
    "failedRequestIds": ["..."]
  }
}
```

## C. Data Deletion Model

Add migration tables:

- `account_deletion_requests`: `id`, `user_id`, `status`, `reason`, `client_request_id`, `requested_at`, `scheduled_deletion_at`, `processing_started_at`, `completed_at`, `failed_at`, `failure_reason`, `created_ip_hash`, `created_user_agent`, timestamps. If the row must survive Auth/user deletion, use `user_id uuid` without cascade or with `on delete set null` plus a separate non-sensitive `deleted_user_ref`/hash.
- `account_deletion_audit_events`: `id`, `request_id`, `user_id`, `event_type`, `metadata`, `created_at`. Avoid cascades that remove the only proof of request/completion.
- Optional `users.account_status` or `users.deletion_requested_at` if the app needs fast account-state checks.

Table/entity classification:

| Entity | Current relationship | Account deletion handling |
| --- | --- | --- |
| `auth.users` | Supabase Auth source | Delete server-side with service-role admin API after cleanup succeeds. |
| `public.users` | `id references auth.users on delete cascade` | Cascade delete after Auth user deletion, or delete explicitly only after Storage cleanup. |
| `stylists` | `user_id on delete cascade` | Immediately set `booking_enabled=false` on request; cascade/delete at completion. |
| `booking_rules` | `user_id on delete cascade` | Delete/cascade. |
| `services` | `user_id on delete cascade` | Delete/cascade. Historical appointment snapshots retain service name until appointment deletion. |
| `availability` | `user_id on delete cascade` | Delete/cascade. |
| `stylist_off_days` | `user_id on delete cascade` | Delete/cascade. |
| `clients` | `user_id on delete cascade`; soft-delete exists | Delete/cascade for account deletion. Soft-delete retention applies to client delete, not whole-account delete. |
| `appointments` | `user_id on delete cascade`, `client_id on delete cascade` | Delete/cascade after Storage cleanup. |
| `photos` | `user_id/client_id on delete cascade`; metadata-only | Delete/cascade DB rows. If `file_path` maps to an owned Storage bucket, add cleanup before deletion; currently no bucket convention is visible in code. |
| `appointment_images` | `user_id on delete cascade`; Storage paths private | Delete Storage originals/thumbnails first, then cascade/delete DB rows. |
| `reminders` | `user_id/client_id on delete cascade` | Cancel queued/sent-pending work on request; delete/cascade at completion. |
| `appointment_email_templates` | `user_id on delete cascade` | Delete/cascade. |
| `appointment_email_events` | `user_id on delete cascade` | Cancel queued/sending on request. Delete/cascade at completion unless retention policy requires provider delivery logs. |
| `birthday_reminders` | `user_id/client_id on delete cascade` | Cancel queued/sending on request. Delete/cascade at completion. |
| `rebook_nudge_settings` | `user_id on delete cascade` | Delete/cascade. |
| `rebook_nudges` | `user_id/client_id on delete cascade` | Cancel queued/pending on request. Delete/cascade at completion. |
| `automation_settings` | `user_id on delete cascade` | Disable or delete/cascade. |
| `waitlist_entries` | `user_id references auth.users on delete cascade` | Delete/cascade. Consider cancelling active entries on request. |
| `activity_events` | `user_id on delete cascade`; `client_id` lacks explicit cascade in base schema | Delete/cascade through `user_id`. Verify FK behavior in production because `client_id` is not always `on delete`. |
| `plan_usage_events` | `user_id on delete cascade` | Delete/cascade unless future billing/legal retention requires anonymized aggregate retention. |
| `client_communication_preferences` | `user_id on delete cascade` | Delete/cascade. |
| `communication_events` | `user_id on delete cascade` | Prefer anonymize/retain only if needed for legal anti-abuse/provider logs; otherwise delete/cascade. |
| `communication_consent_events` | `user_id on delete cascade` | Consider retention/anonymization for consent compliance; define policy before hard deletion. |
| `communication_preference_tokens` | `user_id on delete cascade` | Invalidate/delete/cascade. |
| `global_email_unsubscribes` | no owner; references users set null | Retain. It is a global suppression list; set user refs null via FK and do not remove the normalized email unless legal policy requires a separate erasure path. |
| `account_deletion_requests` | new | Retain minimal audit record, anonymized after completion. Do not cascade-delete the request if it is needed as proof. |
| `account_deletion_audit_events` | new | Retain minimal operational audit. Avoid storing raw personal data. |

Retention guidance:

- Product data owned by the stylist should be deleted.
- Global unsubscribe/suppression records may be retained for compliance and abuse prevention, but should minimize personal data and sever user references.
- Future financial/billing records should be retained or anonymized according to accounting/legal needs, not blindly deleted.

## D. Supabase Auth Deletion

Supabase Auth user deletion must happen server-side with the service role:

- Client-side/mobile code cannot be trusted to delete arbitrary Auth users.
- The backend already has `SUPABASE_SERVICE_ROLE_KEY` and `supabaseAdmin`.
- Use Supabase admin API, for example `supabaseAdmin.auth.admin.deleteUser(userId)`, from the processor after cleanup.

Recommended sequence:

1. Create deletion request and disable public booking.
2. Processor locks one pending request.
3. Re-disable public booking and cancel queued automation idempotently.
4. List and delete Storage objects under `appointment-images/users/{user_id}` and any other owned upload prefixes.
5. Verify no known `appointment_images.storage_path` or `thumbnail_path` remains for the user, or record failed paths for retry.
6. Delete Supabase Auth user with service role.
7. Let `public.users` and most domain tables cascade.
8. Anonymize/retain deletion request/audit rows and global suppression records.
9. Mark request completed.

Avoiding orphaned data:

- Do not delete Auth first; doing so removes DB metadata needed to discover Storage paths.
- Storage cleanup should be idempotent and tolerate missing files.
- Use request status transitions like `pending -> processing -> completed` and `failed_retryable`.
- If Auth deletion succeeds but completion marking fails, retry should treat "Auth user not found" as success and finalize the request.

## E. Storage Cleanup

Known Storage:

- Appointment images use bucket `appointment-images`.
- Server-generated paths are under `users/{user_id}/clients/{client_id}/appointments/{appointment_id}/...` or fallback `users/{user_id}/appointments/{appointment_id}/...`.
- Each row can have `storage_path` and `thumbnail_path`.
- Missing files are already safely ignored by `appointmentImageStorageService.deleteObjects`.

Deletion plan:

- Add `appointmentImageStorageService.deleteUserPrefix(userId)` or account deletion service helper.
- Query all `appointment_images` for `user_id`.
- Delete every `storage_path` and `thumbnail_path` in bounded chunks.
- Additionally list Storage prefix `users/{user_id}` in bucket `appointment-images` to catch orphaned files and delete them.
- Treat missing files as success.
- Treat non-404 Storage errors as retryable failure and do not delete Auth user until resolved.

Other uploaded assets:

- `users.avatar_image_id` exists but no Storage bucket/convention is visible in this repo. Decide whether it is an external image ID, Supabase path, or future media reference before deletion implementation.
- `stylists.cover_photo_url` is a plain URL string. If it points to Supabase Storage in production, define a controlled bucket/path convention and cleanup it. If it is remote/public URL, only delete the DB reference.
- `photos.file_path` exists as legacy/client photo metadata. No upload/delete implementation or bucket is visible. Before launch, classify this path and add cleanup if it points to owned Storage.

## F. Billing/Provider Records

Current checkout:

- No Stripe package in `package.json`.
- No local Stripe/customer/subscription tables found.
- Plan state lives on `users`: `plan_tier`, `plan_status`, `sms_monthly_limit`, `sms_used_this_month`, `plan_started_at`, `plan_updated_at`, plus `plan_usage_events`.
- `PATCH /api/account/plan` is currently user-authenticated and changes plan state directly; do not touch this as part of compliance unless separately requested.

Plan:

- For current code, there are no external billing records to delete or retain.
- On deletion request, set local plan status to `cancelled` or account status to deletion pending only if product wants entitlement lockout before completion.
- Future Stripe integration should:
  - Cancel active subscriptions on deletion request or before deletion completion.
  - Retain invoices, charges, tax records, dispute evidence, and payout/accounting records as legally required.
  - Store customer/subscription IDs in a retention table with user references anonymized or set null.
  - Avoid deleting provider records that are required for accounting/tax/compliance.

## G. Legal Links/Config

Add backend-controlled legal config:

- `PRIVACY_POLICY_URL`
- `TERMS_OF_SERVICE_URL`
- `SUPPORT_URL`
- `SUPPORT_EMAIL`
- `ACCOUNT_DELETION_SUPPORT_EMAIL`

Expose through `GET /api/legal-links`.

Frontend should not hardcode these unless there is a product reason. Backend-controlled links let mobile releases pass review even if URLs change.

Production validation:

- Privacy Policy URL required.
- Terms URL required.
- At least one support URL/email required.
- Account deletion support email can default to support email if omitted.

## H. Security and Abuse Controls

Controls:

- Require authenticated user for deletion request/status.
- Derive `userId` only from JWT/dev auth; never accept `user_id` in the request body.
- Require explicit confirmation string.
- Prefer fresh auth/re-authentication. If Supabase JWT `auth_time` or equivalent is available, require a recent session for `DELETE /api/account`; for `POST /deletion-request`, require normal auth plus confirmation.
- Rate limit deletion request creation per account/IP.
- Use idempotency via one active request per user and optional `clientRequestId`.
- Store audit events with minimal metadata.
- Disable public booking immediately on request.
- Cancel pending automated communications.
- Do not expose whether another user exists.
- Do not let public booking/reference photo endpoints create new records after deletion pending.
- Shared resources: current model is mostly single-user ownership. If teams/shared accounts are added later, block deletion or transfer resources explicitly.

## I. Frontend Handoff Contract

Frontend legal links:

- Call `GET /api/legal-links`.
- Render:
  - Privacy Policy -> `data.privacyPolicyUrl`
  - Terms of Service -> `data.termsOfServiceUrl`
  - Support -> `data.supportUrl` if present, else `mailto:${data.supportEmail}`
  - Account deletion fallback -> `data.accountDeletionSupportEmail`

Frontend deletion flow:

- Preferred MVP row label: "Delete Account" if the screen explains it submits a request; otherwise "Request Account Deletion".
- On tap, show destructive confirmation requiring the user to acknowledge deletion impact.
- Submit:

```http
POST /api/account/deletion-request
Authorization: Bearer <supabase access token>
Content-Type: application/json

{
  "confirmation": "DELETE",
  "reason": "Optional user-entered reason",
  "clientRequestId": "uuid-from-client"
}
```

Success response:

```json
{
  "data": {
    "status": "pending",
    "requestId": "6bf7c638-5cb5-46ec-801a-7d2d8058e077",
    "requestedAt": "2026-06-20T18:30:00.000Z",
    "scheduledDeletionAt": "2026-06-27T18:30:00.000Z",
    "publicBookingDisabled": true,
    "message": "Your account deletion request has been received."
  }
}
```

Copy-safe success states:

- "Your account deletion request has been received."
- "Online booking has been disabled for your account."
- "You can contact support at privacy@dripdesk.example with questions."

Copy-safe error states:

- `401`: "Please sign in again to request account deletion."
- `400`: "Type DELETE to confirm account deletion."
- `409`: "An account deletion request is already in progress."
- `429`: "Too many deletion attempts. Please try again later or contact support."
- `500`: "We could not submit your deletion request. Please try again or contact support."

After request:

- Sign the user out or move them to a pending-deletion screen. Signing out is safer for review and privacy.
- Clear local image/cache data for the account.
- Do not allow new booking/settings/image mutations once deletion is pending.

Deletion timing:

- MVP is pending/request-based, not immediate.
- Support/admin completes deletion after backend processor cleanup.

## J. Tests

Backend tests to add:

- `GET /api/legal-links` returns configured privacy, terms, and support values.
- Production env validation fails when required legal config is missing.
- `GET /api/account/deletion-request` requires auth.
- `POST /api/account/deletion-request` requires auth.
- Request body must include confirmation.
- User cannot request/delete another user's account.
- Repeated request returns the existing active request.
- `clientRequestId` retry is idempotent.
- Request immediately sets `stylists.booking_enabled=false`.
- Public booking by slug rejects once deletion is pending or booking disabled.
- Queued automation records are cancelled/skipped on request.
- Storage cleanup deletes appointment image originals and thumbnails.
- Storage cleanup tolerates missing files.
- Storage failure prevents Supabase Auth deletion and marks request retryable.
- Supabase Auth deletion is called after Storage cleanup.
- Auth-user-not-found retry is treated as successful completion when domain cleanup is already done.
- Domain tables cascade/delete as expected.
- `global_email_unsubscribes` is retained and user refs become null.
- Current no-Stripe behavior does not attempt provider calls.
- Future billing retention tests once billing tables/providers exist.
- Internal processor respects limit and dry-run.
- Audit events are written for request, processing, completion, and failure.

## K. Rollout

Migrations:

- Add `account_deletion_requests`.
- Add `account_deletion_audit_events`.
- Optionally add `users.account_status`, `users.deletion_requested_at`, and `users.deleted_at`.
- Add indexes:
  - unique active request per user where status in pending/processing/failed_retryable.
  - `account_deletion_requests(status, scheduled_deletion_at)`.
  - optional unique `(user_id, client_request_id)` where client request ID is not null.

Feature flag:

- Add `ACCOUNT_DELETION_REQUESTS_ENABLED=true`.
- If disabled, endpoint can return `503` with support fallback during rollout, but it should be enabled before app review.

Admin/internal tooling:

- Add internal process endpoint.
- Add a manual admin checklist for failed requests.
- Add log filters/alerts for failed Storage cleanup and Auth deletion failures.

Monitoring/logging:

- Count deletion requests created, completed, failed.
- Count Storage deleted/failed paths.
- Log request IDs, not raw personal data.
- Alert on pending requests older than the target processing window.

Backfill/cleanup:

- No account-deletion backfill required unless support has existing manual requests.
- Audit existing Storage prefixes with `appointmentImageCleanupService.cleanupOrphanedStorageObjects` before enabling hard deletion.
- Verify whether legacy `photos.file_path`, avatars, and cover photos map to owned Storage.

Manual QA checklist:

- Legal links load in signed-out and signed-in app states.
- Privacy Policy, Terms, and Support open expected URLs/email.
- Authenticated user can submit deletion request from Profile.
- Duplicate tap/retry does not create duplicate requests.
- Public booking page is disabled immediately after request.
- Appointment image Storage files are removed during processor run.
- User cannot sign in after completed Auth deletion.
- Deletion audit record remains minimal and non-sensitive.
- App signs out/clears local cache after request.

## Risks and Open Questions

- Are `photos.file_path`, `users.avatar_image_id`, and `stylists.cover_photo_url` backed by Supabase Storage in production? If yes, define buckets and cleanup rules before deletion goes live.
- Should deletion complete immediately or after a grace period such as 7 days? A grace period helps support/recovery but must be described clearly in-app.
- Should consent/communication logs be retained for legal compliance, anonymized, or deleted? Decide before implementing the processor.
- Does the mobile app have a reliable fresh-auth signal? If not, start with confirmation plus JWT auth for request workflow.
- What are the final production URLs/emails for Privacy Policy, Terms, Support, and deletion support?
- If Stripe or another billing provider is added, provider cancellation and accounting retention must be added before immediate account deletion.
