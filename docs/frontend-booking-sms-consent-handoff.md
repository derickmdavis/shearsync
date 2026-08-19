# Public Booking SMS Consent Handoff

## Purpose

Wire the existing appointment-SMS checkbox into the final public-booking request.
The backend supports this contract after migration `202608180006_public_booking_sms_consent.sql` is applied.

## API contract

Use the existing endpoint; there is no separate consent endpoint.

```http
POST /api/public/bookings
Content-Type: application/json
```

Add one optional field to the existing request body:

```ts
type CreatePublicBookingBody = {
  stylist_slug: string;
  service_id: string;
  requested_datetime: string;
  guest_first_name: string;
  guest_last_name: string;
  guest_email?: string;
  guest_phone: string;
  booking_context_token?: string;
  referral_code?: string;
  sms_opt_in?: boolean;
  notes?: string;
};
```

Always submit the current checkbox state:

```ts
sms_opt_in: smsOptIn,
```

`false` (or an omitted field) does not opt the guest out or modify an existing SMS preference. `true` grants consent only for appointment transactional and reminder texts. It does not enable promotional, marketing, or rebooking SMS.

The booking response is unchanged.

## Required component changes

The current `ConfirmStep` owns `smsOptIn` as local state, so `BookingFlow` cannot include it in the API request. Lift that state into `BookingFlow`.

1. In `BookingFlow.tsx`, add state next to the rest of the booking-form state:

```ts
const [smsOptIn, setSmsOptIn] = useState(false);
```

2. Pass it to `ConfirmStep`:

```tsx
<ConfirmStep
  // existing props
  smsOptIn={smsOptIn}
  onSmsOptInChange={setSmsOptIn}
/>
```

3. Change `ConfirmStepProps` and remove its local `useState(false)` for SMS:

```ts
type ConfirmStepProps = {
  // existing props
  smsOptIn: boolean;
  onSmsOptInChange: (value: boolean) => void;
};
```

4. Keep the checkbox controlled by those props:

```tsx
<input
  type="checkbox"
  name="appointment-sms-consent"
  checked={smsOptIn}
  disabled={submitting}
  onChange={(event) => onSmsOptInChange(event.target.checked)}
/>
```

5. Add the field to the `createPublicBooking(...)` payload in `BookingFlow.tsx`:

```ts
const response = await createPublicBooking(
  {
    // existing booking fields
    sms_opt_in: smsOptIn,
  },
  { idempotencyKey },
);
```

## Disclosure copy

The visible copy must remain exactly equivalent to the server-audited disclosure:

> I agree to receive appointment-related text messages. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help. See our Terms of Service.

Keep the existing Terms of Service link to `${getMarketingOrigin()}/terms-of-service`.

Do not send disclosure text, a disclosure version, client IDs, or stylist IDs from the browser. The API owns and records those values, which prevents browser-controlled audit records.

## Booking behavior and retries

- Keep the checkbox unchecked by default.
- Do not require it to complete a booking.
- Preserve its value while the visitor remains in the confirmation step.
- Submit the same value if the booking request is retried.
- Use the existing booking idempotency behavior as-is. The backend prevents duplicate consent events for the same public appointment and phone number.
- Render backend booking errors normally. Do not show a separate client-side "SMS subscribed" success state, because consent is part of the successful booking request.

## Tests to add or update

1. `api.ts`: `CreatePublicBookingBody` accepts `sms_opt_in`, and `createPublicBooking` serializes it.
2. `BookingFlow.test.tsx`:
   - The checkbox starts unchecked.
   - Toggling it to checked sends `sms_opt_in: true` to `createPublicBooking`.
   - Leaving it unchecked sends `sms_opt_in: false`.
   - The disclosure and Terms link remain present.
3. Run the booking-web typecheck, lint, and booking-flow test suite.

## Out of scope

- No SMS marketing opt-in is created by this checkbox.
- No new API endpoint or response field is required.
- STOP/HELP handling is backend/provider-owned; the frontend only displays the disclosure.
