# Thank You Email Automation Controls Handoff

This handoff is for adding the new **Thank You Emails** automation to the app's Automations Controls screen.

## Goal

Let eligible stylists turn on thank-you emails that are created after completed appointments, reviewed before sending, and delivered with the client's referral link plus a backend-generated QR code.

This is not just a template setting. It is an approval-based automation pipeline, similar to rebook nudges.

## Plan Gating

Feature key:

```ts
thankYouEmails
```

Availability:

- Basic: unavailable
- Pro: available
- Premium: available
- Cancelled plans: unavailable

The backend enforces plan eligibility on settings, toggle, list, create, approve, and cancel endpoints. The frontend should still use feature flags to hide, disable, or upsell the control.

## Automations Screen Data

Load the existing activity dashboard:

```http
GET /api/activity/dashboard
```

The response `data.automation_controls` now includes:

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

Top-level dashboard counts also include:

```ts
type ThankYouEmailDashboardCounts = {
  pending_thank_you_email_count: number;
  queued_thank_you_email_count: number;
  needs_attention: {
    pending_thank_you_email_count: number;
  };
};
```

## Control Row UI

Add a row/card for:

- Title: `Thank You Emails`
- Key: `thank_you_emails`
- Toggle state: `control.enabled`
- Disabled/upsell state: `control.feature_available === false`
- Status text: `control.status_label`

Recommended status behavior:

- If `feature_available=false`: show `Upgrade required`
- If `pending_approval_count > 0`: show approval badge, for example `3 need approval`
- Else show queued count, for example `2 queued`

Suggested row actions:

- Toggle on/off
- Open settings
- Open approval queue when `pending_approval_count > 0`

## Toggle Endpoint

Use the existing automation setting endpoint:

```http
PATCH /api/activity/automation/settings/thank_you_emails
```

Request:

```ts
type UpdateAutomationSettingRequest = {
  enabled: boolean;
};
```

Response:

```ts
type AutomationSettingResponse = {
  data: {
    id: string;
    user_id: string;
    key: "thank_you_emails";
    enabled: boolean;
    created_at: string;
    updated_at: string;
  };
};
```

On success, update local state or refetch `GET /api/activity/dashboard`.

If the backend returns `403`, show the plan-gated/upgrade state.

## Settings Panel

Use:

```http
GET /api/settings/thank-you-emails
PATCH /api/settings/thank-you-emails
POST /api/settings/thank-you-emails/preview
```

Settings response:

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

Defaults from backend:

- `approvalRequired`: `true`
- `sendDelayHours`: `0`
- `subjectTemplate`: `null`
- `customMessageBlock`: `null`

Editable settings:

```ts
type UpdateThankYouEmailSettingsRequest = {
  approvalRequired?: boolean;
  sendDelayHours?: number;
  subjectTemplate?: string | null;
  customMessageBlock?: string | null;
};
```

Validation:

- `sendDelayHours`: integer from `0` to `720`
- `subjectTemplate`: max `160` chars
- `customMessageBlock`: max `4000` chars
- Template syntax: `{{token_name}}`
- Only `availableTokens` are supported

Important: QR code is not a template token. The backend generates it from the referral URL when the thank-you email is queued.

## Preview

Call preview from the settings panel:

```http
POST /api/settings/thank-you-emails/preview
```

Request can include:

```ts
type PreviewThankYouEmailRequest = {
  subjectTemplate?: string | null;
  customMessageBlock?: string | null;
};
```

Response:

```ts
type PreviewThankYouEmailResponse = {
  data: {
    subject: string;
    text: string;
    html: string;
  };
};
```

Use this to render a preview. The preview may use a sample QR image URL. Real delivered emails embed the QR code as an inline attachment.

## Approval Queue

Use this for the "needs approval" view:

```http
GET /api/thank-you-emails?status=pending_approval&limit=25
```

Response:

```ts
type ListThankYouEmailsResponse = {
  data: ThankYouEmail[];
  next_cursor: string | null;
};
```

Treat `next_cursor` as opaque. Request the next page with:

```http
GET /api/thank-you-emails?status=pending_approval&limit=25&cursor=<next_cursor>
```

Queue item shape:

```ts
type ThankYouEmail = {
  id: string;
  client_id: string;
  appointment_id: string;
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
  template_data: {
    recipient_name?: string;
    service_name?: string;
    appointment_date_display?: string;
    business_display_name?: string;
    referral_url?: string;
    referral_code?: string;
    [key: string]: unknown;
  };
  approved_at: string | null;
  cancelled_at: string | null;
  cancelled_reason: string | null;
  sent_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};
```

Recommended item display:

- Client: `template_data.recipient_name`
- Service: `template_data.service_name`
- Visit date: `template_data.appointment_date_display`
- Recipient: `recipient_email`
- Referral link: `referral_url_snapshot`
- QR preview: `qr_code_url_snapshot`
- Send timing: `send_after`

Use `qr_code_url_snapshot` only for previewing the pending row. Do not generate a new QR code in the app.

## Approval Actions

Approve:

```http
POST /api/thank-you-emails/:id/approve
```

Moves `pending_approval` to `queued`.

Cancel:

```http
POST /api/thank-you-emails/:id/cancel
```

Request:

```ts
type CancelThankYouEmailRequest = {
  reason?: string | null;
};
```

Rows in `pending_approval`, `queued`, `sending`, or `failed` can be cancelled.

After approve/cancel, remove the item from the pending list or refetch the queue and dashboard counts.

## Optional Manual Create

If the app wants a manual "send thank-you email for this completed appointment" action:

```http
POST /api/thank-you-emails
```

Request:

```ts
type CreateThankYouEmailRequest = {
  appointment_id: string;
  approval_required?: boolean;
};
```

The backend requires:

- Appointment belongs to the stylist
- Appointment status is `completed`
- Client has an email address
- No active/sent thank-you email already exists for that appointment
- Stylist has Pro/Premium access

## Empty, Loading, And Error States

Recommended settings states:

- Loading: skeleton or spinner in settings panel
- `403`: upgrade prompt or plan-restricted message
- Validation error: show backend message near the edited field
- Preview error: keep editor content, show retry

Recommended approval queue states:

- Loading: list skeleton
- Empty: `No thank-you emails need approval`
- Row error: show `error` when status is `failed`
- Pagination: show "Load more" when `next_cursor` is present

## Acceptance Checks

- Basic account sees Thank You Emails as upgrade-required or does not see the enabled control.
- Pro/Premium account can toggle `thank_you_emails`.
- Settings panel loads current thank-you email settings.
- Settings panel can save `approvalRequired`, `sendDelayHours`, subject, and custom message.
- Preview renders subject, text, and HTML.
- Pending approval count opens a list of `pending_approval` rows.
- Approve moves a row out of pending and refreshes counts.
- Cancel moves a row out of pending and refreshes counts.
- Referral link and QR preview come from backend snapshot fields.
- The app never generates referral codes or QR codes for sent thank-you emails.

## Related Backend Contract

Full backend/API details live in:

- `docs/frontend-thank-you-emails-contract.md`
- `docs/frontend-referrals-web-handoff.md`
