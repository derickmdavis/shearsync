# Frontend Account Access Handoff

This document replaces the previous Basic, Pro, and Premium entitlement model.
ShearSync now has one all-inclusive paid product. An authenticated account is
either `active` or `inactive`.

## What changed

- Remove all tier names, plan comparison logic, upgrade prompts, and per-feature
  entitlement checks from the frontend.
- Do not call `GET` or `PATCH /api/account/plan`; those routes are retired.
- Use `GET /api/account/access` once per authenticated session as the source of
  truth for paid-account access.
- All product features are available to an `active` account.
- An `inactive` account may use account-status and deletion flows, but product
  API requests are rejected until billing activates or renews the account.

## Account access API

```http
GET /api/account/access
Authorization: Bearer <access-token>
```

Response:

```ts
type AccountAccess = {
  status: "active" | "inactive";
  isActive: boolean;
  activatedAt: string | null;          // UTC ISO-8601 instant
  currentPeriodEndsAt: string | null;  // UTC ISO-8601 instant
  deactivatedAt: string | null;        // UTC ISO-8601 instant
};
```

Example active response:

```json
{
  "data": {
    "status": "active",
    "isActive": true,
    "activatedAt": "2026-07-01T00:00:00.000Z",
    "currentPeriodEndsAt": "2026-08-01T00:00:00.000Z",
    "deactivatedAt": null
  }
}
```

`currentPeriodEndsAt` can be `null` for accounts migrated from the earlier
system until the billing provider sends its first authoritative renewal event.
Do not infer that a `null` value makes an active account unpaid or expired.

## Session boot sequence

After authentication succeeds:

1. Fetch `GET /api/account/access` before loading the normal app shell.
2. Store the response in authenticated-session state, not durable anonymous
   cache.
3. When `isActive` is `true`, render the normal all-inclusive app.
4. When `isActive` is `false`, route to the inactive-account screen and avoid
   initial product-data requests.
5. Refresh access state after returning from checkout, after app foregrounding,
   and after any billing-success deep link.

Recommended state shape:

```ts
type AccountAccessState =
  | { state: "loading" }
  | { state: "active"; access: AccountAccess }
  | { state: "inactive"; access: AccountAccess }
  | { state: "error"; retry: () => void };
```

Never derive access from a cached profile response, a tier field, a client-side
purchase receipt, or a date calculated on the device.

## Inactive-account screen

The inactive-account screen should be a focused renewal/paywall state, not an
upsell comparison screen. There are no plans to compare.

Show:

- a concise statement that an active subscription is required;
- one primary action: **Subscribe** or **Renew**;
- `currentPeriodEndsAt` as optional informational copy when it is present;
- a refresh/retry action after a completed purchase;
- account deletion and sign-out actions.

Do not show:

- Basic/Pro/Premium labels;
- feature comparison grids;
- feature-specific upgrade CTAs;
- a local toggle to make the account active.

Checkout and billing-portal endpoints are not part of this backend yet. Wire
the primary action to the selected billing flow when it is available, then
refetch `/api/account/access` after the provider returns to the app.

## Handling a rejected product request

All normal authenticated product routes are guarded by account access. An
inactive request receives:

```http
403 Forbidden
```

```json
{
  "error": {
    "message": "An active subscription is required to use ShearSync.",
    "details": {
      "code": "account_inactive"
    }
  }
}
```

Implement one API-client interceptor:

1. Detect `403` with `error.details.code === "account_inactive"`.
2. Invalidate cached product queries and account access state.
3. Fetch `/api/account/access` once to confirm current state.
4. Route to the inactive-account screen.

Do not display the raw API message as a feature-level error or leave the user
on an editable screen after access is revoked.

Authentication failures (`401`) remain sign-in/session-refresh behavior and
must not be treated as inactive-account behavior.

## Route availability while inactive

| Area | Expected frontend behavior |
| --- | --- |
| `/api/account/access` | Available; use it to render account state. |
| Account deletion endpoints | Available. |
| Auth/session endpoints | Available. |
| Product routes (`/api/clients`, `/api/appointments`, settings, campaigns, etc.) | Do not call from the inactive screen; they return `403 account_inactive`. |
| Admin/internal routes | Not part of normal customer-app navigation. |

## Removed frontend entitlement logic

Delete any code that depends on these retired concepts:

```ts
plan_tier
plan_status
PlanTier
PlanStatus
features.emailCampaigns
features.waitlist
features.appointmentPhotos
features.referrals
features.rebookNudges
features.birthdayReminders
features.thankYouEmails
effectiveFeatures.waitlistEnabled // account eligibility portion is retired
smsMonthlyLimit
smsRemainingThisMonth
```

All feature screens, including campaigns, referrals, appointment images,
formula photos, custom cover photos/slugs, birthday reminders, rebook nudges,
and thank-you emails should render for every active account.

## Waitlist and profile settings

Waitlist is no longer a paid-feature gate. It is only a stylist preference.

- Read and write `waitlist_enabled` through the existing profile settings API.
- In the authenticated app, show the toggle to every active account.
- On the public page, show waitlist UI only when both
  `booking_enabled === true` and `features.waitlistEnabled === true`.
- `features.waitlistEnabled` now reflects the active business plus the
  stylist's setting; do not combine it with an account tier in the frontend.

## Public booking behavior

Inactive businesses are hidden from public booking routes. Treat an inactive
business response exactly like a missing or unavailable stylist; do not expose
subscription status to a guest.

| Public request | Inactive business behavior |
| --- | --- |
| Public stylist profile | `404` |
| Services / availability / slots | `404` |
| Booking intake / create booking / waitlist | Rejected as unavailable |
| Public reference-photo upload | Rejected as unavailable |

For an active stylist with `booking_enabled === false`, preserve the existing
booking-disabled UI. This is a business setting, not a billing state.

## Data-model/UI changes

- Replace `profile.planLabel` with `profile.accountStatus` when displaying
  account information in the profile area.
- Admin-facing client code should use `accountStatus` and
  `currentPeriodEndsAt`, not `planTier` and `planStatus`.
- Insights rollout is no longer targeted by plan tier. Do not send or expect
  tier data for Insights configuration.

## Release checklist

1. Remove old plan/feature state from the client data store and persisted cache.
2. Ship the session boot gate and inactive-account screen.
3. Add the centralized `account_inactive` API interceptor.
4. Remove all tier copy, assets, analytics properties, and upgrade navigation.
5. Update public booking error handling to treat inactive businesses as
   unavailable.
6. Test with one active account and one inactive account:
   - active account can use every product feature;
   - inactive account reaches the renewal screen after sign-in;
   - an active session that becomes inactive is redirected on its next API call;
   - inactive public booking URLs do not reveal subscription state;
   - successful renewal followed by access refresh restores the normal app.
