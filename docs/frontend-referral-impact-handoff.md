# Referral Impact Frontend Handoff

This is the integration contract for the Referral Impact module on the
authenticated Insights screen.

Referral Impact is fully server-driven. The frontend owns layout, state
selection, safe icon rendering, retry behavior, and navigation. The backend
owns metric count, order, labels, formatted values, supporting copy, tones,
accessibility labels, and highlight content.

## Release and cutover

This is a full cutover. The active Insights contract version is `2026-07-22`.
Do not retain a compatibility parser or consume legacy Referral Impact fields.

Fetch these three authenticated read models when rendering the screen:

```http
GET /api/account/plan
GET /api/settings/referrals
GET /api/insights?referral_period=this_month|all_time
```

The Insights response is account-private and returns:

```http
Cache-Control: private, max-age=30, stale-while-revalidate=60
```

Do not send an account, stylist, campaign, or client ID to Insights. Do not
make a separate referral-reporting, client-list, or top-referrer request to
construct this module.

## State selection

Resolve the module state in this exact order:

```ts
if (!plan.features.referrals) {
  return "hidden";
}

if (!referralProgram.configured || !referralProgram.active) {
  return "setup_required";
}

if (!referralInsights.available) {
  return referralInsights.reason === "feature_unavailable"
    ? "hidden"
    : "metrics_unavailable";
}

return referralInsights.has_successful_conversions
  ? "active_with_results"
  : "active_no_conversions";
```

`has_successful_conversions` is lifetime state; it does not change when the
user changes the selected reporting period. A program with historic
conversions and no activity this month is still `active_with_results`.

`available: true` always means valid calculated data. Render zero values; they
are not a loading, setup, or error state.

For `metrics_unavailable`, render the server `message` when present. If
`retry_after_seconds` is provided, wait at least that duration before an
automatic retry. Do not render zero-value metric cards as a fallback.

## Plan entitlement

`GET /api/account/plan` includes:

```ts
type AccountPlan = {
  features: {
    referrals: boolean;
  };
};
```

When `features.referrals` is false, hide Referral Impact entirely. Do not use
missing referral data, zero metrics, or referral-program configuration as an
entitlement proxy.

## Referral-program setup model

`GET /api/settings/referrals` returns the saved referral configuration plus
the canonical setup/active state:

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

  setup_state: {
    icon_key: "referral_program";
    title: string;
    body: string;
    cta_label: string;
    accessibility_label?: string | null;
  };
};
```

When state is `setup_required`, render `setup_state` verbatim. The CTA label
is server-owned; wire it to the existing referral-program setup destination.
The API provides no setup URL.

## Insights Referral Impact model

`GET /api/insights` returns this `data.referrals` section:

```ts
type ReferralsSection = ReferralsAvailable | ReferralsUnavailable;

type ReferralsAvailable = {
  available: true;
  calculated_at?: string;
  period: {
    label: string;
    start_at: string; // UTC ISO-8601 instant
    end_at: string;   // UTC ISO-8601 instant
  };
  has_successful_conversions: boolean;
  metrics: [ReferralMetric, ReferralMetric, ReferralMetric];
  top_referrer: ReferralHighlight | null;
};

type ReferralMetric = {
  id: string;
  icon_key: string;
  display_value: string;
  label: string;
  supporting_text?: string | null;
  semantic_tone?: "default" | "positive" | "neutral" | "warning";
  accessibility_label?: string | null;
};

type ReferralHighlight = {
  client_id: string | null;
  icon_key?: string | null;
  eyebrow?: string | null;
  title: string;
  result_text?: string | null;
  accessibility_label?: string | null;
};

type ReferralsUnavailable = {
  available: false;
  reason:
    | "feature_unavailable"
    | "processing"
    | "temporarily_unavailable"
    | "insufficient_history";
  message?: string;
  retry_after_seconds?: number;
  calculated_at?: string;
};
```

### Metric rendering rules

`metrics` always has exactly three valid entries in backend-defined order.

- Render the array as received; do not sort, filter, append, or reorder it.
- Render `display_value`, `label`, and non-null `supporting_text` verbatim.
- Do not parse, localize, calculate, or otherwise reformat `display_value`.
- Apply the visual treatment from `semantic_tone`; use the default screen
  treatment when it is omitted.
- Use `accessibility_label` as the card accessible name when present.
  Otherwise combine the supplied `label` and `display_value` only.
- Treat `id` as an opaque server identifier. Do not use it to select copy,
  position, calculations, or icons.

The initial cards currently cover new clients, appointments, and conversion,
but those labels, IDs, values, and supporting text are not frontend
guarantees.

### Period and conversion behavior

Use `period.label` for visible period copy. Treat `start_at` and `end_at` as
UTC instants; do not recreate boundaries in the device timezone.

The backend calculates conversion as selected-period referral appointments
divided by referral-link opens. A missing denominator is a valid `0%` display
with backend-provided supporting copy such as `No bookings yet`; it is not a
null/error state.

### Top referrer

`top_referrer` is either `null` or a complete display model. Render the
non-null display fields verbatim and do not reinterpret `result_text` as a
specific count type. It can accurately represent successful referrals or
pre-conversion engagement such as clicks.

When `client_id` is non-null, navigate to the existing authenticated client
detail route using that ID. When it is null, render it as informational only.
The backend has already verified non-null IDs belong to the authenticated
account.

## Icon contract

Map these keys through one centralized local-icon map:

| Key | Use |
| --- | --- |
| `referral_program` | Setup invitation |
| `referral_clients` | Client metric |
| `referral_appointments` | Appointment metric |
| `referral_conversion` | Conversion metric |
| `referral_top_referrer` | Top-referrer highlight |

For an unknown future key, omit the icon and report a presentation-contract
warning. Never guess an icon from a metric ID, label, or value.

## Explicitly removed fields

Do not consume these fields from `data.referrals`:

- `new_clients`
- `appointments_booked`
- `conversion_rate_percent`
- `links_sent`
- `links_clicked`
- `attributed_revenue`
- `booked_value`
- `historical_results`
- `top_referrer.display_name`
- `top_referrer.referral_count`

## Frontend acceptance checklist

- Referral Impact is absent when the plan entitlement is false.
- Setup-required renders backend `setup_state` content, not hardcoded copy.
- The active card renders exactly the three supplied metric cards in order.
- Historic results remain in the results state when the current period is all
  zeroes.
- Available zeroes render normally.
- Unavailable metrics render a retry/error state, never setup or fake zeroes.
- Unknown icon keys are safe.
- The top-referrer card navigates only when `client_id` is non-null.
