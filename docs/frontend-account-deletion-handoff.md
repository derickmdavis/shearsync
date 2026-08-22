# Frontend Account Deletion Handoff

## Scope

This flow lets an authenticated stylist request account deletion. The backend
immediately disables account access and public booking, then schedules the hard
deletion for seven calendar days later.

During the seven-day period, product data must not be shown or edited. The
backend retains minimized, non-identifying operational history for support and
reporting, then deletes the account's clients, appointments, stylist profile,
booking page/configuration, and account-owned media during the worker run.

There is currently no customer cancellation endpoint. Treat confirmation as
final in the UI. Do not show an “undo” action until the backend endpoint exists.

## Authentication

Every endpoint below requires the normal Supabase bearer token:

```http
Authorization: Bearer <access-token>
```

Do not send a user ID. The backend derives it from the session.

## Endpoints

### Read deletion status

```http
GET /api/account/deletion-request
```

Response:

```ts
type AccountDeletionStatus = {
  status: "none" | "pending" | "processing" | "failed_retryable" | "completed" | "cancelled";
  requestId: string | null;
  requestedAt: string | null;          // UTC ISO-8601
  scheduledDeletionAt: string | null;  // UTC ISO-8601
  completedAt: string | null;          // UTC ISO-8601
};
```

`status: "none"` means there is no request for the currently authenticated
account. `failed_retryable` means the backend will retry cleanup automatically;
do not ask the customer to submit another request.

### Submit deletion request

Use the `POST` endpoint for new frontend work:

```http
POST /api/account/deletion-request
Content-Type: application/json
```

```json
{
  "confirmation": "DELETE",
  "reason": "Optional feedback, up to 1,000 characters",
  "clientRequestId": "optional-idempotency-key-up-to-120-characters"
}
```

`confirmation` must be exactly uppercase `DELETE`. `reason` and
`clientRequestId` are optional. Generate a stable `clientRequestId` for one
submission attempt and reuse it after a network retry; generate a new one only
after the user starts a new request.

The legacy-equivalent `DELETE /api/account` accepts the same body, but the
frontend should prefer `POST /api/account/deletion-request`.

Successful requests return `202 Accepted`:

```json
{
  "data": {
    "status": "pending",
    "requestId": "uuid",
    "requestedAt": "2026-08-21T18:00:00.000Z",
    "scheduledDeletionAt": "2026-08-28T18:00:00.000Z",
    "completedAt": null,
    "publicBookingDisabled": true,
    "message": "Your account deletion request has been received."
  }
}
```

Submitting the same request again is idempotent. It also returns `202`, keeps
the original scheduled deletion time, and returns an “already been received”
message.

## Required UI Behavior

1. In account settings, require an explicit destructive confirmation field.
   Enable the submit action only when it exactly equals `DELETE`.
2. Before submission, explain that access and public booking stop immediately,
   hard deletion is scheduled for the timestamp returned by the API, and there
   is no self-service undo yet.
3. Disable the submit action while the request is in flight. Use a stable
   `clientRequestId` if the request is retried after a transport failure.
4. On `202`, clear authenticated product caches, stop background refetches,
   and sign the user out or route them to a deletion-pending screen. Do not
   continue rendering the normal app with stale client or appointment data.
5. At session bootstrap, fetch both `GET /api/account/access` and
   `GET /api/account/deletion-request`. When deletion status is `pending`,
   `processing`, or `failed_retryable`, render only the deletion-pending state
   plus sign-out support.
6. Display `scheduledDeletionAt` in the viewer's local time with an explicit
   timezone. Treat it as server-authoritative; do not calculate the deadline
   from the device clock.

## Account Access Integration

`GET /api/account/access` now includes `deletionStatus`:

```ts
type AccountAccess = {
  status: "active" | "inactive";
  isActive: boolean;
  deletionStatus: "active" | "pending" | "processing" | "failed";
  activatedAt: string | null;
  currentPeriodEndsAt: string | null;
  deactivatedAt: string | null;
};
```

After a deletion request, expect `status: "inactive"` and normally
`deletionStatus: "pending"`. Product endpoints may return:

```http
403 Forbidden
```

```json
{
  "error": {
    "message": "Account deletion is pending.",
    "details": { "code": "account_deletion_pending" }
  }
}
```

Extend the existing account-access interceptor to recognize
`error.details.code === "account_deletion_pending"`. Clear protected state and
route to the deletion-pending screen. Keep ordinary inactive-account handling
for `account_inactive`.

Guests should receive the existing unavailable/missing-stylist behavior for
the public booking page, referral links, campaign links, and appointment
management links. Do not expose that the business is deleting its account.

## Errors

| Status | Condition | Frontend handling |
| --- | --- | --- |
| `400` | Validation error, including a confirmation other than `DELETE` | Show an inline error and preserve input. |
| `401` | Missing or expired session | Use the normal re-authentication flow. |
| `409` | User is an active administrator | Explain that the administrator role must be transferred or disabled first. The error detail code is `active_administrator`. |
| `429` | More than three deletion submissions from the same account in one hour | Preserve input and show a brief retry-later message. |
| `500` / `503` | Temporary backend or deployment problem | Show a retryable generic error. Do not claim deletion was scheduled. |

Never display raw API `details` other than the recognized machine-readable
codes above.

## Frontend Test Cases

1. Fresh account: the confirmation field gates submission; a valid request
   returns `202` and routes out of the product shell.
2. Network retry: reuse the same `clientRequestId`; only one pending request is
   represented.
3. Returning session: a pending request renders the pending screen, not the
   inactive billing screen or normal app.
4. Product API rejection with `account_deletion_pending`: clear cached client,
   appointment, profile, and campaign data before redirecting.
5. Guest booking/referral/campaign URLs for a deletion-pending account show the
   app's standard unavailable state with no deletion-specific copy.
6. Active administrator: show the role-transfer message and do not sign the
   user out or clear data because the deletion was not accepted.

## Out of Scope

- Self-service cancellation or restoration during the grace period.
- Stripe checkout, billing portal, and subscription cancellation UI. Stripe is
  not integrated yet; the backend deletion worker will need a billing
  cancellation step before its final Auth deletion when that integration lands.
- A customer-visible deletion-complete screen after final deletion. The Auth
  user is removed, so future entry uses the normal signed-out experience.
