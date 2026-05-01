# Frontend Profile Performance Toggle

This document describes the backend contract for switching the profile screen's "Business Performance" section between `This Week` and `This Month`.

## What Changed

`GET /api/profile/overview` now accepts an optional query parameter:

- `performancePeriod=week`
- `performancePeriod=month`

If the query param is omitted, the backend defaults to `week` for backward compatibility.

## Request

### Default Weekly Request

```http
GET /api/profile/overview
```

This behaves the same as:

```http
GET /api/profile/overview?performancePeriod=week
```

### Monthly Request

```http
GET /api/profile/overview?performancePeriod=month
```

## Query Param Rules

- Only `week` and `month` are supported.
- Any other value returns a `400` validation error.

### Example Invalid Request

```http
GET /api/profile/overview?performancePeriod=year
```

### Example Error Response

```json
{
  "error": {
    "message": "Validation failed"
  }
}
```

## Response Changes

The response now includes `data.performance.period` so the frontend can confirm which mode was returned.

```json
{
  "data": {
    "performance": {
      "period": "week",
      "periodLabel": "This Week",
      "metrics": [
        {
          "id": "revenue",
          "label": "Revenue",
          "value": "$285",
          "change": "↑ 17%",
          "detail": "vs last week"
        }
      ]
    }
  }
}
```

Monthly mode returns the same shape, but with:

- `period: "month"`
- `periodLabel: "This Month"`
- metric `detail: "vs last month"`

## Metric Logic

The toggle changes only the Business Performance metric window.

It does not change:

- hero upcoming revenue card
- revenue forecast values
- availability card
- services/settings summary sections

### `performancePeriod=week`

Uses the current local calendar week in the business timezone:

- current period: Monday through Sunday of the current week
- comparison period: previous Monday through Sunday

### `performancePeriod=month`

Uses the current local calendar month in the business timezone:

- current period: first day of the current month through the first day of the next month
- comparison period: previous calendar month

## Metrics Affected

These four performance cards switch together:

- `Revenue`
- `Appointments`
- `Rebooking Rate`
- `Avg. Ticket`

Each metric uses the selected period and updates its comparison text accordingly.

## Recommended Frontend Behavior

- Keep the current default UI state as `This Week`.
- When the user selects `This Month`, refetch `GET /api/profile/overview?performancePeriod=month`.
- When the user switches back, refetch `GET /api/profile/overview?performancePeriod=week`.
- Render the selected state from `data.performance.period` when the response returns.
- Use `data.performance.periodLabel` and each metric's `detail` text directly from the API instead of hard-coding `This Week` or `vs last week`.

## Suggested Frontend State

```ts
type PerformancePeriod = "week" | "month";
```

Example flow:

1. Initial load calls `GET /api/profile/overview`
2. Store the selected period as `"week"`
3. User changes the filter to `"month"`
4. Call `GET /api/profile/overview?performancePeriod=month`
5. Replace the Business Performance section with the response data
6. Keep the rest of the profile screen behavior unchanged

## UI Update Checklist

- Replace any hard-coded `This Week` filter label with local UI state.
- Send `performancePeriod` in the overview request when the user changes the toggle.
- Read `data.performance.period` from the response to guard against stale responses.
- Read `data.performance.periodLabel` for the section label.
- Read each metric's `detail` for `vs last week` / `vs last month`.
- Keep all other profile overview sections wired exactly as they are today.
