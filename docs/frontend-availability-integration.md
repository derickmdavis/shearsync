# Frontend Availability Integration

This document describes the backend contract for the stylist-controlled "Availability" section.

## What Changed

The backend now supports authenticated read/write availability management.

- `GET /api/settings/availability`
- `PUT /api/settings/availability`

The dashboard/profile overview response also now includes `availabilitySettings` so the frontend can stop hard-coding the hours card.

## Source of Truth

Use the authenticated availability settings API as the editable source of truth.

- `GET /api/settings/availability` for the edit screen or modal
- `PUT /api/settings/availability` to save changes
- `GET /api/profile/overview` if the dashboard needs a read-only summary card and wants the normalized settings in the same payload

Public booking availability is derived from these saved hours. There is no separate public-hours table.

## Authentication

These endpoints require the normal authenticated bearer token used by the rest of the private API.

## Day Mapping

`dayOfWeek` uses JavaScript-style weekday indexes:

- `0` = Sunday
- `1` = Monday
- `2` = Tuesday
- `3` = Wednesday
- `4` = Thursday
- `5` = Friday
- `6` = Saturday

## GET /api/settings/availability

Returns a full 7-day weekly schedule in normalized order, even if the user has not configured every day.

### Response

```json
{
  "data": {
    "timezone": "America/Denver",
    "days": [
      { "dayOfWeek": 0, "isOpen": false, "windows": [] },
      {
        "dayOfWeek": 1,
        "isOpen": true,
        "windows": [
          { "startTime": "09:00", "endTime": "12:00" },
          { "startTime": "13:00", "endTime": "17:00" }
        ]
      },
      { "dayOfWeek": 2, "isOpen": true, "windows": [{ "startTime": "09:00", "endTime": "17:00" }] },
      { "dayOfWeek": 3, "isOpen": true, "windows": [{ "startTime": "09:00", "endTime": "17:00" }] },
      { "dayOfWeek": 4, "isOpen": true, "windows": [{ "startTime": "09:00", "endTime": "17:00" }] },
      { "dayOfWeek": 5, "isOpen": true, "windows": [{ "startTime": "09:00", "endTime": "17:00" }] },
      { "dayOfWeek": 6, "isOpen": false, "windows": [] }
    ]
  }
}
```

## PUT /api/settings/availability

Replaces the user's full weekly schedule. This is a full-replacement endpoint, not a partial patch.

Frontend rule: always send all 7 days.

### Request

```json
{
  "days": [
    { "dayOfWeek": 0, "isOpen": false, "windows": [] },
    {
      "dayOfWeek": 1,
      "isOpen": true,
      "windows": [
        { "startTime": "09:00", "endTime": "12:00" },
        { "startTime": "13:00", "endTime": "17:00" }
      ]
    },
    { "dayOfWeek": 2, "isOpen": true, "windows": [{ "startTime": "09:00", "endTime": "17:00" }] },
    { "dayOfWeek": 3, "isOpen": true, "windows": [{ "startTime": "09:00", "endTime": "17:00" }] },
    { "dayOfWeek": 4, "isOpen": true, "windows": [{ "startTime": "09:00", "endTime": "17:00" }] },
    { "dayOfWeek": 5, "isOpen": true, "windows": [{ "startTime": "09:00", "endTime": "17:00" }] },
    { "dayOfWeek": 6, "isOpen": false, "windows": [] }
  ]
}
```

### Success Response

The success response returns the same normalized structure as `GET /api/settings/availability`.

## Validation Rules

The backend enforces the following rules:

- The request must include exactly 7 day objects.
- Each `dayOfWeek` must appear exactly once.
- `startTime` and `endTime` must use 24-hour `HH:MM`.
- `isOpen: false` requires `windows: []`.
- `isOpen: true` requires at least one window.
- Each window must have `startTime < endTime`.
- Windows for the same day cannot overlap.
- Back-to-back windows are allowed.

### Example Invalid Payload

