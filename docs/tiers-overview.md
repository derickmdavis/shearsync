# Tier And Entitlements Documentation

This document explains how subscription tiers work in the backend today, what the frontend should read, and how to gate UI safely.

## Source Of Truth

The source of truth for tier behavior is:

- `src/lib/plans.ts`
- `src/services/entitlementsService.ts`

Frontend should treat `GET /api/account/plan` as the canonical entitlements endpoint.

Do not derive feature access from `planLabel` in profile overview. That label is display-only.

## Supported Tiers

The backend supports exactly three tiers:

- `basic`
- `pro`
- `premium`

If a user record has a missing or invalid `plan_tier`, the backend normalizes it to `basic`.

## Supported Plan Statuses

The backend supports these statuses:

- `trialing`
- `active`
- `past_due`
- `cancelled`

If a user record has a missing or invalid `plan_status`, the backend normalizes it to `active`.

Status behavior today:

- `trialing`: treated as active
- `active`: treated as active
- `past_due`: currently still treated as active for feature access
- `cancelled`: feature-gated actions are blocked

Important: `past_due` is intentionally not locked down yet. The comment in `entitlementsService` says billing policy is not finalized.

## Entitlements Endpoint

Authenticated route:

- `GET /api/account/plan`

Response shape:

```json
{
  "data": {
    "tier": "premium",
    "status": "trialing",
    "displayName": "Premium",
    "smsMonthlyLimit": 300,
    "smsUsedThisMonth": 25,
    "smsRemainingThisMonth": 275,
    "features": {
      "bookingPage": true,
      "crm": true,
      "emailReminders": true,
      "smsReminders": true,
      "waitlist": true,
      "customCoverPhoto": true,
      "customSlug": true,
      "googleCalendarSync": true,
      "weeklyBusinessRecap": true,
      "clientExport": true
    }
  }
}
```

## Feature Matrix

Current feature matrix from `PLAN_CONFIG`:

| Feature | Basic | Pro | Premium |
| --- | --- | --- | --- |
| `bookingPage` | true | true | true |
| `crm` | true | true | true |
| `emailReminders` | true | true | true |
| `smsReminders` | false | true | true |
| `waitlist` | false | true | true |
| `customCoverPhoto` | false | true | true |
| `customSlug` | false | false | true |
| `googleCalendarSync` | false | false | true |
| `weeklyBusinessRecap` | false | false | true |
| `clientExport` | false | false | true |

## What Frontend Should Use

Frontend should key off `data.features`, not hardcoded tier comparisons, whenever possible.

Recommended gating examples:

- Hide SMS reminder settings when `data.features.smsReminders === false`
- Hide public booking waitlist CTAs and stylist waitlist management when `data.features.waitlist === false`
- Hide cover photo editing when `data.features.customCoverPhoto === false`
- Hide custom booking URL editing when `data.features.customSlug === false`
- Hide premium-only exports when `data.features.clientExport === false`

Recommended fallback display logic:

- Show plan name from `data.displayName`
- Show billing/status badge from `data.status`
- Show SMS usage meter from `smsUsedThisMonth`, `smsMonthlyLimit`, and `smsRemainingThisMonth`

## Activity Tab Rule

The old tier-based messaging-tab gate has been removed.

- All authenticated users should see the Activity tab.
- Do not gate Activity by plan tier.
- Do not look for a `messageTab` or similar entitlement flag in the account plan payload.

## SMS Limits

SMS quota is tier-driven:

- `basic`: `0`
- `pro`: `100`
- `premium`: `300`

When a plan is updated through the account plan endpoint, the backend resets `sms_monthly_limit` to the tier default from `PLAN_CONFIG`.

The backend also computes:

- `smsUsedThisMonth`
- `smsRemainingThisMonth`

`smsRemainingThisMonth` is clamped to `0` minimum.

## Backend Enforcement Today

The backend currently enforces some feature gates server-side and exposes others as entitlement flags for frontend use.

Server-enforced today:

- `customCoverPhoto`
- `customSlug`
- Waitlist public creation and authenticated waitlist mutations
- SMS sending availability via `assertSmsAvailable`

Known enforcement details:

- Updating booking cover photo is blocked unless `customCoverPhoto` is allowed
- Updating stylist slug is blocked unless `customSlug` is allowed
- Public waitlist creation and authenticated waitlist mutations are blocked unless `waitlist` is allowed
- `GET /api/waitlist` returns an empty list with `meta.featureAvailable=false` when `waitlist` is not allowed
- SMS usage is blocked when the plan does not allow SMS or the monthly cap is exceeded
- Any `cancelled` plan fails feature-gated checks with `403`

