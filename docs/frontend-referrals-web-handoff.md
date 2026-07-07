# Referral Tracking Web Frontend Handoff

This handoff explains the web app changes needed to support client referral links and public booking attribution.

For the complete implementation brief, including Activity referral stats and source tracking, see `docs/frontend-referrals-ui-codex-handoff.md`.

## Goal

Let stylists create/share a referral link from a client profile, let public visitors enter through that link, and carry the referral code through public booking so the backend can attribute the booking.

The backend work is already in place.

## Backend Endpoints

### Client Referral Link

```http
GET /api/clients/:id/referral-link
POST /api/clients/:id/referral-link
GET /api/clients/:id/referral-stats
```

Auth is required. `:id` is the CRM client id.

Use `GET` on client detail load. If it returns `data: null`, show a create action. Use `POST` to create or return the active link.

### Public Referral Resolver

```http
GET /api/public/referrals/:referralCode
```

No auth required. This resolves a referral code and returns the target booking URL.

### Final Booking

```http
POST /api/public/bookings
```

The final booking payload now accepts optional:

```ts
referral_code?: string;
```

Invalid, inactive, wrong-stylist, or self-referral codes do not block booking. The confirmation response shape is unchanged.

### Automated Thank You Emails

Authenticated Pro and Premium stylists can also enable thank-you emails that include the client's referral link and QR code after completed appointments.

This is a separate authenticated automation surface from public referral attribution. The web app should treat it like an approved automation pipeline:

- Settings and preview live at `GET/PATCH/POST /api/settings/thank-you-emails`.
- The approval queue lives at `GET /api/thank-you-emails`.
- Pending rows are approved with `POST /api/thank-you-emails/:id/approve`.
- Rows can be cancelled with `POST /api/thank-you-emails/:id/cancel`.
- The Activity automation toggle key is `thank_you_emails`.
- The backend generates referral links and QR snapshots; the frontend should not generate either for sent emails.

See `docs/frontend-thank-you-email-automation-controls-handoff.md` for the Automations Controls screen handoff, and `docs/frontend-thank-you-emails-contract.md` for the full API contract.

## Required Web Changes

### 1. Client Detail Referral UI

Add a referral section to the CRM client detail view.

Recommended behavior:

1. On client detail load, call `GET /api/clients/:id/referral-link`.
2. If `data` exists, render:
   - referral URL
   - copy button
   - share button if the platform supports it
3. If `data` is `null`, render a “Create referral link” button.
4. On click, call `POST /api/clients/:id/referral-link`.
5. Replace the empty state with the returned link.
6. Optionally call `GET /api/clients/:id/referral-stats` for basic counts.

Suggested copy:

- Empty state: “Create a referral link for this client.”
- Link label: “Referral link”
- Stats labels: “Opens” and “Attributed bookings”

Do not let the frontend generate referral codes. Always use the backend response.

### 2. Public Referral Route

Add a public route in the web app:

```txt
/r/:referralCode
```

Route behavior:

1. Read `referralCode` from the route param.
2. Call `GET /api/public/referrals/:referralCode`.
3. Store `data.referralCode` in booking state.
4. Navigate to the stylist booking page.

The backend response includes:

```ts
type PublicReferralResponse = {
  data: {
    referralLinkId: string;
    referralCode: string;
    referralUrl: string;
    stylistSlug: string;
    bookingUrl: string;
    expiresAt: string;
  };
};
```

Preferred navigation:

- If the frontend can safely handle `data.bookingUrl`, navigate there.
- Otherwise navigate to `/book/${data.stylistSlug}?ref=${data.referralCode}`.

Show a normal error state if the code is invalid or expired.

### 3. Booking Flow Referral State

The public booking flow should read referral code from:

1. `?ref=rf_...`
2. referral route state/session storage if redirected from `/r/:referralCode`

Keep the code through:

- stylist profile load
- booking intake
- service selection
- date/time selection
- contact form
- final booking submit
- browser back/forward navigation

Recommended storage:

- URL query param is best when possible.
- Session storage is acceptable as a fallback for multi-step flows.
- Scope session storage by stylist slug so one referral does not leak into another stylist’s booking page.

Example key:

```ts
`referral:${stylistSlug}`
```

### 4. Final Booking Submit

When calling `POST /api/public/bookings`, include `referral_code` only if a referral code is present:

```ts
const payload = {
  stylist_slug: stylistSlug,
  service_id: selectedServiceId,
  requested_datetime: selectedSlotStart,
  guest_first_name: firstName,
  guest_last_name: lastName,
  guest_email: email || undefined,
  guest_phone: phone,
  booking_context_token: bookingContextToken || undefined,
  referral_code: referralCode || undefined,
  notes: notes || undefined
};
```

Do not block booking if referral state is missing. Referral attribution is additive.

## UX Notes

- Do not show the public guest whether attribution succeeded or failed.
- Do show a friendly invalid-link state on `/r/:referralCode` if the resolver fails.
- Do not expose the referring client’s name on the public route unless product explicitly wants that. The current backend response intentionally does not include it.
- Copy/share actions should use `referral_url` exactly as returned by the backend.

## Suggested Types

```ts
type ReferralLink = {
  id: string;
  user_id: string;
  client_id: string;
  referral_code: string;
  referral_url: string;
  status: string;
  created_at: string;
  updated_at: string;
};

type ReferralStats = {
  referral_link_id: string | null;
  referral_code: string | null;
  referral_url: string | null;
  opened_count: number;
  booking_attributed_count: number;
};
```

## Acceptance Checks

- Client detail can create a referral link for a client.
- Refreshing client detail shows the existing referral link instead of creating a duplicate.
- Copy button copies the backend `referral_url`.
- `/r/:referralCode` resolves and sends the visitor into the correct stylist booking flow.
- Booking URL/state preserves `referral_code` through service and slot selection.
- Final booking request includes `referral_code`.
- Final booking still succeeds if the referral code is missing, invalid, or expired.
- Booking confirmation UI remains unchanged.

## Backend References

- Main contract: `docs/frontend-referrals-contract.md`
- Thank-you automation controls handoff: `docs/frontend-thank-you-email-automation-controls-handoff.md`
- Thank-you email automation contract: `docs/frontend-thank-you-emails-contract.md`
- Full backend spec: `docs/backend-api-and-booking-logic-spec.md`
- Public booking endpoint: `POST /api/public/bookings`
