# Insights API Contract

This document defines the versioned, authenticated read model for the mobile
Insights screen. It is intentionally a screen-composition endpoint: it does
not replace the existing Profile, Campaign, Referral, or Activity drill-down
endpoints.

## Implementation status

`GET /api/insights` is live with server-driven `business_snapshot`,
`campaigns`, `referrals`, and `appointment_changes` sections. Clients must not
treat an unavailable section as zero-valued data.

## Endpoint

```http
GET /api/insights?business_snapshot_period=week&referral_period=this_month
```

Authentication determines the account. The client must never send an account,
business, stylist, campaign, or client ID to select the owner of Insights data.

### Query parameters

| Parameter | Values | Default | Purpose |
| --- | --- | --- | --- |
| `business_snapshot_period` | `week`, `month` | `week` | Selects the business-local comparison window used by configured snapshot metrics. |
| `referral_period` | `this_month`, `all_time` | `this_month` | Selects the referral reporting period. |

The business snapshot's pages, metric IDs, labels, order, and page count are
server-controlled. These parameters select a reporting window; they do not
allow the client to select metrics.

## Transport and versioning

The HTTP response uses the existing authenticated API data envelope.

```json
{ "data": { "contract_version": "2026-07-21" } }
```

`contract_version` is a date-versioned, additive contract marker. A new
version is required for a breaking shape or semantic change. Adding an optional
field or a new server-defined metric is non-breaking.

The runtime source of truth is
[`src/validators/insightsValidators.ts`](../src/validators/insightsValidators.ts).
The representative mobile fixture is
[`src/__tests__/fixtures/insights-response.json`](../src/__tests__/fixtures/insights-response.json).

## Response envelope

```ts
type InsightsResponse = {
  contract_version: "2026-07-21";
  generated_at: string; // UTC ISO-8601 instant
  account_timezone: string; // IANA, e.g. America/Denver
  business_snapshot: BusinessSnapshotSection;
  campaigns: CampaignsSection;
  referrals: ReferralsSection;
  appointment_changes: AppointmentChangesSection;
};
```

`generated_at` is the instant at which the screen model was assembled.
`calculated_at`, when included on a section, is the instant that specific
section was calculated. All timestamps are UTC instants with an offset. The
`account_timezone` is the sole timezone used to choose business-day and
calendar-period boundaries.

Every period/window in a successful section includes explicit UTC start and
end instants. The client must use returned labels and must not recreate date
boundaries using its device timezone.

## Section availability and partial failures

Every screen section is independently available or unavailable:

```ts
type AvailableSection = {
  available: true;
  calculated_at?: string;
  // section data fields
};

type UnavailableSection = {
  available: false;
  reason:
    | "insufficient_history"
    | "feature_unavailable"
    | "processing"
    | "temporarily_unavailable";
  message?: string; // user-safe, ready for direct display
  retry_after_seconds?: number;
  calculated_at?: string;
};
```

An unavailable Campaigns section must not prevent a successful Business
Snapshot, Referrals, or Appointment Changes section from rendering. The
endpoint implementation should calculate sections in isolation and return an
unavailable section for recoverable per-section failures. Authentication,
request validation, and systemic API failures remain normal HTTP errors.

`available: true` with zero counts or zero money means the data was calculated
and is genuinely empty. It is different from `available: false`.

## Business Snapshot: server-driven renderer contract

```ts
type BusinessSnapshotSection =
  | {
      available: true;
      calculated_at?: string;
      pages: SnapshotPage[];
    }
  | UnavailableSection;

type SnapshotPage = {
  id: string;
  title: string;
  period_label: string;
  layout: "grid_2x2" | "list";
  window: { start_at: string; end_at: string };
  metrics: SnapshotMetric[];
};

type SnapshotMetric = {
  id: string;
  label: string;
  value: MoneyValue | CountValue | PercentValue | DurationValue | TextValue;
  detail?: string;
  comparison?: {
    label: string;
    percent_change: number | null;
    trend?: "up" | "down" | "neutral";
  };
};
```

