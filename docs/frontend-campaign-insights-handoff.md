# Campaign Insights Frontend Handoff

This document is the frontend contract for the Campaigns section on the
Insights screen. It reflects the final backend shape: Campaign UI data is
returned directly in `data.campaigns`; there is no `presentation` wrapper and
no legacy campaign aggregate payload to combine with it.

## Endpoints

```http
GET /api/account/plan
GET /api/insights
```

Both endpoints are authenticated. The authenticated account selects all data;
do not send an account, stylist, campaign, or client ID to Insights.

Fetch the account plan once after authentication and cache it in the app's
authenticated-session state. Fetch Insights once for the screen; do not make
separate Campaign, Campaign-detail, recipient, or reporting calls to construct
this module.

Insights responses are account-private and use:

```http
Cache-Control: private, max-age=30, stale-while-revalidate=60
```

## Entitlement gate

Campaign Insights is controlled by the dedicated plan entitlement:

```ts
plan.features.emailCampaigns: boolean;
```

It is `false` for Basic and `true` for Pro and Premium. It is distinct from
`emailReminders`; never use email-reminder access as a proxy.

Frontend behavior:

1. When `emailCampaigns === false`, hide the entire Campaign Insights module.
2. When `emailCampaigns === true`, render from `data.campaigns`.
3. A cancelled account can return `campaigns.available === false` with
   `reason: "feature_unavailable"`; keep the module hidden.

The backend independently enforces the entitlement for campaign creation,
editing, preview, validation, audience estimates, scheduling, and sending.

## Contract version

The current Insights contract version is `2026-07-21`.

```ts
type CampaignsSection =
  | CampaignsAvailable
  | CampaignsUnavailable;

type CampaignsAvailable = {
  available: true;
  calculated_at?: string;
  period: {
    label: string;
    start_at: string; // UTC ISO-8601 instant
    end_at: string; // UTC ISO-8601 instant
  };
  has_campaign_history: boolean;
  metrics: [
    CampaignMetric<"emails_sent", "campaign_email">,
    CampaignMetric<"appointments_booked", "campaign_appointment">,
    CampaignMetric<"attributed_revenue", "campaign_revenue">
  ];
  top_campaign: TopCampaign | null;
  empty_state: CampaignEmptyState;
};

type CampaignMetric<Id extends string, IconKey extends string> = {
  id: Id;
  icon_key: IconKey;
  display_value: string;
  label: string;
  supporting_text?: string | null;
  semantic_tone?: "default" | "positive" | "neutral" | "warning";
  accessibility_label?: string | null;
};

type TopCampaign = {
  campaign_id: string;
  icon_key?: "campaign" | null;
  eyebrow?: string | null;
  title: string;
  result_text?: string | null;
  accessibility_label?: string | null;
};

type CampaignEmptyState = {
  icon_key: "campaign";
  title: string;
  body: string;
  cta_label: string;
};

type CampaignsUnavailable = {
  available: false;
  reason:
    | "insufficient_history"
    | "feature_unavailable"
    | "processing"
    | "temporarily_unavailable";
  message?: string;
  retry_after_seconds?: number;
  calculated_at?: string;
};
```

The API validates exactly three metrics in the listed order. Render the array
as supplied; do not sort it, branch on its IDs to choose copy, or append a
fourth client-created card.

## Icon contract

Only these Campaign Insights icon keys are currently emitted:

| Key | Intended use |
| --- | --- |
| `campaign` | Top-campaign and empty-state visual |
| `campaign_email` | Emails sent metric |
| `campaign_appointment` | Appointments booked metric |
| `campaign_revenue` | Attributed revenue metric |

Map keys to local assets in one centralized icon map. If an unknown future key
arrives, omit the icon and report the presentation error; do not guess an icon
from `id`, label, or value.

## Render states

