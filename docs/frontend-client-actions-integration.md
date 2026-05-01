# Frontend Client Actions Integration

This document describes the authenticated backend contract for `GET /api/client-actions`.

## Purpose

Use this endpoint to populate an action center, dashboard task list, or inbox-style surface for the stylist.

The response is intentionally item-based so the frontend can render different cards from one endpoint without relying on fixed array positions.

## Authentication

This endpoint requires the normal authenticated bearer token used by the rest of the private API.

## Endpoint

- `GET /api/client-actions`

## Response Shape

```json
{
  "data": {
    "items": [
      {
        "id": "pending-appointment-approvals",
        "type": "pending_appointment_approvals",
        "label": "Appointments requiring approval",
        "priority": "high",
        "count": 2,
        "preview": [
          {
            "appointment_id": "appt-2",
            "client_id": "client-1",
            "client_name": "Jane Doe",
            "appointment_date": "2026-05-08T09:00:00.000Z",
            "service_name": "Consultation",
            "status": "pending"
          }
        ]
      },
      {
        "id": "clients-requiring-rebook",
        "type": "clients_requiring_rebook",
        "label": "Clients requiring rebook",
        "priority": "medium",
        "count": 2,
        "preview": [
          {
            "client_id": "client-3",
            "client_name": "Morgan Reed",
            "last_appointment_date": "2025-11-20T09:00:00.000Z",
            "last_service_name": "Color Refresh"
          }
        ]
      }
    ]
  }
}
```

## Item Types

The frontend should branch on `type`, not on array order.

### `pending_appointment_approvals`

Use this item when the stylist needs to approve public booking requests.

Fields:

- `count`: total pending appointments
- `preview`: up to 5 earliest pending appointments
- `preview[].appointment_date`: ISO timestamp for the requested appointment start

### `clients_requiring_rebook`

Use this item to prompt follow-up with returning clients who are due to book again.

Fields:

- `count`: total clients currently matching the rebook rule
- `preview`: up to 5 clients, ordered by oldest qualifying appointment first
- `preview[].last_appointment_date`: ISO timestamp of the client's most recent past qualifying appointment
- `preview[].last_service_name`: service name from that appointment when available

## Rebook Rule

`clients_requiring_rebook` includes a client only when both conditions are true:

1. The client's most recent non-cancelled appointment falls between 3 months ago and 6 months ago, inclusive, using the business timezone's calendar date.
2. The client has no non-cancelled future appointment scheduled.

Important frontend note:

- This rule is already computed by the backend. The client app should render what it receives and should not try to recompute the window locally.

## Empty State

If there are no active client actions, the endpoint returns:

```json
{
  "data": {
    "items": []
  }
}
```

## Recommended Frontend Behavior

- Render each item by `type` with a dedicated card/component.
- Show `count` as the main badge or summary number.
- Use `preview` for the first few rows in the card.
- Treat `preview` as a sample, not the full dataset.
- Expect more item types to be added later.
- Fall back gracefully if the API returns an unknown `type`.

## Suggested TypeScript Model

```ts
type PendingAppointmentApprovalPreviewItem = {
  appointment_id: string;
  client_id: string | null;
  client_name: string | null;
  appointment_date: string;
  service_name: string | null;
  status: "pending";
};

type ClientRequiringRebookPreviewItem = {
  client_id: string;
  client_name: string | null;
  last_appointment_date: string;
  last_service_name: string | null;
};

type ClientActionItem =
  | {
      id: "pending-appointment-approvals";
      type: "pending_appointment_approvals";
      label: string;
      priority: "high";
      count: number;
      preview: PendingAppointmentApprovalPreviewItem[];
    }
  | {
      id: "clients-requiring-rebook";
      type: "clients_requiring_rebook";
      label: string;
      priority: "medium";
      count: number;
      preview: ClientRequiringRebookPreviewItem[];
    };
```
