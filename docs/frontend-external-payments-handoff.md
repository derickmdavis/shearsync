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
- Enter a payment link and preview the QR code generated from that link.
- Optionally support a legacy uploaded/external QR image as a fallback only.

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
  qr_image_url: string | null; // Persisted externally hosted QR image URL, if any.
  qr_image_path: string | null;
  qr_image_display_url: string | null; // Response-only signed URL for a private uploaded QR image.
  qr_image_display_url_expires_at: string | null;
  instructions: string | null;
  is_default: boolean;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
  payment_notice: string;
};
```

Compatibility and security rules:

- `qr_image_url` is a durable external image URL and remains unchanged in responses.
- `qr_image_display_url` is a short-lived, response-only URL generated from `qr_image_path`; it is never accepted or persisted by create/update requests.
- Render uploaded private QR images with `qr_image_display_url ?? qr_image_url`.
- Do not persist, log, send to analytics, or reuse an expired `qr_image_display_url`. Refetch the payment methods to receive a fresh URL.

## Product Decision: Payment Links Generate QR Codes Locally

The primary flow is link-first:

1. The stylist enters a payment link in Settings.
2. The app persists that link as `payment_url`.
3. The appointment payment sheet generates and displays a QR code whose content is exactly `payment_url`.

No QR image is uploaded, stored, or fetched for this primary flow. The backend does not generate QR codes; it validates and stores the payment link. Use a frontend QR-code component/library appropriate to the app platform and pass it the raw `payment_url` value.

Private QR-image fields are supported only for older or custom uploaded QR assets:

- `qr_image_display_url`: preferred, short-lived signed URL for a private uploaded QR image.
- `qr_image_url`: durable externally hosted QR image URL.
- `qr_image_path`: backend-managed private Storage object path; do not construct a URL from it.

For the appointment sheet, use this precedence:

```ts
const qrSource = paymentMethod.payment_url
  ? { kind: "generated" as const, value: paymentMethod.payment_url }
  : paymentMethod.qr_image_display_url
    ? { kind: "image" as const, value: paymentMethod.qr_image_display_url }
    : paymentMethod.qr_image_url
      ? { kind: "image" as const, value: paymentMethod.qr_image_url }
      : null;
```

Generate the code only from a `payment_url`; do not try to generate a QR from `qr_image_path`, a signed image URL, or the payment method display name.

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
- Render an uploaded private QR image from `qr_image_display_url`; use `qr_image_url` only as the externally hosted fallback.
- Treat each list response as a fresh snapshot. If an uploaded QR image fails to load, refetch this endpoint once to refresh its signed display URL.

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

- For link-based providers, show a URL field and a local QR preview generated from the draft URL.
- Save only `payment_url` for the normal link-first flow. Do not upload the generated QR image and do not send `qr_image_display_url` or `qr_image_display_url_expires_at`.
- Keep QR upload as an optional compatibility feature only when the stylist explicitly supplies an image that cannot be represented by a link.
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

## Optional Uploaded QR Image Support

Do not call this endpoint for the normal link-to-QR flow. It is only for a custom QR image that the frontend cannot generate from `payment_url`.

### QR Upload Intent

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

The bucket remains private. Subsequent payment-method responses include a short-lived `qr_image_display_url` for an uploaded `qr_image_path`; refetch payment methods if that URL expires.

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

For the appointment sheet, distinguish these states:

- `payment_url` present: generate the QR locally; no signed URL is required.
- `qr_image_display_url` present: render the signed image; on a load failure refetch `GET /api/payment-methods` once.
- Neither source present: show a concise unavailable state and a link back to payment-shortcut settings for the stylist. Do not display a QR for arbitrary text.

## Appointment Sheet Implementation

Load active payment methods through `GET /api/payment-methods` when the appointment payment sheet opens or when the screen becomes active. Select the default method when one exists; otherwise follow the app's existing chooser behavior.

```ts
const methods = (await api.get<ListPaymentMethodsResponse>("/api/payment-methods")).data;
const selected = methods.find((method) => method.is_default) ?? methods[0] ?? null;

if (selected?.payment_url) {
  return <QrCode value={selected.payment_url} />;
}

const uploadedQrUrl = selected?.qr_image_display_url ?? selected?.qr_image_url;
if (uploadedQrUrl) {
  return <Image source={{ uri: uploadedQrUrl }} />;
}

return <PaymentMethodUnavailable />;
```

Do not cache signed image URLs as durable state. It is safe to keep them in in-memory screen state for the current session; replace them with the next API response. Never include payment URLs, signed URLs, or QR paths in analytics events or diagnostic logs.

## Frontend Test Matrix

1. Saving a valid `payment_url` creates/updates a shortcut and immediately renders a locally generated QR in the appointment sheet.
2. The QR value exactly equals `payment_url`, including query parameters; it is not a QR of a provider label or image URL.
3. Link-only methods do not call `qr-upload-intent` and do not require `qr_image_display_url`.
4. An uploaded private QR image renders from `qr_image_display_url`.
5. A failed private-image load causes one payment-method refetch, then shows a safe unavailable state if the refreshed image also fails.
6. A response-only `qr_image_display_url` and expiry are never included in create/update payloads, persistent storage, analytics, or logs.
7. An external `qr_image_url` continues to render as the fallback when no payment link or private display URL is available.
8. Deactivated methods are not shown in the appointment payment sheet.

## Frontend Implementation Checklist

1. Add API client methods for `/api/payment-methods`.
2. Add `PaymentProvider` and `PaymentMethod` types.
3. Build a link-first payment-shortcuts settings UI with a local QR preview.
4. Generate the appointment QR from `payment_url` and implement the uploaded-image fallback order above.
5. Add QR upload only if custom uploaded QR images remain a product requirement.
6. Preserve the external-payment copy boundary.
7. Add the test matrix above.

## Known Follow-Ups

- Consider exposing a current default shortcut in appointment detail responses if the frontend wants fewer round trips.
- Consider adding frontend analytics for payment shortcut creation.