| Condition | Render behavior |
| --- | --- |
| `emailCampaigns === false` | Hide Campaign Insights. |
| `available === false`, `reason === "feature_unavailable"` | Hide Campaign Insights. |
| `available === false` for another reason | Show the returned `message` when present. If `retry_after_seconds` is supplied, defer an automatic retry by at least that duration; do not render zero-valued metrics. |
| `available === true`, `has_campaign_history === false` | Render the backend-provided empty state. Do not render the metric grid or top Campaign card. |
| `available === true`, `has_campaign_history === true`, all metric values zero | Render the three returned zero-value metric cards. Do not show the empty state. `top_campaign` is normally `null`. |
| `available === true`, activity exists | Render the three cards and render `top_campaign` only when non-null. |

`available: true` always means calculated data. A zero is valid data—not a
loading, error, or unavailable state.

## Metric behavior

All visible metric content is server-owned:

- Render `label`, `display_value`, and non-null `supporting_text` verbatim.
- Apply visual color/treatment from `semantic_tone` when present; use the
  screen's neutral/default treatment when omitted.
- Use `accessibility_label` for the card's accessible name when present;
  otherwise compose an accessible name from the supplied label and display
  value only.
- `display_value` is already formatted. Do not parse it to calculate, relabel,
  localize, or reformat values.

Campaign revenue is always USD and is already formatted by the backend (for
example, `$1,250.00`).

## Top Campaign card

`top_campaign` is either `null` or the complete display model. The backend
ranks it by attributed revenue, then appointments booked, then emails sent,
then campaign ID. The frontend must not rerank Campaigns or fabricate a result
line.

- Render `eyebrow`, `title`, and `result_text` only when non-null.
- Use `accessibility_label` when supplied.
- Use only `campaign_id` for the existing authenticated Campaign-detail
  navigation target.

## Empty state and CTA

The empty-state text and CTA label are backend-provided. Render all four fields
as supplied when `has_campaign_history === false`.

The API supplies a CTA label, not a navigation URL. Wire the CTA to the
frontend's existing create-Campaign destination. Do not replace the label with
hardcoded copy.

## Period and timezone

Campaign reporting is business-local calendar month-to-date. Use
`campaigns.period.label` for visible period copy. Treat `start_at` and `end_at`
as UTC instants and do not recreate boundaries in device timezone.

## Example: active Campaign Insights

```json
{
  "available": true,
  "period": {
    "label": "This Month",
    "start_at": "2026-07-01T06:00:00.000Z",
    "end_at": "2026-07-20T18:42:00.000Z"
  },
  "has_campaign_history": true,
  "metrics": [
    {
      "id": "emails_sent",
      "icon_key": "campaign_email",
      "display_value": "1,240",
      "label": "Emails sent",
      "supporting_text": null,
      "semantic_tone": "default",
      "accessibility_label": "1,240 emails sent"
    },
    {
      "id": "appointments_booked",
      "icon_key": "campaign_appointment",
      "display_value": "36",
      "label": "Appointments booked",
      "supporting_text": null,
      "semantic_tone": "default",
      "accessibility_label": "36 appointments booked"
    },
    {
      "id": "attributed_revenue",
      "icon_key": "campaign_revenue",
      "display_value": "$1,250.00",
      "label": "Attributed revenue",
      "supporting_text": null,
      "semantic_tone": "positive",
      "accessibility_label": "$1,250.00 attributed revenue"
    }
  ],
  "top_campaign": {
    "campaign_id": "60000000-0000-4000-8000-000000000001",
    "icon_key": "campaign",
    "eyebrow": "Top campaign",
    "title": "Summer Refresh",
    "result_text": "$1,250.00 attributed revenue",
    "accessibility_label": "Top campaign: Summer Refresh. $1,250.00 attributed revenue."
  },
  "empty_state": {
    "icon_key": "campaign",
    "title": "Send your first campaign",
    "body": "Reach more clients with a targeted email campaign.",
    "cta_label": "Create campaign"
  }
}
```

## Explicitly removed fields

Do not consume these former Campaign Insights fields; they are no longer part
of the API:

- `campaigns.presentation`
- `campaign_count`
- `active_campaign_count`
- `active_statuses`
- `totals`
- the former aggregate-shaped `top_campaign`
- `unavailable_metrics.clients_returned`

