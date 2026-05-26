# Frontend Internal Appointment Context Contract

This document describes the authenticated backend contract for:

- `GET /api/appointments/internal-context?date=YYYY-MM-DD&durationMinutes=90`

## Purpose

This endpoint is only for internal stylist appointment creation. It returns conflict-free slot suggestions across the full local day.

It does not represent public booking availability or scheduled business-hour gaps.

## Important Behavior

- Reads existing non-cancelled appointments for the authenticated stylist.
- Generates 15-minute start-time suggestions across the entire local day.
- Filters out suggestions that overlap existing appointments.
- Does not read saved availability windows.
- Does not apply public booking rules.
- Does not apply off-day checks.

## Response Shape

```ts
type InternalAppointmentContextResponse = {
  data: {
    date: string;
    mode: "conflict_free";
    respectsAvailability: false;
    respectsBookingRules: false;
    respectsOffDays: false;
    conflictFreeSlots: Array<{
      start: string;
      end: string;
      label: string;
    }>;
    existingAppointments: Array<{
      start: string;
      end: string;
    }>;
    blockedTimes: [];
  };
};
```

## Frontend Migration

The old field:

```ts
data.availableSlots
```

has been renamed to:

```ts
data.conflictFreeSlots
```

This is a breaking change. Do not display these slots as normal availability. They are only safe to show in a manual appointment creation flow where the stylist understands they may be outside published hours or off days.

## Related Endpoints

- `GET /api/calendar?date=YYYY-MM-DD`
  - Returns calendar-day open gaps in `availableSlots`.
  - These are derived from saved availability, off days, and appointments.

- Public booking availability endpoints
  - Return client-bookable public slots.
  - These apply availability, rules, off days, conflicts, and client restrictions.