```json
{
  "days": [
    { "dayOfWeek": 0, "isOpen": false, "windows": [] },
    {
      "dayOfWeek": 1,
      "isOpen": true,
      "windows": [
        { "startTime": "09:00", "endTime": "12:00" },
        { "startTime": "11:30", "endTime": "14:00" }
      ]
    },
    { "dayOfWeek": 2, "isOpen": false, "windows": [] },
    { "dayOfWeek": 3, "isOpen": false, "windows": [] },
    { "dayOfWeek": 4, "isOpen": false, "windows": [] },
    { "dayOfWeek": 5, "isOpen": false, "windows": [] },
    { "dayOfWeek": 6, "isOpen": false, "windows": [] }
  ]
}
```

### Example Error Response

```json
{
  "error": {
    "message": "Availability windows cannot overlap for day 1"
  }
}
```

## Dashboard / Profile Overview

`GET /api/profile/overview` still returns the grouped read-only summary:

```json
{
  "data": {
    "availability": [
      { "day": "Mon - Fri", "hours": "9:00 AM - 5:00 PM" },
      { "day": "Sat", "hours": "10:00 AM - 3:00 PM" }
    ]
  }
}
```

It now also returns the normalized editable structure:

```json
{
  "data": {
    "availabilitySettings": {
      "timezone": "America/Denver",
      "days": [
        { "dayOfWeek": 0, "isOpen": false, "windows": [] },
        { "dayOfWeek": 1, "isOpen": true, "windows": [{ "startTime": "09:00", "endTime": "17:00" }] },
        { "dayOfWeek": 2, "isOpen": true, "windows": [{ "startTime": "09:00", "endTime": "17:00" }] },
        { "dayOfWeek": 3, "isOpen": true, "windows": [{ "startTime": "09:00", "endTime": "17:00" }] },
        { "dayOfWeek": 4, "isOpen": true, "windows": [{ "startTime": "09:00", "endTime": "17:00" }] },
        { "dayOfWeek": 5, "isOpen": true, "windows": [{ "startTime": "09:00", "endTime": "17:00" }] },
        { "dayOfWeek": 6, "isOpen": false, "windows": [] }
      ]
    }
  }
}
```

## Recommended Frontend Behavior

- Load `GET /api/profile/overview` for the dashboard card if that screen already uses it.
- Use `availabilitySettings` from that response to prefill the card if available.
- Open the edit modal/screen with data from `GET /api/settings/availability`, or reuse `availabilitySettings` if already fresh.
- On save, send the complete 7-day payload to `PUT /api/settings/availability`.
- After save, refresh `GET /api/settings/availability` or optimistically replace local state with the response body.
- Refresh `GET /api/profile/overview` if the dashboard summary card is visible and should update immediately.

## UI Data Model Suggestion

The frontend should store each day in this shape:

```ts
type AvailabilityDay = {
  dayOfWeek: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  isOpen: boolean;
  windows: Array<{
    startTime: string; // HH:MM
    endTime: string;   // HH:MM
  }>;
};
```

Good UI behavior:

- Toggle day open/closed with `isOpen`
- Allow multiple windows per day
- Sort windows before save
- Prevent overlaps client-side before submit
- Prevent empty open days client-side before submit
- Preserve `HH:MM` formatting exactly

## How This Affects Public Booking

These hours directly control bookable public slots, but the public booking page should not assume every saved availability window becomes a visible slot.

Slot generation also filters by:

- service duration
- existing appointments
- lead-time rules
- same-day cutoff rules
- maximum booking window rules
- new-client booking restrictions

That means:

- availability settings define the outer booking hours
- public slot endpoints define the actual bookable starts

## Integration Sequence

1. Load dashboard with `GET /api/profile/overview`
2. Render the Availability card from `data.availability` or `data.availabilitySettings`
3. When the user taps `Edit Hours`, load `GET /api/settings/availability` if needed
4. Let the user edit the full weekly schedule
5. Save with `PUT /api/settings/availability`
6. Replace local state with the response
7. Refresh overview if the current screen shows the grouped summary

## Files Touched In Backend

- `src/routes/settingsRoutes.ts`
- `src/controllers/settingsController.ts`
- `src/services/availabilityService.ts`
- `src/services/profileOverviewService.ts`
- `src/validators/settingsValidators.ts`
- `src/types/api.ts`