Not visibly enforced elsewhere yet in this codebase:

- `googleCalendarSync`
- `weeklyBusinessRecap`
- `clientExport`

That means some flags are currently product/UI entitlements first, not necessarily backend-protected actions yet.

## Profile Overview Endpoint

`GET /api/profile/overview` is not the main entitlements endpoint.

What it gives related to plans:

- `data.profile.planLabel`

What it does not give:

- full feature flags
- tier status
- SMS limits

It also currently returns:

```json
{
  "data": {
    "messagingSettings": []
  }
}
```

So frontend should not use profile overview to decide tier gating.

## Plan Updates

Authenticated route:

- `PATCH /api/account/plan`

Accepted body:

```json
{
  "tier": "pro",
  "status": "past_due"
}
```

Validation rules:

- `tier` must be one of `basic | pro | premium`
- `status` is optional
- `status` must be one of `trialing | active | past_due | cancelled`

Backend effects of a successful plan update:

- updates `users.plan_tier`
- updates `users.plan_status`
- updates `users.sms_monthly_limit` to tier default
- updates `users.plan_updated_at`

## Defaults And Normalization

Important backend normalization rules:

- Missing `plan_tier` becomes `basic`
- Invalid `plan_tier` becomes `basic`
- Missing `plan_status` becomes `active`
- Invalid `plan_status` becomes `active`
- Invalid or negative SMS values fall back to safe whole-number defaults

This means frontend can expect a valid, normalized plan payload from `GET /api/account/plan` even if underlying user data is incomplete.

## Frontend Integration Guidance

Recommended load order:

1. Fetch `GET /api/account/plan` after auth is ready.
2. Store the response in session/app state.
3. Gate tabs, settings sections, and upsell prompts from `data.features`.
4. Use `data.status` for messaging like cancelled or billing issues.

Recommended behavior by status:

- `trialing`: show full allowed features
- `active`: show full allowed features
- `past_due`: show full allowed features for now, unless product wants extra warning UI
- `cancelled`: frontend should expect some gated actions to fail and should treat the account as restricted

## Suggested Frontend Model

```ts
type AccountPlan = {
  tier: "basic" | "pro" | "premium";
  status: "trialing" | "active" | "past_due" | "cancelled";
  displayName: string;
  smsMonthlyLimit: number;
  smsUsedThisMonth: number;
  smsRemainingThisMonth: number;
  features: {
    bookingPage: boolean;
    crm: boolean;
    emailReminders: boolean;
    smsReminders: boolean;
    waitlist: boolean;
    customCoverPhoto: boolean;
    customSlug: boolean;
    googleCalendarSync: boolean;
    weeklyBusinessRecap: boolean;
    clientExport: boolean;
  };
};
```

## Recommended UI Gates

Use these checks directly:

```ts
const canUseSms = plan.features.smsReminders && plan.smsMonthlyLimit > 0;
const canUseWaitlist = plan.features.waitlist;
const canEditCoverPhoto = plan.features.customCoverPhoto;
const canEditBookingSlug = plan.features.customSlug;
const canExportClients = plan.features.clientExport;
const canUseGoogleCalendarSync = plan.features.googleCalendarSync;
```

## Known Caveats

- `planLabel` in profile overview is display-only and should not be used for authorization logic.
- `past_due` is not fully restricted yet.
- Some premium feature flags exist before corresponding backend functionality is fully implemented.
- Profile settings updates should not be used to change tier; tier changes belong to `/api/account/plan`.

## Files To Reference

- [src/lib/plans.ts](/Users/derick/shearsync-api/src/lib/plans.ts)
- [src/services/entitlementsService.ts](/Users/derick/shearsync-api/src/services/entitlementsService.ts)
- [src/routes/accountRoutes.ts](/Users/derick/shearsync-api/src/routes/accountRoutes.ts)
- [src/controllers/accountController.ts](/Users/derick/shearsync-api/src/controllers/accountController.ts)
- [src/validators/accountValidators.ts](/Users/derick/shearsync-api/src/validators/accountValidators.ts)
- [src/services/stylistsService.ts](/Users/derick/shearsync-api/src/services/stylistsService.ts)
- [src/services/profileOverviewService.ts](/Users/derick/shearsync-api/src/services/profileOverviewService.ts)
- [src/types/api.ts](/Users/derick/shearsync-api/src/types/api.ts)
