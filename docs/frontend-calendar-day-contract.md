# Frontend Calendar Day Contract

This document is the frontend integration contract for the authenticated calendar day view.

## Endpoint

```http
GET /api/calendar?date=YYYY-MM-DD
```

Auth is required. The response is not wrapped in `{ data }`.

## Response Shape

```ts
type CalendarDayResponse = {
  date: string;
  summary: {
    selectedDateLabel: string;
    totalAppointments: number;
    bookedRevenueCents: number;
    bookedMinutes: number;
    comparisonVsLastWeekPercent: number | null;
    freeMinutesRemaining: number | null;
    openGapCount: number;
  };
  appointments: ApiAppointmentRecord[];
  availableSlots: {
    id: string;
    startTime: string;
    endTime: string;
    durationMinutes: number;
    canBook: boolean;
  }[];
};
```

## Example

```json
{
  "date": "2026-07-06",
  "summary": {
    "selectedDateLabel": "Monday, July 6",
    "totalAppointments": 3,
    "bookedRevenueCents": 24500,
    "bookedMinutes": 150,
    "comparisonVsLastWeekPercent": 18,
    "freeMinutesRemaining": 210,
    "openGapCount": 2
  },
  "appointments": [],
  "availableSlots": [
    {
      "id": "slot-2026-07-06-0830",
      "startTime": "2026-07-06T08:30:00-06:00",
      "endTime": "2026-07-06T10:00:00-06:00",
      "durationMinutes": 90,
      "canBook": true
    }
  ]
}
```

## Backend-Owned Rules

The frontend should not recompute these values:

- `comparisonVsLastWeekPercent`
- `freeMinutesRemaining`
- `openGapCount`
- `availableSlots`

The backend owns business timezone handling, off days, same-day cutoff, past date exclusion, status rules, slot granularity, and minimum bookable gap duration.

Current slot policy:

- Business timezone comes from the authenticated stylist profile.
- Slot granularity is 15 minutes.
- Minimum bookable gap is 30 minutes.
- Past dates return no available slots.
- Same-day slots start at the next 15-minute boundary.
- Off days return no available slots.
- Available slots are returned as open gaps, not service-duration-specific appointment starts.

## Status Rules

Appointments returned in `appointments` exclude `cancelled`.

Availability blockers:

- `scheduled`
- `pending`
- `completed`

Revenue and booked-time statuses:

- `scheduled`
- `pending`
- `completed`

Excluded from availability, revenue, and booked time:

- `cancelled`
- `no_show`

`no_show` appointments may still appear in `appointments`, but they do not block open-slot gaps or count toward booked revenue/time.

## Frontend Mapping

Use the backend fields directly:

- `summary.comparisonVsLastWeekPercent`: format as percent text, e.g. `+18%`; render a neutral/empty state when `null`.
- `summary.freeMinutesRemaining`: format as duration text, e.g. `2h 30m`.
- `summary.openGapCount`: format as count text, e.g. `3 gaps`.
- `availableSlots`: render as green open-slot timeline rows.

Do not use mock open slots, local gap calculation, or fixed-count fallbacks like `6 - appointments.length`.

## Book Now Handoff

`availableSlots` are prefill intent for the appointment creation flow. They are not final appointments until the user chooses the required appointment details.

When the user clicks Book now on an open slot, preserve these values in frontend route state or query params:

```json
{
  "initialDate": "2026-07-06",
  "initialStartTime": "2026-07-06T08:30:00-06:00",
  "initialEndTime": "2026-07-06T10:00:00-06:00",
  "launchSource": "calendar-open-slot"
}
```

Once the user chooses a client/service and the intended slot is valid for that service duration, submit the existing appointment creation request:

```http
POST /api/appointments
```

```json
{
  "client_id": "client-uuid",
  "appointment_date": "2026-07-06T08:30:00-06:00",
  "service_name": "Haircut",
  "duration_minutes": 60,
  "price": 95,
  "status": "scheduled",
  "booking_source": "internal"
}
```

The backend validates final overlap at creation time. If the slot has been taken, the API returns `409`.
