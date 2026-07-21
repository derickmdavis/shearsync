# Frontend Codex Handoff: Referrals UI Integration

This is the implementation brief for connecting the DripDesk web UI to the backend referral work.

The backend foundation is in place. The frontend should not generate referral codes, referral URLs, QR codes, or attribution records. It should call the backend endpoints, preserve the returned referral code through booking, and render the referral metrics the backend returns.

## Goals

Add a shippable referral experience across four surfaces:

1. CRM client detail: create, display, copy, and share a client's referral link.
2. Public referral route: resolve `/r/:referralCode` and hand the visitor into public booking.
3. Public booking: preserve `referral_code` through the flow and submit it with the final booking request.
4. Activity: show this month's account-level referral stats from the new dedicated endpoint.

Thank-you emails already include referral link/QR snapshots on the backend. The frontend should only use the existing thank-you email docs if it is also wiring the automation UI.

## Backend Endpoints

### Client Referral Link

```http
GET /api/clients/:id/referral-link
POST /api/clients/:id/referral-link
GET /api/clients/:id/referral-stats
```

Auth required. `:id` is the CRM client id.

`POST /api/clients/:id/referral-link` accepts an optional body:

```ts
type CreateReferralLinkRequest = {
  source?: ReferralSource;
};
```

Use `source: "manual"` when the stylist explicitly creates a link from the client profile. If no source is sent, the backend defaults to `client_share`.

### Public Referral Resolver

```http
GET /api/public/referrals/:referralCode?source=direct_share
```

No auth required. This validates an active referral code and returns the booking handoff data.

The optional `source` query param lets the frontend tell the backend how the visitor arrived when known. Recommended values:

- `direct_share`: visitor opened a shared `/r/:referralCode` URL.
- `thank_you_email`: visitor came from a thank-you email link.
- `email_campaign`: visitor came from a campaign email.
- `client_share`: a client-share surface created the link.
- `manual`: stylist-created/manual link.
- `unknown`: fallback.

### Final Public Booking

```http
POST /api/public/bookings
```

The existing request accepts optional:

```ts
referral_code?: string;
```

Invalid, inactive, wrong-stylist, expired, or self-referral codes do not block booking. Attribution is additive. The public confirmation response shape is unchanged.

### Activity Referral Stats

```http
GET /api/activity/referrals?range=this_month
```

Auth required. This is intentionally separate from `GET /api/activity/dashboard`.

### Referral Impact State Resolution

For Referral Impact, load all three authenticated read models:

- `GET /api/account/plan`
- `GET /api/settings/referrals`
- `GET /api/insights?referral_period=...`

Resolve the card state exactly as follows:

```ts
if (!accountPlan.features.referrals) {
  return "hidden";
}

if (!referralProgram.configured || !referralProgram.active) {
  return "setup_required";
}

if (!referralMetrics.available) {
  return "metrics_unavailable"; // show the retry state; do not show setup
}

if (!referralMetrics.historical_results.has_successful_conversions) {
  return "active_no_conversions";
}

return "active_with_results";
```

`available: false` is only an Insights delivery/calculation state: the
referral Insights section is disabled or metrics could not be calculated. It
does not mean no entitlement, incomplete setup, no current-period activity,
or no historical conversions. When `available: true`, zero-valued count
metrics are valid results. `conversion_rate_percent` remains `null` when the
selected period had no referral-link opens.

## Shared Types

Use these frontend types or equivalent generated API types.

```ts
type ReferralSource =
  | "thank_you_email"
  | "email_campaign"
  | "direct_share"
  | "manual"
  | "client_share"
  | "unknown";

type ReferralLink = {
  id: string;
  user_id: string;
  client_id: string;
  referral_code: string;
  referral_url: string;
  status: "active" | "disabled" | string;
  source?: ReferralSource | null;
  created_at: string;
  updated_at: string;
};

type ReferralLinkResponse = {
  data: ReferralLink | null;
};

type CreateReferralLinkResponse = {
  data: ReferralLink;
};

type ClientReferralStatsResponse = {
  data: {
    referral_link_id: string | null;
    referral_code: string | null;
    referral_url: string | null;
    opened_count: number;
    booking_attributed_count: number;
  };
};

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

type ActivityReferralStatsResponse = {
  data: {
    hasReferralData: boolean;
    range: "this_month";
    newClientsFromReferrals: number;
    appointmentsBookedFromReferrals: number;
    revenueFromReferrals: number;
    bookedValueFromReferrals: number;
    referralConversionRate: number;
    linksSent: number;
    linksClicked: number;
    topReferrer: {
      clientId: string;
      displayName: string;
      referralCount: number;
    } | null;
  };
};
```