Metric `id` is an opaque, stable server identifier. The client must not use it
to select labels, formatting, order, or calculation behavior.

### Supported generic values

| `value.kind` | Shape | Client rendering responsibility |
| --- | --- | --- |
| `money` | `{ amount_minor: integer, currency: "USD" }` | Format using the supplied ISO 4217 currency. |
| `count` | `{ count: integer >= 0 }` | Render as an integer. |
| `percent` | `{ percent: number from 0 to 100 }` | Render as a percentage. |
| `duration` | `{ minutes: integer >= 0 }` | Render as a duration. |
| `text` | `{ text: string }` | Render as provided. |

Money is always integer minor units; the API never sends formatted currency as
the source of truth. `amount_minor` may be negative where a metric's documented
semantics permit it, such as a net-refund metric.

For an unavailable prior-period denominator, return
`comparison.percent_change: null` and omit `comparison.trend`. The client must
hide comparison treatment rather than convert it to a fictional `0%`, `100%`,
or arrow.

Pages are an ordered array with no fixed length. A server configuration can add,
remove, reorder, or relabel pages and metrics without a mobile release, as long
as it uses one of the supported layouts and value kinds.

The initial configuration and metric catalog are version-controlled in
[`src/services/insightsSnapshotService.ts`](../src/services/insightsSnapshotService.ts).
Each configuration page can also declare a server-evaluated feature gate; the
client never decides whether a metric or page is entitled. Runtime database
configuration is intentionally deferred to the next configuration-management
chunk.

## Other screen sections

The initial contract also reserves these independently available sections:

- `campaigns`: a complete server-driven Campaign Insights model, including its
  reporting period, lifetime history state, metric cards, optional top campaign,
  and empty-state copy.
- `referrals`: requested-period client/appointment/link counts, money values,
  nullable conversion rate, an optional account-owned top-referrer ID, and
  lifetime successful-conversion results.
- `appointment_changes`: server-selected contiguous current and preceding
  24-hour UTC windows with new-appointment and cancellation counts and nullable
  comparisons.

Their exact schemas are validated alongside the Snapshot schema in
`insightsValidators.ts`.

### Campaign definitions

Campaign reporting is business-local calendar month-to-date. `emails_sent`
counts campaign-recipient rows with `sent_at` in the period. Attributed bookings
and revenue count non-cancelled appointments with `campaign_attributed_at` in
the period; revenue is USD. `top_campaign` is the highest attributed-revenue
campaign in the period, with bookings, sent email count, then ID as deterministic
tie-breakers. Its ID is the existing authenticated campaign-detail ID.

### Campaign renderer contract

Every available `campaigns` section is a complete server-driven model for the
Campaign Insights module. There is no parallel legacy aggregate shape.

```ts
type CampaignPresentation = {
  has_campaign_history: boolean;
  metrics: [
    CampaignMetric<"emails_sent", "campaign_email">,
    CampaignMetric<"appointments_booked", "campaign_appointment">,
    CampaignMetric<"attributed_revenue", "campaign_revenue">
  ];
  top_campaign: {
    campaign_id: string;
    icon_key?: "campaign" | null;
    eyebrow?: string | null;
    title: string;
    result_text?: string | null;
    accessibility_label?: string | null;
  } | null;
  empty_state: {
    icon_key: "campaign";
    title: string;
    body: string;
    cta_label: string;
  };
};
```

The metric tuple is exactly three items and is already in display order. Its
closed icon-key catalog is `campaign`, `campaign_email`,
`campaign_appointment`, and `campaign_revenue`; clients must not infer icons,
labels, order, copy, or formatting from metric IDs. Campaign money display is
always USD.

#### Campaign state matrix

