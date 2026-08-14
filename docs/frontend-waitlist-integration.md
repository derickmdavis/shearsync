# Frontend Waitlist Integration

This document covers the stylist settings toggle and the public booking page behavior.

## Source Of Truth

Waitlist availability has two layers:

- Account access: `GET /api/account/access` -> `data.isActive`
- Stylist setting: `public.users.waitlist_enabled`

The backend treats waitlist as usable only when all of these are true:

- the stylist account is active
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
    "waitlist_enabled": true
  }
}
```

Recommended toggle UI:

- Call `GET /api/account/access`.
- If `data.isActive === false`, do not show the toggle; product routes are unavailable.
- Otherwise, show the toggle using `profile.waitlist_enabled`.

The API enforces active-account access; the frontend should not infer access from plan fields.

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

Do not compute public waitlist availability from account fields in the frontend. The public endpoint already combines account access and the stylist setting.

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
