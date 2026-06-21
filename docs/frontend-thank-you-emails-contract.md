# Frontend Thank You Emails Contract

This is the frontend integration contract for the authenticated thank-you email automation. Thank-you emails are sent after completed appointments, include the client's referral link, and embed a QR code in the delivered email.

## Availability

This feature is plan-gated by `thankYouEmails`.

- Basic: unavailable
- Pro: available
- Premium: available
- Cancelled plans: unavailable through the existing entitlement behavior

Frontend should read plan features from the normal account/entitlement responses and hide or disable the UI when `thankYouEmails=false`. The backend also enforces this on every settings and workflow endpoint.

## Automation Control

The activity dashboard `automation_controls` array now includes:

```ts
type ThankYouEmailAutomationControl = {
  key: "thank_you_emails";
  label: "Thank You Emails";
  enabled: boolean;
  feature_available: boolean;
  status_label: string;
  pending_approval_count: number;
  queued_count: number;
};
```

Dashboard attention fields also include:

```ts
type ThankYouEmailAttention = {
  pending_thank_you_email_count: number;
  queued_thank_you_email_count: number;
  needs_attention: {
    pending_thank_you_email_count: number;
  };
};
```

Use the existing automation settings endpoint for toggling. The allowed automation key now includes:

```ts
"thank_you_emails"
```

## Settings

```http
GET /api/settings/thank-you-emails
PATCH /api/settings/thank-you-emails
POST /api/settings/thank-you-emails/preview
```

Auth is required. Basic and cancelled accounts receive an entitlement error.

### Settings Response

```ts
type ThankYouEmailSettings = {
  approvalRequired: boolean;
  sendDelayHours: number;
  subjectTemplate: string | null;
  customMessageBlock: string | null;
  configured: boolean;
  availableTokens: Array<
    | "client_name"
    | "business_name"
    | "business_phone"
    | "business_email"
    | "service_name"
    | "appointment_date"
    | "referral_url"
    | "referral_code"
  >;
};
```

Defaults:

- `approvalRequired`: `true`
- `sendDelayHours`: `0`
- `subjectTemplate`: `null`
- `customMessageBlock`: `null`

### Update Settings

```ts
type UpdateThankYouEmailSettingsRequest = {
  approvalRequired?: boolean;
  sendDelayHours?: number;
  subjectTemplate?: string | null;
  customMessageBlock?: string | null;
};
```

Validation:

- `sendDelayHours` must be an integer from `0` to `720`.
- `subjectTemplate` is max `160` characters.
- `customMessageBlock` is max `4000` characters.
- Only `availableTokens` are allowed in `{{token_name}}` template syntax.

QR code is not a template token. The backend generates and embeds it when the thank-you email is queued.

### Preview

`POST /api/settings/thank-you-emails/preview` accepts the same editable template fields and returns:

```ts
type ThankYouEmailPreviewResponse = {
  data: {
    subject: string;
    text: string;
    html: string;
  };
};
```

Use this for the settings preview pane. The preview HTML may reference a sample QR image URL; delivered emails use an inline QR attachment.

## Approval Queue

```http
GET /api/thank-you-emails
POST /api/thank-you-emails
POST /api/thank-you-emails/:id/approve
POST /api/thank-you-emails/:id/cancel
```

Auth is required. These endpoints are Pro/Premium only.

### List

```http
GET /api/thank-you-emails?status=pending_approval&limit=25&cursor=opaque
```

Query params:

```ts
type ListThankYouEmailsQuery = {
  status?:
    | "pending_approval"
    | "queued"
    | "sending"
    | "sent"
    | "cancelled"
    | "skipped"
    | "failed"
    | "superseded";
  limit?: number;
  cursor?: string;
};
```

Response:

```ts
type ListThankYouEmailsResponse = {
  data: ThankYouEmail[];
  next_cursor: string | null;
};
```

Treat `next_cursor` as opaque.

### Thank You Email Shape

```ts
type ThankYouEmail = {
  id: string;
  user_id: string;
  client_id: string;
  appointment_id: string;
  referral_link_id: string | null;
  email_event_id: string | null;
  recipient_email: string;
  status:
    | "pending_approval"
    | "queued"
    | "sending"
    | "sent"
    | "cancelled"
    | "skipped"
    | "failed"
    | "superseded";
  approval_required: boolean;
  send_after: string;
  referral_code_snapshot: string | null;
  referral_url_snapshot: string | null;
  qr_code_url_snapshot: string | null;
  subject_snapshot: string | null;
  custom_message_block_snapshot: string | null;
  template_data: Record<string, unknown>;
  approved_at: string | null;
  cancelled_at: string | null;
  cancelled_reason: string | null;
  sent_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};
```

Recommended queue UI fields:

- client name from `template_data.recipient_name`
- service from `template_data.service_name`
- visit date from `template_data.appointment_date_display`
- recipient email from `recipient_email`
- referral URL from `referral_url_snapshot`
- QR preview from `qr_code_url_snapshot`
- delivery timing from `send_after`
- error text from `error` for failed rows

### Create Manual Thank You Email

```http
POST /api/thank-you-emails
```

```ts
type CreateThankYouEmailRequest = {
  appointment_id: string;
  approval_required?: boolean;
};
```

The appointment must belong to the stylist, be `completed`, have a client with an email address, and not already have an active/sent thank-you email. The backend creates or reuses the client's referral link and snapshots the referral URL, referral code, QR code, and template data.

### Approve

```http
POST /api/thank-you-emails/:id/approve
```

Only `pending_approval` rows can be approved. Approval moves the row to `queued`.

### Cancel

```http
POST /api/thank-you-emails/:id/cancel
```

```ts
type CancelThankYouEmailRequest = {
  reason?: string | null;
};
```

Rows in `pending_approval`, `queued`, `sending`, or `failed` can be cancelled. If a linked appointment email event exists, the backend skips it.

## Backend Job Flow

Internal jobs are already wired:

```http
POST /api/internal/thank-you-emails/queue
POST /api/internal/thank-you-emails/process
```

Queue query params:

```ts
type InternalQueueThankYouEmailsQuery = {
  user_limit?: number;
  per_user_limit?: number;
  limit?: number; // backwards-compatible alias for per_user_limit
};
```

The queue job detects eligible completed appointments. The process job turns queued thank-you email rows into `appointment_email_events`. Normal appointment email delivery then sends the message and marks the thank-you row as `sent`, `failed`, or `skipped`.

Frontend does not call internal endpoints.

## Frontend Acceptance Checks

- Basic accounts do not show an enabled thank-you email UI.
- Pro/Premium accounts can open settings, edit templates, and preview.
- Automation controls show `Thank You Emails` with pending and queued counts.
- The automation toggle accepts `thank_you_emails`.
- Pending rows can be approved or cancelled.
- Failed rows show `error` and can be cancelled.
- The referral link and QR preview use backend snapshot fields, not frontend-generated referral codes.
- Delivered email preview includes referral link/code text; actual delivery embeds the QR code as an inline attachment.