| Account/UI state | Campaigns section | `has_campaign_history` | Metrics / top campaign | Empty state |
| --- | --- | --- | --- | --- |
| Not entitled or cancelled | `available: false`, `feature_unavailable` | omitted | omitted | omitted; UI hides module |
| Section disabled or calculation failure | `available: false` with the relevant reason | omitted | omitted | omitted; UI renders safe message/retry state |
| No account-owned campaign, including no draft | `available: true` | `false` | three calculated zero metrics; `top_campaign: null` | Render returned state |
| Existing campaign but no current-month activity | `available: true` | `true` | three calculated zero metrics; `top_campaign: null` | Do not render |
| Current-month campaign activity | `available: true` | `true` | three calculated metrics; ranked `top_campaign` when one qualifies | Do not render |

`has_campaign_history` is a lifetime account-owned-campaign `EXISTS` check;
draft, scheduled, completed, failed, and cancelled campaigns all count. It is
independent of the reporting period.

### Referral definitions

`this_month` is the business-local calendar month-to-date: its start is local
midnight on the first day of the current month and its end is the response
generation instant. `all_time` uses the explicit UTC interval from
`1970-01-01T00:00:00.000Z` to the generation instant. It is not a relabeled
month response.

`appointments_booked` includes non-cancelled referral-attributed appointments;
`attributed_revenue` includes completed ones only. Both money values are
integer minor units. `conversion_rate_percent` is referral-attributed booked
appointments divided by referral-link opens, multiplied by 100; it is `null`
when there were no opens. The top-referrer client ID is returned only after a
same-account ownership lookup succeeds.

Every available referral section also returns:

```ts
historical_results: {
  new_clients: number;
  appointments_booked: number;
  has_successful_conversions: boolean;
}
```

These are lifetime aggregates independent of `referral_period`. `new_clients`
counts clients with `original_referral_attributed_at`; `appointments_booked`
counts non-cancelled appointments with `referral_attributed_at`.
`has_successful_conversions` is true when either lifetime count is non-zero.
Referral link creation, shares, and opens never make this flag true.

### Appointment-change definitions

The endpoint chooses two contiguous UTC windows ending at `generated_at`:
`[generated_at - 24h, generated_at)` and the immediately preceding 24 hours.
New appointments and cancellations are exact counts of canonical
`activity_events` (`booking_created` and `appointment_cancelled`). The database
enforces unique `(user_id, dedupe_key)` values for those events, so retries do
not inflate counts and no activity-feed page limit is involved.

## Mobile rendering checklist

- Render only the pages and metrics returned by `business_snapshot.pages`.
- Do not hardcode metric IDs, labels, order, page count, selector logic, or
  comparison logic.
- Support both `grid_2x2` and `list`; treat an unsupported future layout as a
  section-level presentation error and report it rather than guessing.
- Format structured values from `value.kind`; do not parse display strings.
- Use `period_label`, `detail`, comparison labels, UTC windows, and
  `account_timezone` from the response.
- When `percent_change` is `null`, omit the trend/comparison display.
- Render zero values as valid data when `available` is `true`.
- Render `reason`, user-safe `message`, and retry behavior per unavailable
  section without hiding successful sibling sections.
- Use only server-provided IDs for Campaign and Referrer navigation.

## Operational behavior and rollout

The endpoint sends `Cache-Control: private, max-age=30,
stale-while-revalidate=60`. Responses are account-specific and must never be
stored in a shared cache.

Each section is calculated independently and concurrently. A section failure
returns that section's user-safe unavailable state; successful sibling sections
remain available. The API emits `insights_section_calculated` or
`insights_section_unavailable` with the section name, latency in milliseconds,
and a failure reason when applicable.

The optional `INSIGHTS_ENABLED_SECTIONS` environment variable is a
comma-separated allow-list of `business_snapshot`, `appointment_changes`,
`referrals`, and `campaigns`. When unset, all sections are enabled. Set it to
`business_snapshot` for the initial rollout, then add the remaining sections
as they are approved. Disabled sections return `feature_unavailable` rather
than failing the endpoint.

The query implementations are account-scoped and time-windowed; supporting
indexes are installed by `202607200003_insights_aggregate_indexes.sql`. Metric
formulas remain code-owned and tested. Runtime configuration can select, order,
and lay out only registered metrics, never arbitrary database expressions.
