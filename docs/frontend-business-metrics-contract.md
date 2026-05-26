# Frontend Business Metrics Contract

This document defines the shared metric vocabulary used by Dashboard, Profile Overview, and Calendar responses.

## Status Semantics

| Metric term | Included appointment statuses | Excluded statuses |
|---|---|---|
| Booked revenue | `pending`, `scheduled`, `completed` | `cancelled`, `no_show` |
| Earned revenue / completed revenue | `completed` | `pending`, `scheduled`, `cancelled`, `no_show` |
| Upcoming revenue | future `pending`, future `scheduled` | `completed`, `cancelled`, `no_show`, past appointments |
| Booked minutes | `pending`, `scheduled`, `completed` | `cancelled`, `no_show` |
| Busy time | `pending`, `scheduled`, `completed` | `cancelled`, `no_show` |
| Booked average ticket | `booked revenue / booked appointment count` | `cancelled`, `no_show` |

All period boundaries are calculated in the stylist's business timezone.

## Endpoint Usage

### `GET /api/calendar?date=YYYY-MM-DD`

Calendar-day summary metrics use booked semantics:

- `summary.bookedRevenueCents`: value of `pending`, `scheduled`, and `completed` appointments on the selected business-local day.
- `summary.bookedMinutes`: minutes from `pending`, `scheduled`, and `completed` appointments.
- `summary.comparisonVsLastWeekPercent`: percent change in booked revenue versus the same business-local day in the previous week.

Calendar `availableSlots` are business open gaps. They are derived from saved availability, off days, and busy appointments.

### `GET /api/dashboard`

Dashboard monthly revenue uses earned/completed semantics:

- `monthly_revenue_summary.completed_revenue`: value of `completed` appointments from the current business-local month.

The name intentionally says `completed_revenue`; it is not the same as booked revenue.

### `GET /api/profile/overview`

Profile hero and forecast use upcoming semantics:

- `hero.title`: `Upcoming Revenue`
- `hero.value`: value of future `pending` and `scheduled` appointments in the next 30 days.
- `revenueForecast.nextWeek`: value of future `pending` and `scheduled` appointments in the next 7 days.
- `revenueForecast.nextMonth`: value of future `pending` and `scheduled` appointments in the next 30 days.

Profile performance metrics use booked semantics for the selected period:

- Metric `id: "revenue"` now has label `Booked Revenue`.
- Metric `id: "appointments"` counts booked appointments.
- Metric `id: "avg-ticket"` is booked average ticket.
- Metric `id: "rebooking-rate"` is based on clients with more than one booked appointment in the period.

## Frontend Notes

- Do not relabel `completed_revenue` as booked revenue.
- Do not relabel `Booked Revenue` as earned revenue.
- If a screen needs cash collected or settled revenue, use completed/earned semantics, not booked semantics.
- `no_show` appointments are visible appointment records, but they do not count toward booked revenue, earned revenue, upcoming revenue, booked minutes, or busy time metrics.