## Surface 1: Client Detail Referral UI

Add a referral section to the CRM client detail view.

Recommended placement:

- Near client contact details or appointment history.
- Keep it compact: title, current link or empty state, copy/share actions, and optional stats.
- Do not make the referral section the dominant page element.

Initial load:

1. When client detail loads, call `GET /api/clients/:id/referral-link`.
2. If `data` is a link, render it.
3. If `data` is `null`, show a create action.
4. Optionally call `GET /api/clients/:id/referral-stats` after the link is loaded or when the section becomes visible.

Create link:

```ts
await api.post(`/api/clients/${clientId}/referral-link`, {
  source: "manual"
});
```

Expected behavior:

- Disable the create button while the request is in flight.
- If successful, replace the empty state with `data.referral_url`.
- If the backend returns an existing active link, treat it as success.
- Copy/share the exact `referral_url` returned by the backend.
- Do not construct `/r/...` URLs in the frontend for this surface.

Suggested UI labels:

- Section title: `Referrals`
- Empty state: `Create a referral link for this client.`
- Primary action: `Create link`
- Link label: `Referral link`
- Stats labels: `Opens`, `Attributed bookings`

Suggested states:

- Loading: skeleton or compact spinner in the section.
- Empty: create action.
- Ready: URL, copy action, share action when `navigator.share` is available, optional stats.
- Error: inline retry with a concise message.

Copy behavior:

```ts
await navigator.clipboard.writeText(referralLink.referral_url);
```

Share behavior:

```ts
if (navigator.share) {
  await navigator.share({
    title: "Book with me",
    text: "Here is my booking link.",
    url: referralLink.referral_url
  });
}
```

## Surface 2: Public `/r/:referralCode` Route

Add a public route:

```txt
/r/:referralCode
```

Route behavior:

1. Read `referralCode` from the route param.
2. Resolve it with `GET /api/public/referrals/:referralCode?source=direct_share`.
3. Store `data.referralCode` for the booking flow.
4. Navigate to the stylist booking page.

Preferred navigation:

- Use `data.bookingUrl` if the app can safely navigate to it.
- Otherwise navigate to `/book/${data.stylistSlug}?ref=${data.referralCode}`.

Do not expose the referring client's identity on this public page. The backend intentionally does not return it.

Invalid resolver state:

- Show a friendly invalid-link screen.
- Include a generic action back to public booking discovery if the product has one.
- Do not tell the visitor whether a code was disabled, expired, or otherwise invalid.

## Surface 3: Public Booking Referral State

The booking flow should read referral code from:

1. The URL query param: `?ref=rf_...`
2. State/session storage written by `/r/:referralCode`

Preserve the code through:

- stylist booking page load
- service selection
- date/time selection
- client/contact form
- browser back/forward navigation
- final booking submission

Recommended session storage key:

```ts
const referralStorageKey = `referral:${stylistSlug}`;
```

Recommended storage value:

```ts
type StoredReferral = {
  referralCode: string;
  capturedAt: string;
  expiresAt?: string;
};
```

Use the backend `expiresAt` as a UI handoff hint only. The backend revalidates the referral code on final booking. Do not block booking solely because the frontend thinks the referral code expired.

Final booking payload:

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

Public UX rule:

- Do not show whether referral attribution succeeded.
- Booking should still complete when referral state is missing, invalid, or rejected as self-referral.
- The confirmation screen should remain unchanged unless product explicitly designs a referral-specific state.

## Surface 4: Activity Referral Stats

Add a referral stats module to the authenticated Activity area.

Endpoint:

```http
GET /api/activity/referrals?range=this_month
```

Recommended placement:

- Activity screen referral insights panel or section.
- Keep separate from the existing `GET /api/activity/dashboard` load path unless the frontend already has an Activity data composition layer.

Metric display:

- `newClientsFromReferrals`: `New clients`
- `appointmentsBookedFromReferrals`: `Bookings`
- `revenueFromReferrals`: `Revenue`
- `bookedValueFromReferrals`: `Booked value`
- `referralConversionRate`: `Conversion`
- `linksSent`: `Links created`
- `linksClicked`: `Clicks`
- `topReferrer`: `Top referrer`

Formatting:

- Treat `referralConversionRate` as a decimal ratio. Display `0.5` as `50%`.
- Format `revenueFromReferrals` and `bookedValueFromReferrals` as money using the app's existing currency formatter.
- If `topReferrer` is `null`, hide that row or show a neutral empty value.

Empty state:

Use `hasReferralData`.

Suggested copy:

- Empty title: `No referral activity yet`
- Empty body: `Create referral links from client profiles and activity will show up here.`

