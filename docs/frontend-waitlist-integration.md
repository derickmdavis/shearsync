# Frontend Waitlist Integration

This document covers the stylist settings toggle and the public booking page behavior.

## Source Of Truth

Waitlist availability has three layers:

- Plan entitlement: `GET /api/account/plan` -> `data.features.waitlist`
- Stylist setting: `public.users.waitlist_enabled`, exposed as `data.settings.waitlistEnabled`
- Effective availability: `data.effectiveFeatures.waitlistEnabled` for authenticated app UI and `data.features.waitlistEnabled` on public stylist metadata

The backend treats waitlist as usable only when all of these are true:

- the user's tier allows waitlist, currently Pro or Premium
- `plan_status` is not `cancelled`
- `users.waitlist_enabled` is `true`

## Stylist App Toggle

Load the current setting:

```http
GET /api/settings/profile
```

Read:

```ts
profile.waitlist_enabled
```

Update the toggle:

```http
PATCH /api/settings/profile
Content-Type: application/json
```

```json
{
  "waitlist_enabled": false
}
```

or:

```json
{
  "waitlist_enabled": true
}
```

The response is the updated raw user profile:

```json
{
  "data": {
    "id": "uuid",
    "email": "stylist@example.com",
    "plan_tier": "pro",
    "plan_status": "active",
    "waitlist_enabled": true
  }
}
```

Recommended toggle UI:

- Call `GET /api/account/plan`.
- If `data.features.waitlist === false`, hide the toggle or show an upgrade prompt.
- If `data.features.waitlist === true`, show the toggle using `data.settings.waitlistEnabled`.
- If `data.status === "cancelled"`, show the toggle as unavailable or disabled because public waitlist remains off.
- Treat `data.effectiveFeatures.waitlistEnabled` as the current authenticated app capability.

Important: Basic users may technically save `waitlist_enabled=true`, but `effectiveFeatures.waitlistEnabled` remains false until their plan allows waitlist.

## Public Booking Page

Load public stylist metadata:

```http
GET /api/public/stylists/:slug
```

Relevant response fields:

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

Show public waitlist UI only when:

```ts
profile.booking_enabled === true && profile.features.waitlistEnabled === true
```

Do not compute public waitlist availability from `plan_tier` in the frontend. The public endpoint already combines plan eligibility, cancelled status, and the stylist setting.

## Public Waitlist Create

Submit public waitlist requests through the backend API:

```http
POST /api/public/stylists/:slug/waitlist
Content-Type: application/json
```

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

Required fields:

- `requestedDate`
- `clientName`
- at least one of `clientEmail` or `clientPhone`

Optional fields:

- `serviceId`
- `requestedTimePreference`
- `note`

Expected failure cases:

- `403` when the stylist's plan does not allow waitlist, the account is cancelled, or the stylist has turned waitlist off
- `400` for invalid requested dates, invalid contact payloads, or service ownership problems
- `409` when the same client is already active on the waitlist for the same date and service

## Supabase RLS Note

Do not insert into `waitlist_entries` directly from the public browser app:

```ts
supabase.from("waitlist_entries").insert(...)
```

Anonymous public users will fail RLS by design. The public frontend must call:

```http
POST /api/public/stylists/:slug/waitlist
```

The backend validates the request and inserts with the server-side Supabase admin client.
