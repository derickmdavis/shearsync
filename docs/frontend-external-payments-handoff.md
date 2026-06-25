# External Payment Shortcuts Frontend Handoff

This handoff covers frontend integration for stylist-owned external payment shortcuts.

Important boundary:

DripDesk does **not** process, verify, record, or track payments in this feature. The frontend should present this only as a way for stylists to save external payment links/QR codes they can share with clients. Appointment-level payment state lives outside DripDesk.

Use copy like:

```txt
Payment is completed outside DripDesk. DripDesk does not process or verify this payment.
```

Avoid copy like:

- Payment processed by DripDesk
- Payment confirmed
- Payment recorded
- Appointment payment state controls
- Charge customer
- Capture payment
- Refund through DripDesk
- DripDesk checkout

## Backend Scope

All endpoints are authenticated stylist/admin endpoints under the existing auth boundary.

There are no public client payment mutation endpoints.

No appointment-level payment state, payment tracking, Stripe, Square API, PayPal API, Venmo API, OAuth, webhooks, refunds, payouts, tax reporting, or processor reconciliation were added.

## Suggested Frontend Surface

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

Do not add appointment-level payment-state controls.

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
- Inactive methods should be hidden unless the settings UI has an include inactive or archive view.
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
- `qr_image_path`: optional, max 500 chars. Must be the bucket-relative path returned by `POST /api/payment-methods/qr-upload-intent`, shaped like `<user-id>/<image-id>.png`.
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
- Use copy like `Deactivate payment shortcut`.
- Do not imply any appointment payment history exists in DripDesk.

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
- `storage_path` is relative to the private `payment-method-qrs` bucket. Do not prefix it with the bucket name.

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

## Empty State

Suggested copy:

```txt
Add external payment shortcuts so you can quickly share payment links or QR codes with clients. Payment happens outside DripDesk.
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

Do not expose backend internals, storage paths, or stack traces.

## Frontend Implementation Checklist

1. Add API client methods for `/api/payment-methods`.
2. Add `PaymentProvider` and `PaymentMethod` types.
3. Build payment shortcuts settings UI.
4. Add QR upload flow using `qr-upload-intent`.
5. Preserve the external-payment copy boundary.
6. Add frontend tests for create/edit/deactivate/reorder shortcut flows.

## Known Follow-Ups

- Add signed-read support for private QR images if the frontend needs to render uploaded QR files from `qr_image_path`.
- Consider exposing a current default shortcut in appointment detail responses if the frontend wants fewer round trips.
- Consider adding frontend analytics for payment shortcut creation.