Do not calculate these stats in the frontend from client lists or appointments. Use the endpoint so definitions stay consistent.

## Thank-You Email Touchpoints

If the frontend Codex is also wiring thank-you email automation, use the separate docs:

- `docs/frontend-thank-you-email-automation-controls-handoff.md`
- `docs/frontend-thank-you-emails-contract.md`

Important referral-specific rules:

- The backend creates or reuses the client's referral link when queueing thank-you emails.
- The backend snapshots `referral_code`, `referral_url`, and QR data on the thank-you email row.
- The frontend should render backend snapshots for sent/queued thank-you emails.
- The frontend should not generate QR codes for sent emails.

If a thank-you email link opens `/r/:referralCode`, pass `source=thank_you_email` to the public resolver when possible.

## Suggested API Helper Functions

```ts
async function getClientReferralLink(clientId: string): Promise<ReferralLink | null> {
  const response = await api.get<ReferralLinkResponse>(`/api/clients/${clientId}/referral-link`);
  return response.data.data;
}

async function createClientReferralLink(clientId: string): Promise<ReferralLink> {
  const response = await api.post<CreateReferralLinkResponse>(
    `/api/clients/${clientId}/referral-link`,
    { source: "manual" satisfies ReferralSource }
  );
  return response.data.data;
}

async function getClientReferralStats(clientId: string): Promise<ClientReferralStatsResponse["data"]> {
  const response = await api.get<ClientReferralStatsResponse>(`/api/clients/${clientId}/referral-stats`);
  return response.data.data;
}

async function resolvePublicReferral(
  referralCode: string,
  source: ReferralSource = "direct_share"
): Promise<PublicReferralResponse["data"]> {
  const response = await publicApi.get<PublicReferralResponse>(
    `/api/public/referrals/${encodeURIComponent(referralCode)}`,
    { params: { source } }
  );
  return response.data.data;
}

async function getActivityReferralStats(): Promise<ActivityReferralStatsResponse["data"]> {
  const response = await api.get<ActivityReferralStatsResponse>(
    "/api/activity/referrals",
    { params: { range: "this_month" } }
  );
  return response.data.data;
}
```

## Recommended Implementation Order

1. Add shared referral API helpers and types.
2. Add client detail referral section with create/copy behavior.
3. Add `/r/:referralCode` public route and resolver state.
4. Thread `referral_code` through public booking state and final submit.
5. Add Activity referral stats module.
6. Connect thank-you email referral source handling only if that UI path is in scope.

## Error Handling

Authenticated endpoints:

- `401`: send user through existing auth handling.
- `403`: show existing plan/access messaging if applicable.
- `404`: for client referral endpoints, treat as unavailable client or stale route.
- `500`: inline retry and log through existing app error handling.

Public resolver:

- `404` or `409`: show generic invalid-link state.
- Network failure: show retry.
- Do not auto-submit booking without user confirmation.

Final booking:

- Keep existing booking error handling.
- Do not add special referral-specific error handling. The backend intentionally treats bad referral codes as non-blocking.

## Acceptance Checklist

Client detail:

- Existing referral link displays on page load.
- Client without a link can create one.
- Creating twice does not create duplicate UI or duplicate assumptions.
- Copy action copies `referral_url`.
- Share action uses `referral_url`.
- Optional client stats show opens and attributed bookings.

Public referral route:

- `/r/:referralCode` resolves a valid code.
- Resolver calls include `source=direct_share` unless a more specific source is known.
- Valid code sends visitor to the correct stylist booking URL with `ref`.
- Invalid code shows a generic invalid-link state.

Public booking:

- Booking flow reads `?ref=...`.
- Referral code survives service/date/contact steps.
- Final `POST /api/public/bookings` includes `referral_code` when present.
- Final booking still succeeds if no referral code exists.
- Public confirmation screen remains unchanged.

Activity:

- Activity referrals module calls `GET /api/activity/referrals?range=this_month`.
- Empty state uses `hasReferralData`.
- Revenue and booked value are currency formatted.
- Conversion rate displays as a percentage.
- Top referrer displays only when present.

Regression:

- Existing client detail, public booking, and Activity dashboard flows still load without referral data.
- No frontend code generates referral codes, referral URLs, attribution rows, or QR snapshots.

## Backend References

- Main referral API contract: `docs/frontend-referrals-contract.md`
- Public referral web handoff: `docs/frontend-referrals-web-handoff.md`
- Activity referral stats contract: `docs/frontend-activity-referrals-contract.md`
- Thank-you automation controls: `docs/frontend-thank-you-email-automation-controls-handoff.md`
- Thank-you email contract: `docs/frontend-thank-you-emails-contract.md`
