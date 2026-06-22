# External Payment Shortcuts Frontend Handoff

This handoff covers frontend integration for stylist-owned external payment shortcuts and manual appointment payment records.

Important boundary:

DripDesk does **not** process or verify payments in this feature. The frontend should present this as a way for stylists to save external payment links/QR codes and manually record that an appointment was paid outside DripDesk.

Use copy like:

```txt
Payment is completed outside DripDesk. DripDesk does not process or verify this payment.
```

Avoid copy like:

- Payment processed by DripDesk
- Payment confirmed
- Charge customer
- Capture payment
- Refund through DripDesk
- DripDesk checkout

## Backend Scope

All endpoints are authenticated stylist/admin endpoints under the existing auth boundary.

There are no public client payment mutation endpoints.

No Stripe, Square API, PayPal API, Venmo API, OAuth, webhooks, refunds, payouts, tax reporting, or processor reconciliation were added.

## Suggested Frontend Surfaces

### Payment Shortcuts Settings

Add a settings screen or section where a stylist can manage external payment methods.

Recommended route:

```txt
/settings/payment-shortcuts
```

Core UI:

- List saved payment shortcuts.
- Create shortcut.
- Edit shortcut.
- Deactivate shortcut.
- Mark one active shortcut as default.
- Reorder shortcuts.
- Upload or paste a QR image/link.

### Appointment Payment Panel

Add an appointment detail panel section where a stylist can manually record payment status.

Suggested labels:

- `Payment`
- `Manually mark paid`
- `Recorded payment`
- `External payment method`
- `Mark unpaid`

The UI should make clear that this is a manual record, not payment processing.

## Types

```ts
type PaymentProvider =
  | "venmo"
  | "paypal"
  | "square"
  | "cash_app"
  | "zelle"
  | "apple_pay"
  | "google_pay"
  | "cash"
  | "other";

type AppointmentPaymentStatus =
  | "unpaid"
  | "marked_paid"
  | "partially_paid"
  | "refunded"
  | "voided";

type PaymentMethod = {
  id: string;
  user_id: string;
  provider: PaymentProvider;
  display_name: string;
  payment_url: string | null;
  qr_image_url: string | null;
  qr_image_path: string | null;
  instructions: string | null;
  is_default: boolean;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
  payment_notice: string;
};

type AppointmentPayment = {
  id: string;
  appointment_id: string;
  payment_method_id: string | null;
  status: AppointmentPaymentStatus;
  amount: number;
  tip_amount: number;
  total_recorded: number;
  external_provider: PaymentProvider | null;
  external_provider_label: string | null;
  external_reference: string | null;
  notes: string | null;
  marked_paid_at: string | null;
  created_at: string;
  updated_at: string;
  payment_method: {
    id: string;
    provider: PaymentProvider;
    display_name: string;
  } | null;
  payment_notice: string;
};
```

## Payment Method Endpoints

### List Payment Shortcuts

```http
GET /api/payment-methods
GET /api/payment-methods?include_inactive=true
```

Default behavior returns active methods only.

Ordering:

1. `is_default desc`
2. `sort_order asc`
3. `created_at asc`

Response:

```ts
type ListPaymentMethodsResponse = {
  data: PaymentMethod[];
};
```

Frontend behavior:

- Default method should be visually marked.
- Inactive methods should be hidden unless the settings UI has an “include inactive” or archive view.
- Use `display_name` for the visible label.
- Use provider-specific labels/icons in the UI, but keep the backend enum value as the persisted provider.

### Create Payment Shortcut

```http
POST /api/payment-methods
```

Request:

```ts
type CreatePaymentMethodRequest = {
  provider: PaymentProvider;
  display_name: string;
  payment_url?: string | null;
  qr_image_url?: string | null;
  qr_image_path?: string | null;
  instructions?: string | null;
  is_default?: boolean;
  is_active?: boolean;
  sort_order?: number;
};
```

Success:

```ts
type CreatePaymentMethodResponse = {
  data: PaymentMethod;
};
```

Validation notes:

- `display_name`: required, max 80 chars.
- `payment_url`: optional, valid URL, max 2048 chars.
- `qr_image_url`: optional, valid URL, max 2048 chars.
- `qr_image_path`: optional, max 500 chars.
- `instructions`: optional, max 500 chars.
- `sort_order`: integer, default `0`.
- At least one of `payment_url`, `qr_image_url`, or `qr_image_path` is required unless provider is `cash` or `other`.

