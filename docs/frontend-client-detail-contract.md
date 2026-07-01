# Frontend Client Detail Contract

## Endpoint

`GET /api/clients/:id/detail`

Auth is required. Results are scoped to the authenticated stylist.

This endpoint is the backend-owned foundation for the client detail screen. It does not replace every legacy call yet, but frontend client detail UI should prefer these backend-owned values over local calculations when present.

## Response Shape

```ts
type ClientDetailResponse = {
  data: {
    client: ClientRecord;
    identity: {
      display_name: string;
      avatar_url: string | null;
      avatar_image_id: string | null;
      avatar_initials: string;
      is_vip: boolean;
    };
    snapshot: {
      last_visit_at: string | null;
      last_visit_label: string | null;
      total_completed_visits: number;
      average_days_between_visits: number | null;
      total_spent: number;
      average_ticket: number | null;
      member_since: string | null;
      member_since_label: string | null;
    };
    rebooking_preference: {
      preferred_interval_days: number;
      next_recommended_date: string | null;
      next_recommended_label: string | null;
      basis_label: string;
      basis_visit_count: number;
      basis_visit_count_label: string;
      source: "manual" | "auto" | "default";
      is_overridden: boolean;
    };
    next_appointment: AppointmentRecord | null;
    next_appointment_summary: {
      when_label: string | null;
      duration_label: string | null;
      status_label: string;
      status_tone: "success";
    } | null;
    status_summary: {
      status_label: string;
      status_tone: "neutral" | "success" | "warning" | "danger";
    };
    value_summary: {
      total_spent: number;
      average_ticket: number | null;
      rebooking_rate: number | null;
      trend_label: string;
      trend_detail: string;
    };
    recent_history: {
      data: AppointmentRecord[];
      next_cursor: string | null;
    };
    visual_history: {
      data: Array<{
        id: string;
        thumbnail_url: string | null;
        full_url: string | null;
        caption: string | null;
        source_label: string;
        service_label: string | null;
        appointment_id: string | null;
        created_at: string;
      }>;
      photo_count: number;
      history_available: boolean;
    };
  };
};
```

## Backend-Owned Rules

- `identity.display_name` uses `preferred_name` first, then first/last name.
- `identity.is_vip` comes from persisted `clients.is_vip`; do not infer VIP from tags.
- `identity.avatar_image_id` comes from `clients.avatar_image_id`, which points to a ready image owned by the same client.
- `identity.avatar_url` is a signed thumbnail URL for `identity.avatar_image_id`; it is `null` when no avatar is set or the referenced image is no longer ready.
- `snapshot.total_completed_visits` counts appointments with `status = "completed"`.
- `snapshot.total_spent` and `snapshot.average_ticket` use completed appointment prices when completed history exists.
- `clients.total_spend` and `clients.last_visit_at` are fallback values when completed appointment history is absent.
- Date labels are formatted in the stylist business timezone.
- `rebooking_preference.preferred_interval_days` is auto-derived from average completed visit spacing when possible.
- When there is not enough completed history, rebooking preference falls back to the account default rebook interval.
- `rebooking_preference.source = "manual"` and `is_overridden = true` when a per-client override exists.
- `rebooking_preference.basis_visit_count` and `basis_visit_count_label` are backend-owned; do not calculate “based on last X visits” in the UI.
- Auto basis labels use the completed visit count used for interval basis, capped at 5 for display.
- Manual basis labels return `Manual override`; default basis labels return `Account default` or `Based on 1 completed visit` when one completed visit exists.
- `next_appointment` is the next non-cancelled appointment after the request time.
- `next_appointment_summary.when_label` and date labels use the stylist business timezone.
- `next_appointment_summary.duration_label` is backend-formatted, for example `45 min` or `1 hr 30 min`.
- `status_summary` is backend-owned: upcoming appointment is `success`, completed history without an upcoming appointment is `warning`, and no history is `neutral`.
- `value_summary.total_spent` and `value_summary.average_ticket` mirror the backend-owned snapshot values.
- `value_summary.rebooking_rate` is `100` when completed history has a future non-cancelled appointment, `0` when completed history has no future appointment, and `null` when there is no completed history.
- `value_summary.trend_label` and `value_summary.trend_detail` are backend-owned display copy.
- `recent_history` uses the same backend-owned rules as `GET /api/clients/:id/appointments?status=past&limit=3`.
- `recent_history.next_cursor` can be passed to the appointments endpoint as `cursor` to continue pagination.
- `visual_history` is the first preview page for the visual history section, using the same contract as `GET /api/clients/:id/visual-history` with a backend limit of 6.
- Use `visual_history.photo_count` for the photo badge; do not infer the count from `visual_history.data.length`.
- `visual_history.history_available = false` means the backend intentionally withheld the preview list, but `photo_count` is still authoritative.

