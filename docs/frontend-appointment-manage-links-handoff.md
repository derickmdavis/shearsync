# Short Appointment Manage Links Frontend Handoff

This handoff covers the public booking web app changes needed for short appointment management links in confirmation, reminder, cancellation, and reschedule email flows.

## Goal

Emails should send clients to a short, user-friendly manage appointment URL:

```txt
https://dripdesk.app/manage/{shortCode}
```

The frontend should resolve `{shortCode}` through the backend, render a safe appointment management screen, and allow cancel/reschedule only when the backend says those actions are available.

Legacy JWT manage links must continue to work:

```txt
/appointments/manage/{token}
```

## Backend Endpoints

### Resolve Short Manage Link

```http
GET /api/public/appointment-links/:shortCode
```

Success response:

```ts
type AppointmentActionLinkResolveResponse = {
  valid: true;
  appointment: {
    id: string;
    serviceName: string;
    appointmentDate: string;
    durationMinutes: number;
    status: string;
    price: number;
  };
  stylist: {
    displayName: string;
    slug: string | null;
    timezone: string;
  };
  client: {
    firstName: string;
  };
  allowedActions: {
    canCancel: boolean;
    canReschedule: boolean;
    cancelDisabledReason: string | null;
    rescheduleDisabledReason: string | null;
  };
  policy: {
    cancellationPolicyText: string | null;
    reschedulePolicyText: string | null;
  };
};
```

Invalid or expired response:

```ts
type InvalidAppointmentActionLinkResponse = {
  valid: false;
  reason: "expired" | string;
  message: string;
};
```

The backend intentionally does not return client email, client phone, private notes, internal user IDs, or stylist admin data.

### Cancel By Short Code

```http
POST /api/public/appointment-links/:shortCode/cancel
```

Optional body:

```ts
{
  reason?: string;
}
```

Response uses the same top-level `valid: true` shape as resolve, with the updated appointment status and action availability.

### Reschedule By Short Code

```http
POST /api/public/appointment-links/:shortCode/reschedule
```

Preferred body from web:

```ts
{
  newAppointmentDate: string;
  service_id?: string;
}
```

Compatibility body also accepted:

```ts
{
  requested_datetime: string;
}
```

`newAppointmentDate` / `requested_datetime` must be an ISO datetime with offset, for example:

```txt
2026-06-22T19:00:00.000Z
```

Current backend behavior only changes appointment time/status. It accepts `service_id` for frontend compatibility but does not change the appointment service during reschedule.

## Required Web Routes

### New Short-Code Route

```txt
/manage/[shortCode]
```

Behavior:

1. Read `shortCode` from the route param.
2. Call `GET /api/public/appointment-links/:shortCode`.
3. If `valid === false`, show the backend `message` in a safe invalid-link state.
4. If `valid === true`, render appointment management using the safe payload.
5. Show cancel/reschedule controls based on `allowedActions`.

### Legacy Route

Keep existing route behavior:

```txt
/appointments/manage/[token]
```

Legacy links already sent by email should keep working. Do not route JWT tokens through the new short-code endpoint.

## UI Requirements

The `/manage/[shortCode]` page should show:

- Service name
- Appointment date/time, formatted in `stylist.timezone`
- Duration
- Price, if the existing UI already displays appointment price
- Stylist display name
- Client first-name greeting, if useful
- Appointment status
- Cancel button when `allowedActions.canCancel === true`
- Reschedule button when `allowedActions.canReschedule === true`
- Disabled messaging from:
  - `allowedActions.cancelDisabledReason`
  - `allowedActions.rescheduleDisabledReason`
  - `policy.cancellationPolicyText`
  - `policy.reschedulePolicyText`

Do not show:

- Client email or phone
- Internal user IDs
- Raw appointment/client/stylist IDs outside internal state
- Legacy JWT token
- Backend debugging details

## Error Handling

For `GET /api/public/appointment-links/:shortCode`:

- `200` with `valid: false`: show invalid/expired state with `message`.
- `404`, `410`, or other non-2xx: show a generic invalid-link state.
- Network error: show retry affordance if the app has one.

Suggested invalid-link copy:

```txt
This appointment link is no longer available. Please contact your stylist.
```

Prefer backend `message` when provided.

## Cancel Flow

When `canCancel` is true:

1. Ask for confirmation before calling cancel.
2. Call `POST /api/public/appointment-links/:shortCode/cancel`.
3. Replace local appointment state from the response.
4. Show success state.
5. Disable cancel/reschedule if the returned `allowedActions` says they are no longer available.

If the backend returns an error, show the backend message when safe.

## Reschedule Flow

The web app can either:

- Use the existing public reschedule UI and submit to the short-code endpoint, or
- Keep the user on `/manage/[shortCode]` and show a date/time picker.

When submitting:

```ts
await api.post(`/api/public/appointment-links/${shortCode}/reschedule`, {
  newAppointmentDate: selectedSlotStart,
  service_id: selectedServiceId
});
```

After success:

- Replace local appointment state from the response.
- Show updated date/time.
- Respect returned `allowedActions`.

Important: existing availability and scheduling policy checks remain backend-owned. The frontend should not assume a slot is valid after display; it must handle backend rejection.

## Email Link Expectations

New backend emails now prefer:

```txt
/manage/{shortCode}
```

Email rendering also includes a “Manage Appointment” CTA and a fallback plain text manage URL.

The frontend should not generate short codes and should not create appointment action links directly.

## Acceptance Checks

- `/manage/:shortCode` calls `GET /api/public/appointment-links/:shortCode`.
- Valid responses render appointment details without exposing private client/contact fields.
- Invalid or expired responses show a safe invalid-link screen.
- Cancel uses `POST /api/public/appointment-links/:shortCode/cancel`.
- Reschedule uses `POST /api/public/appointment-links/:shortCode/reschedule`.
- `newAppointmentDate` is accepted as the reschedule datetime field.
- Disabled action reasons from the backend are shown or reflected in disabled controls.
- Existing `/appointments/manage/:token` legacy route still works.
- Frontend tests cover short-code resolve, cancel, reschedule, invalid-link handling, and legacy route compatibility.

## Backend References

- Service: `src/services/appointmentActionLinksService.ts`
- Public management logic: `src/services/publicAppointmentManagementService.ts`
- Public routes: `src/routes/publicRoutes.ts`
- Email queue integration: `src/services/appointmentEmailEventsService.ts`
- Email rendering: `src/services/appointmentEmailDeliveryService.ts`
- Migration: `supabase/migrations/202606210002_appointment_action_links.sql`