Recommended form behavior:

- For link-based providers, show a URL field.
- For QR-based setup, show QR upload.
- For `cash`, allow no URL/QR.
- For `other`, allow no URL/QR but encourage instructions.
- Include a default toggle.

### Update Payment Shortcut

```http
PATCH /api/payment-methods/:id
```

Allowed request fields:

```ts
type UpdatePaymentMethodRequest = Partial<CreatePaymentMethodRequest>;
```

Success:

```ts
type UpdatePaymentMethodResponse = {
  data: PaymentMethod;
};
```

Frontend behavior:

- If `is_default=true`, the backend unsets other active defaults.
- If `is_active=false`, the backend clears `is_default` for that method.
- After update, replace local state from the returned `data`.

### Deactivate Payment Shortcut

```http
DELETE /api/payment-methods/:id
```

This is a soft delete. It sets:

```ts
{
  is_active: false,
  is_default: false
}
```

Success:

```ts
type DeletePaymentMethodResponse = {
  data: PaymentMethod;
};
```

Frontend behavior:

- Remove it from the active list immediately.
- Do not imply old appointment payment history was deleted.
- Use copy like `Deactivate payment shortcut`, not `Delete payment history`.

### Reorder Payment Shortcuts

```http
POST /api/payment-methods/reorder
```

Request:

```ts
type ReorderPaymentMethodsRequest = {
  items: Array<{
    id: string;
    sort_order: number;
  }>;
};
```

Success:

```ts
type ReorderPaymentMethodsResponse = {
  data: PaymentMethod[];
};
```

Frontend behavior:

- Optimistic drag-and-drop is fine, but reconcile from response.
- Backend verifies every ID belongs to the authenticated stylist.

## QR Upload Intent

### Create Upload Intent

```http
POST /api/payment-methods/qr-upload-intent
```

Request:

```ts
type PaymentQrUploadIntentRequest = {
  filename: string;
  content_type: "image/png" | "image/jpeg" | "image/webp";
  size_bytes: number;
};
```

Success:

```ts
type PaymentQrUploadIntentResponse = {
  data: {
    upload_url: string;
    storage_path: string;
    expires_in: number;
  };
};
```

Rules:

- Authenticated only.
- Max size: 5MB.
- Allowed MIME types: `image/png`, `image/jpeg`, `image/webp`.
- The backend generates the storage path.
- Do not let the user provide a storage path.

Upload flow:

1. User chooses QR image.
2. Validate MIME and size client-side for fast feedback.
3. Call `POST /api/payment-methods/qr-upload-intent`.
4. Upload the file bytes to `data.upload_url`.
5. Create or update the payment method with `qr_image_path: data.storage_path`.

Example:

```ts
const intent = await api.post("/api/payment-methods/qr-upload-intent", {
  filename: file.name,
  content_type: file.type,
  size_bytes: file.size
});

await fetch(intent.data.upload_url, {
  method: "PUT",
  headers: {
    "content-type": file.type
  },
  body: file
});

await api.post("/api/payment-methods", {
  provider: "zelle",
  display_name: "Zelle QR",
  qr_image_path: intent.data.storage_path
});
```

Note: this endpoint creates a signed upload URL only. It does not create a public image URL. If the frontend needs to display saved QR images later, add a signed-read endpoint in a follow-up.

## Appointment Payment Endpoints

### Get Appointment Payment

```http
GET /api/appointments/:appointmentId/payment
```

Success:

```ts
type GetAppointmentPaymentResponse = {
  data: {
    payment: AppointmentPayment | null;
    payment_notice: string;
  };
};
```

Frontend behavior:

- If `payment === null`, show unpaid/manual not recorded state.
- If `payment.status === "marked_paid"`, show recorded paid state.
- Always show the notice somewhere near the manual payment controls.

### Mark Appointment Paid

```http
POST /api/appointments/:appointmentId/payment/mark-paid
```

Request:

```ts
type MarkAppointmentPaidRequest = {
  payment_method_id?: string | null;
  amount?: number;
  tip_amount?: number;
  external_provider?: PaymentProvider | null;
  external_provider_label?: string | null;
  external_reference?: string | null;
  notes?: string | null;
};
```

Success:

