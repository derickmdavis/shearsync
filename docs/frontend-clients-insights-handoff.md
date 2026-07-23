# Clients Screen: Insights Integration Handoff

## Status and prerequisite

The Clients API now supports the insight filters, page-row summaries, and tile metrics required by the updated Clients screen.

Before using this contract in a deployed environment, apply:

`supabase/migrations/202607220005_clients_list_summaries_and_insight_filters.sql`

No new endpoint is required. Continue using `GET /api/clients`.

## Request contract

```http
GET /api/clients?search=quinn&page=1&pageSize=25&sort=name&direction=asc&filter=top_spenders
```

| Parameter | Values | Notes |
| --- | --- | --- |
| `search` | string, optional | Searches the same client fields as before: name, preferred name, email, phone, normalized phone, Instagram, notes, and exact tags. |
| `page` | positive integer | One-based. Reset to `1` whenever search, filter, sort, or direction changes. |
| `pageSize` | `1`–`100` | Use `25` for the normal Clients screen. |
| `sort` | `updated_at`, `updated`, `name`, `total_spend`, `spend`, `last_visit_at`, `last_visit` | `last_visit*` now sorts by the latest completed visit. |
| `direction` | `asc` or `desc` | Defaults to `desc`. |
| `filter` | `all`, `active`, `vip`, `overdue`, `first_time`, `top_spenders` | Apply one selected tile filter at a time. `active` remains an alias for all non-deleted clients. |

Do not fetch all clients or appointment history to calculate screen data locally.

## Response contract

```ts
type ClientsListResponse = {
  data: ClientListRow[];
  page: number;
  pageSize: number;
  totalCount: number;
  nextCursor: string | null;
  insights: {
    overdue: {
      count: number;
      supportingText: string; // "Rebooking due"
    };
    firstTime: {
      count: number;
      supportingText: "This year";
    };
    topSpenders: {
      count: number;
      supportingText: string; // e.g. "$600.00+ lifetime"
      thresholdAmount: number;
      period: "lifetime";
      percentile: 10;
    };
  };
};

type ClientListRow = {
  id: string;
  first_name: string;
  last_name: string | null;
  preferred_name: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
  is_vip: boolean;
  avatar_image_id: string | null;
  created_at: string;
  updated_at: string;

  total_spend: number | string;
  completed_visit_count: number;
  first_completed_visit_at: string | null;
  last_completed_visit_at: string | null;

  needs_rebook: boolean;
  has_future_appointment: boolean;
  next_appointment_at: string | null;
  last_service: string | null;

  // Retained for compatibility only. Prefer last_completed_visit_at for new UI.
  last_visit_at: string | null;
};
```

`total_spend` can be serialized as a string by Postgres/Supabase. Normalize it before formatting:

```ts
const totalSpend = Number(row.total_spend ?? 0);
```

## Tile behavior

Render the three tiles from `response.insights`, never from `data` or `totalCount`.

The tile metrics respect `search`, but deliberately ignore the active insight filter. For example, after selecting Overdue, the list and `totalCount` contain only overdue clients, while First-Time and Top Spenders continue to show their counts within the current search results.

| Tile | Set `filter` to | Count source | Supporting text |
| --- | --- | --- | --- |
| Overdue | `overdue` | `insights.overdue.count` | `insights.overdue.supportingText` |
| First-Time | `first_time` | `insights.firstTime.count` | `This year` |
| Top Spenders | `top_spenders` | `insights.topSpenders.count` | `insights.topSpenders.supportingText` |

Use the API-provided top-spender label or derive an equivalent label from `thresholdAmount`; do not retain a fixed `$500`/`$600` frontend threshold.

## Backend-owned definitions

- **Completed visit:** an appointment with `status = "completed"` and an appointment time at or before the request time. Scheduled, pending, cancelled, no-show, and future appointments do not count.
- **Lifetime spend:** sum of completed appointment prices. For a client with no completed appointments, the stored legacy `clients.total_spend` value is used as a compatibility fallback.
- **Last seen:** use `last_completed_visit_at` for new display logic. It is the latest completed appointment, not the latest scheduled or pending record.
- **Overdue:** a client with a completed visit, no future non-cancelled appointment, and a completed visit older than their configured rebooking interval. A client-specific manual interval takes precedence; otherwise the backend uses completed-history spacing when available, then the account default.
- **First-Time:** the client’s first completed visit is in the current calendar year in the business timezone.
- **Top Spenders:** the top `ceil(10%)` of non-deleted clients matching the current search, ranked by lifetime spend descending and client ID ascending to make ties deterministic. `thresholdAmount` is the spend of the final included client.

## Row rendering guidance

- Show visit count from `completed_visit_count`; do not derive it from appointment history or client creation date.
- Format last-seen text from `last_completed_visit_at`. For `null`, show the product’s empty-state copy such as `Not yet seen`.
- Show an upcoming appointment pill only when `has_future_appointment` is true. Format `next_appointment_at` in the client’s business timezone.
- Format `total_spend` as currency and label it as lifetime spend if the screen needs explanatory copy.
- Keep initials/avatar presentation entirely frontend-owned. `avatar_image_id` is an identifier, not a signed image URL; no backend image-contract change accompanies this work.

## State and pagination flow

Keep these values in component state or the URL:

```ts
type ClientsListState = {
  search: string;
  page: number;
  pageSize: number;
  sort: "updated_at" | "name" | "total_spend" | "last_visit_at";
  direction: "asc" | "desc";
  filter: "all" | "active" | "vip" | "overdue" | "first_time" | "top_spenders";
};
```

Recommended behavior:

1. Debounce search by roughly 250–400 ms.
2. Reset `page` to `1` when search, filter, sort, or direction changes.
3. Keep the previous page visible during a replacement request if the data library supports it.
4. Use `totalCount` for the result count and page controls.
5. Treat `nextCursor` as opaque; `null` means there is no following page.
6. Preserve the selected tile/filter while searching. The tiles will recalculate for the narrowed search universe.

## Non-goals

This backend work does not affect Clients-screen colors, spacing, typography, avatar medallions, icons, the add-client button shape, or tile layout. Those remain frontend-only refinements.

For the full base list contract, see [frontend-clients-list-contract.md](./frontend-clients-list-contract.md).
