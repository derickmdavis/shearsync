# Frontend Referrals Contract

This is the frontend integration contract for client referral links and public booking attribution.

## Referral Program Settings

```http
GET /api/settings/referrals
PATCH /api/settings/referrals
```

`GET` is authenticated and returns the persisted setup state for any account.
`PATCH` is restricted to accounts with `data.features.referrals === true` from
`GET /api/account/plan` (Pro and Premium). Basic accounts receive `403`.

```ts
type ReferralProgramSettings = {
  enabled: boolean;
  offerName: string | null;
  offerDescription: string | null;
  configured: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  active: boolean;
  program_enabled: boolean;
  offer_configured: boolean;
  thank_you_referral_enabled: boolean;
  active_campaign_count: number;
};
```

`configured` is backend-derived. It becomes `true` only when both a non-empty
`offerName` (maximum 120 characters) and non-empty `offerDescription` (maximum
500 characters) have been saved. `enabled` can be saved independently so the
setup UI can be completed incrementally; it is not proof that a live referral
entry point exists.

`active` is the canonical live-program signal. It is true only for entitled
accounts when at least one of these is active: an enabled configured referral
program, enabled thank-you-email automation, or a referral-link campaign in
the `scheduled` or `sending` lifecycle state. Completed, failed, cancelled,
and draft campaigns do not contribute to `active_campaign_count`.

The patch body accepts any non-empty subset of `enabled`, `offerName`, and
`offerDescription`. Send `null` to clear an offer field.

## Authenticated Client Referral Link

### Get Existing Link

```http
GET /api/clients/:id/referral-link
```

Auth is required. `:id` must be a client owned by the authenticated stylist.

Response:

```ts
type ReferralLinkResponse = {
  data: ReferralLink | null;
};

type ReferralLink = {
  id: string;
  user_id: string;
  client_id: string;
  referral_code: string;
  referral_url: string;
  status: "active" | "disabled" | string;
  source?: "thank_you_email" | "email_campaign" | "direct_share" | "manual" | "client_share" | "unknown" | null;
  created_at: string;
  updated_at: string;
};
```

Use this for initial client-detail rendering. If `data` is `null`, show a "Create referral link" action.

### Create Or Return Link

```http
POST /api/clients/:id/referral-link
```

Auth is required. The endpoint is idempotent: if the client already has an active link, the backend returns it instead of creating a duplicate.

Optional request body:

```ts
type CreateReferralLinkRequest = {
  source?: "thank_you_email" | "email_campaign" | "direct_share" | "manual" | "client_share" | "unknown";
};
```

Use `source: "manual"` when the stylist creates a link from the client profile.

Response:

```ts
type CreateReferralLinkResponse = {
  data: ReferralLink;
};
```

Frontend behavior:

- Disable the create/copy button while the request is in flight.
- After success, render `data.referral_url`.
- Copy/share `data.referral_url`, not just `data.referral_code`.

## Referral Stats

```http
GET /api/clients/:id/referral-stats
```

Auth is required.

Response:

```ts
type ReferralStatsResponse = {
  data: {
    referral_link_id: string | null;
    referral_code: string | null;
    referral_url: string | null;
    opened_count: number;
    booking_attributed_count: number;
  };
};
```

Counts are lightweight and intended for simple client-detail UI. They are not a full analytics report.

## Public Referral Resolution

```http
GET /api/public/referrals/:referralCode?source=direct_share
```

Auth is not required.

The optional `source` query param uses the same source values as referral link creation and lets the backend track how the link was opened.

Response:

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

Recommended public web flow:

1. Add a frontend route such as `/r/:referralCode`.
2. Call `GET /api/public/referrals/:referralCode`.
3. Store `data.referralCode` in the booking flow state.
4. Redirect or navigate to the stylist booking page from `data.bookingUrl`.
5. Preserve the referral code through service, date, time, and contact steps.
6. Send it as `referral_code` in the final booking request.

The backend records an `opened` referral event when this endpoint resolves successfully.

## Final Public Booking

```http
POST /api/public/bookings
```

Existing request fields remain unchanged. The request now also accepts:

```ts
type PublicBookingRequest = {
  stylist_slug: string;
  service_id: string;
  requested_datetime: string;
  guest_first_name: string;
  guest_last_name: string;
  guest_email?: string;
  guest_phone: string;
  booking_context_token?: string;
  referral_code?: string;
  notes?: string;
};
```

Referral behavior:

- `referral_code` is optional.
- Valid format is `rf_` followed by 8-24 alphanumeric characters.
- Invalid, inactive, wrong-stylist, or self-referral codes do not block booking.
- Valid non-self referrals are persisted on the appointment.
- If the booking creates a new client, the new client also gets original referral source fields.

Do not show attribution success/failure to the public guest unless product explicitly wants that. The booking confirmation response shape is unchanged.
