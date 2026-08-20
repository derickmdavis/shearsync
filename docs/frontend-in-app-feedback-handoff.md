# In-app feedback — frontend handoff

The backend feedback endpoint is ready for the existing mobile feedback box.

## Endpoint

```http
POST /api/feedback
Authorization: Bearer <Supabase access token>
Content-Type: application/json
```

Send only the selected rating and optional text. Do not send a user ID, account ID, timestamp, source, or any Supabase service key.

```json
{
  "rating": 3,
  "feedback": "I love the new client detail screen."
}
```

The API derives the current user from the bearer token, stores the creation time itself, and marks the source as `mobile_app`.

## UI mapping

Map the existing emoji choices as follows:

| UI choice | Request value |
| --- | --- |
| Sad | `1` |
| Neutral / middle | `2` |
| Happy | `3` |

`rating` is required. The user may submit a rating with an empty feedback field.

## Success response

The API returns `201 Created`:

```json
{
  "data": {
    "id": "uuid",
    "rating": 3,
    "feedbackText": "I love the new client detail screen.",
    "createdAt": "2026-08-20T03:00:00.000Z"
  }
}
```

On success:

1. Show the existing success/thank-you state.
2. Clear the text input.
3. Clear the selected emoji/rating, or close the feedback sheet if that matches the current UI pattern.

## Submission behavior

- Disable submit until the user selects a rating.
- Disable the button while the request is in progress, preventing duplicate taps.
- Preserve the selected rating and typed text if the request fails, so the user can retry.
- Trim display/input text normally; the backend also trims it and saves blank text as `null`.
- Feedback may be submitted by authenticated inactive or expired accounts. Do not hide or block this form based on subscription state.

## Errors

Use the API client's standard error handling. The response format is:

```json
{
  "error": {
    "message": "Validation failed"
  }
}
```

Important cases:

| Status | Meaning | UI behavior |
| --- | --- | --- |
| `400` | No rating, invalid rating, extra fields, or text longer than 4,000 characters | Show an inline message; keep the user's form values. |
| `401` | Missing, expired, or invalid session | Use the app's normal re-authentication/session-expired flow. |
| `429` | More than 10 submissions from the same account in one hour | Show a brief “Please try again later” message; preserve the form. |
| `500` | Temporary backend/database problem | Show a retryable generic error; preserve the form. |

Do not display raw backend `details` to users.

## Suggested client call

Use the app's existing authenticated API wrapper. Conceptually:

```ts
await api.post("/api/feedback", {
  rating: selectedRating,
  feedback: feedbackText
});
```

`selectedRating` must be the numeric `1`, `2`, or `3`; do not send emoji labels. Omit `feedback` or send an empty string when no text was entered.

## Scope boundary

This is submission-only. There is no mobile read/list endpoint and no Ops feedback inbox yet.