```ts
type MarkAppointmentPaidResponse = {
  data: {
    payment: AppointmentPayment;
    payment_notice: string;
  };
};
```

Validation notes:

- `amount`: optional, number >= 0, max 999999.99.
- If `amount` is omitted, backend defaults to the appointment `price`.
- `tip_amount`: optional, number >= 0, max 999999.99, default `0`.
- `payment_method_id`: optional; if provided, it must be active and owned by the authenticated stylist.
- `external_provider`: optional; must match `PaymentProvider`.
- `external_reference`: optional, max 255 chars.
- `notes`: optional, max 2000 chars.

Frontend behavior:

- Pre-fill amount from the appointment price if available.
- Allow tip amount if the UI supports it.
- Let the stylist select one active payment shortcut.
- If a payment shortcut is selected, the backend snapshots its provider/display label.
- Show success as `Payment recorded` or `Appointment manually marked paid`.
- Do not show `Payment confirmed` or `Payment processed`.

### Mark Appointment Unpaid

```http
POST /api/appointments/:appointmentId/payment/mark-unpaid
```

Success:

```ts
type MarkAppointmentUnpaidResponse = {
  data: {
    payment: AppointmentPayment | null;
    payment_notice: string;
  };
};
```

Backend behavior:

- Existing current payment record is marked `voided`.
- Backend preserves the old record for audit/support.
- If no current payment exists, response `payment` may be `null`.

Frontend behavior:

- Use copy like `Mark unpaid` or `Void recorded payment`.
- Do not call this a refund.
- After success, display unpaid/manual not recorded state.

### Edit Appointment Payment

```http
PATCH /api/appointments/:appointmentId/payment
```

Request:

```ts
type UpdateAppointmentPaymentRequest = {
  payment_method_id?: string | null;
  amount?: number;
  tip_amount?: number;
  external_provider?: PaymentProvider | null;
  external_provider_label?: string | null;
  external_reference?: string | null;
  notes?: string | null;
};
```

Success:

```ts
type UpdateAppointmentPaymentResponse = {
  data: {
    payment: AppointmentPayment;
    payment_notice: string;
  };
};
```

Frontend behavior:

- Use this for correcting manually entered amount, tip, reference, notes, or method.
- Do not expose raw status editing.
- Do not allow changing a manual record into any “verified” or processor-backed state.

## Provider Labels

Suggested UI labels:

```ts
const paymentProviderLabels: Record<PaymentProvider, string> = {
  venmo: "Venmo",
  paypal: "PayPal",
  square: "Square",
  cash_app: "Cash App",
  zelle: "Zelle",
  apple_pay: "Apple Pay",
  google_pay: "Google Pay",
  cash: "Cash",
  other: "Other"
};
```

## Empty States

### No Payment Shortcuts

Suggested copy:

```txt
Add external payment shortcuts so you can quickly share payment links or QR codes with clients. Payment happens outside DripDesk.
```

### No Appointment Payment Record

Suggested copy:

```txt
No payment has been manually recorded for this appointment.
```

CTA:

```txt
Mark paid
```

## Error Handling

Recommended handling:

- `400`: show validation message near the relevant field.
- `401`: send user through existing auth flow.
- `404`: show not found or stale-data state.
- `500`: generic error toast.

Safe generic copy:

```txt
Unable to save payment shortcut. Please try again.
```

```txt
Unable to record appointment payment. Please try again.
```

Do not expose backend internals, storage paths, or stack traces.

## Frontend Implementation Checklist

1. Add API client methods for `/api/payment-methods`.
2. Add API client methods for appointment payment endpoints.
3. Add `PaymentProvider` and `AppointmentPayment` types.
4. Build payment shortcuts settings UI.
5. Add QR upload flow using `qr-upload-intent`.
6. Add appointment payment panel.
7. Use active payment shortcuts as the method picker.
8. Preserve the manual/external payment copy boundary.
9. Handle inactive methods gracefully if old payment records reference them.
10. Add frontend tests for create/edit/deactivate shortcut and mark paid/unpaid.

## Known Follow-Ups

- Add signed-read support for private QR images if the frontend needs to render uploaded QR files from `qr_image_path`.
- Consider exposing a current default shortcut in appointment detail responses if the frontend wants fewer round trips.
- Consider adding frontend analytics for payment shortcut creation and manual payment recording.