## Rebooking Preference Mutation

Use `PATCH /api/clients/:id/rebooking-preference` to edit a client's manual interval.

Set an override:

```json
{ "preferred_interval_days": 35 }
```

Clear the override and return to automatic/default behavior:

```json
{ "preferred_interval_days": null }
```

The response is:

```ts
type RebookingPreferenceResponse = {
  data: ClientDetailResponse["data"]["rebooking_preference"];
};
```

## Avatar Mutation

Use `PATCH /api/clients/:id/avatar` to set or clear the selected client avatar image.

Set an avatar:

```json
{ "avatar_image_id": "44444444-4444-4444-8444-444444444471" }
```

Clear the avatar:

```json
{ "avatar_image_id": null }
```

The response is the updated identity object:

```ts
type ClientAvatarResponse = {
  data: ClientDetailResponse["data"]["identity"];
};
```

Non-null `avatar_image_id` values must reference a ready image owned by the same stylist and client. Use `identity.avatar_url` from the response for immediate UI refresh.

## Related Calls

The client detail payload now includes first-page recent history and visual history. Keep these calls for follow-up actions and deeper views:

- `GET /api/clients/:id/appointments?status=past&limit=3&cursor=...` for loading more appointment history
- `GET /api/clients/:id/visual-history` for full visual history and refreshes
- `PATCH /api/clients/:id` for client notes, profile fields, and VIP status with `is_vip`
- `PATCH /api/clients/:id/avatar` for client avatar selection
- `PATCH /api/appointments/:id`
- `PATCH /api/appointments/:id/decision`

## Recent History

Use `clientDetail.recent_history` for the first Recent History render. Use `GET /api/clients/:id/appointments?status=past&limit=3&cursor=...` only to load additional pages.

```ts
type ClientAppointmentsHistoryResponse = {
  data: AppointmentRecord[];
  next_cursor: string | null;
};
```

- Results are scoped to the authenticated stylist and verified against client ownership.
- `status=past` returns non-cancelled appointments before the request time.
- Results are ordered by `appointment_date desc`, then `id desc`.
- Pass `next_cursor` as `cursor` to load the next page.

## Visual History

Use `clientDetail.visual_history` for the first Visual History render and photo-count badge. Use `GET /api/clients/:id/visual-history` for the full visual history view or refreshes.

```ts
type ClientVisualHistoryResponse = {
  data: Array<{
    id: string;
    thumbnail_url: string | null;
    full_url: string | null;
    caption: string | null;
    source_label: string;
    service_label: string | null;
    appointment_id: string | null;
    created_at: string;
  }>;
  photo_count: number;
  history_available: boolean;
};
```

- Use `photo_count` for the badge; do not infer the count from `data.length`.
- `history_available = false` means the backend intentionally withheld the full image list, but `photo_count` is still authoritative.
- `full_url` is `null` unless `include_display_urls=true`; prefer on-demand display URL APIs for full-screen viewing.
