# Public Booking Client Context Handoff

This note is the frontend integration contract for the public booking flow after the backend change that added client-aware service and slot filtering.

## Goal

The public web app must determine whether the guest is a returning client before showing services and slots.

The backend now supports that by minting a short-lived `bookingContextToken` from intake and requiring the frontend to pass it into the service and slot requests.

## Required Flow

1. Load stylist profile with `GET /api/public/stylists/:slug`.
2. Read `data.booking_enabled` from the profile response.
3. If `booking_enabled` is `false`, do not call services, raw availability, slots, or final booking create. Show an "online booking unavailable" state instead.
4. Collect guest contact details.
5. Call `POST /api/public/booking-intake`.
6. Read `data.isExistingClient`, `data.bookingContextToken`, and `data.bookingEnabled` from the intake response.
7. If `bookingEnabled` is `false`, do not call services, raw availability, slots, or final booking create. Show an "online booking unavailable" state instead.
8. Call `GET /api/public/services/:slug?booking_context_token=...`.
9. If the page needs raw weekly availability, call `GET /api/public/availability/:slug?booking_context_token=...`.
10. After the guest picks a service, call `GET /api/public/availability/:slug/slots?service_id=...&date=YYYY-MM-DD&booking_context_token=...`.
11. Submit the final booking with `POST /api/public/bookings`.

If the guest edits their name, phone, or email after intake, the web app should run intake again and replace the old `bookingContextToken`.

## Endpoint Changes

### 1. Intake response

`POST /api/public/booking-intake` now returns a new field:

```json
{
  "data": {
    "matchStatus": "matched",
    "clientFound": true,
    "isExistingClient": true,
    "bookingContextToken": "<signed-token>",
    "bookingEnabled": true
  }
}
```

Notes:

- `bookingContextToken` is short-lived.
- It is scoped to the stylist slug used during intake.
- The web app should treat it as opaque.
- `bookingEnabled` is the backend-confirmed current toggle state for online booking.

### 2. Services endpoint

`GET /api/public/services/:slug` now accepts an optional query param:

```text
booking_context_token
```

Behavior:

- when online booking is disabled for the stylist, the backend returns `400`
- with a valid token for a returning client, all active public services are returned
- with a valid token for a new client, restricted services are filtered out
- without a token, the backend falls back to new-client filtering
- with an invalid or expired token, the backend returns `400`

### 3. Raw availability endpoint

`GET /api/public/availability/:slug` accepts the same optional `booking_context_token` query param.

Behavior:

- when online booking is disabled for the stylist, the backend returns `400`
- with a valid returning-client token, raw windows include `all` and `returning` audiences
- with a valid new-client token, raw windows include `all` and `new` audiences
- without a token, the backend falls back to new-client filtering
- otherwise, active weekly availability rows are returned

### 4. Slots endpoint

`GET /api/public/availability/:slug/slots` now accepts:

```text
service_id
date
booking_context_token
```

Behavior:

- when online booking is disabled for the stylist, the backend returns `400`
- with a valid returning-client token, slot rules use returning-client behavior
- with a valid new-client token, slot rules use new-client behavior
- audience-specific availability windows are applied using that same token
- without a token, the backend falls back to new-client behavior
- with an invalid or expired token, the backend returns `400`

## Frontend Expectations

- Do not infer service visibility from `isExistingClient` in the browser alone. Always use the backend-filtered services response.
- Do not infer slot eligibility in the browser. Always use the backend-filtered slots response.
- Keep the same `bookingContextToken` for the service and slot calls that belong to the same intake result.
- Treat `booking_enabled` from the profile response and `bookingEnabled` from the intake response as hard stops for the booking flow.
- If the backend returns `400` for an invalid or expired booking context token, rerun intake and retry the services or slots request with the fresh token.
- `POST /api/public/bookings` does not take the token. Final booking creation still performs its own backend-side client match and rule validation.

## Suggested Web App State Shape

```ts
type BookingIntakeState = {
  fullName: string;
  phone: string;
  email?: string;
  isExistingClient: boolean;
  bookingContextToken: string;
  recommendedService?: {
    serviceId: string;
    serviceName: string;
    reason: "last_completed_service" | "last_booked_service" | "default_service";
  } | null;
};
```

## Suggested Request Examples

### Intake

```http
POST /api/public/booking-intake
Content-Type: application/json

{
  "stylist_slug": "maya-johnson",
  "full_name": "Jane Smith",
  "phone": "(720) 555-0103",
  "email": "jane@example.com"
}
```

### Services

```http
GET /api/public/services/maya-johnson?booking_context_token=<token>
```

### Slots

```http
GET /api/public/availability/maya-johnson/slots?service_id=<service-id>&date=2026-05-11&booking_context_token=<token>
```

## Failure Handling

- `400 Online booking is not enabled for this stylist`
  Stop the booking flow and show a disabled-booking state. Do not retry services or slots until the stylist turns booking back on.

- `400 Booking context is invalid or expired`
  The web app should rerun intake and refresh the token.

- `400 Selected service is not available`
  The selected service is stale or no longer allowed for the current context.

- empty `slots`
  Treat this as a valid response. It means there are no bookable starts for that date under the current rules.
