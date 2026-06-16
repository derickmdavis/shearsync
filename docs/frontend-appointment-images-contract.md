# Frontend Appointment Images Contract

This document describes the authenticated frontend contract for the private stylist appointment image UI.

It covers Chunk 7 of `docs/appointment-images-implementation-plan.md`: the appointment detail UI where stylists can add, view, update, reorder, and delete private appointment images.

## Current Backend Status

The backend is ready for the private stylist workflow:

- Private Supabase Storage bucket: `appointment-images`
- Appointment image metadata table: `public.appointment_images`
- Authenticated appointment image API routes
- Server-owned Storage paths
- Signed upload URLs
- Signed thumbnail/read URLs
- Finalize verification against Storage object metadata
- Delete cleanup
- Expired pending upload cleanup
- Orphan Storage cleanup/reporting
- Client purge Storage cleanup

The next frontend step is to build the private mobile appointment images UI.

## Chunk 7 Goal

Add an appointment images section to the authenticated stylist appointment detail screen.

When this chunk is complete, a stylist should be able to:

- See existing appointment image thumbnails.
- Add an image from camera/gallery.
- Have the app generate a compressed display image and thumbnail.
- Upload both files through the private upload-intent/finalize flow.
- Open a full-screen viewer that loads the display image only on demand.
- Delete images.
- See useful loading, empty, progress, failure, and retry states.

Local caching, thumbnail prefetch, and public booking reference photos are not part of this chunk.

## Authentication

All endpoints below are authenticated stylist endpoints.

Use the same auth pattern as the rest of the private mobile app:

```http
Authorization: Bearer <supabase-auth-jwt>
Content-Type: application/json
```

The backend derives `user_id` from the token and only returns images for appointments owned by that stylist.

## Limits And Constants

```ts
const APPOINTMENT_IMAGE_MAX_COUNT = 10;
const APPOINTMENT_IMAGE_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const UPLOAD_INTENT_TTL_MINUTES = 15;
const SIGNED_THUMBNAIL_URL_TTL_SECONDS = 300;
const SIGNED_DISPLAY_URL_TTL_SECONDS = 300;

const ALLOWED_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

const IMAGE_ROLES = [
  "before",
  "after",
  "inspiration",
  "reference",
  "formula",
  "progress",
  "general"
] as const;
```

Recommended frontend behavior:

- Prefer JPEG or WebP for generated display images.
- Generate thumbnails as JPEG or WebP.
- Keep both display image and thumbnail under 5 MB.
- Treat signed URLs as short-lived and refresh them when needed.
- Do not store signed URLs as durable state.

## Data Types

```ts
type AppointmentImageRole =
  | "before"
  | "after"
  | "inspiration"
  | "reference"
  | "formula"
  | "progress"
  | "general";

type AppointmentImageSource = "stylist" | "client";

type AppointmentImageUploadStatus = "pending" | "ready" | "failed" | "expired";

type AppointmentImage = {
  id: string;
  user_id: string;
  client_id: string | null;
  appointment_id: string;
  bucket: "appointment-images";
  storage_path: string;
  thumbnail_path: string | null;
  original_filename: string | null;
  content_type: "image/jpeg" | "image/png" | "image/webp";
  file_size_bytes: number;
  thumbnail_size_bytes: number | null;
  width: number | null;
  height: number | null;
  image_role: AppointmentImageRole;
  image_source: AppointmentImageSource;
  captured_at: string | null;
  label: string | null;
  tags: string[];
  uploaded_by_user_id: string | null;
  public_upload_token_id: string | null;
  caption: string | null;
  sort_order: number;
  cache_version: number;
  upload_status: AppointmentImageUploadStatus;
  upload_expires_at: string | null;
  finalized_at: string | null;
  created_at: string;
  updated_at: string;

  // Present on list/finalize/update responses when thumbnail_path exists.
  thumbnail_url?: string;
};

type AppointmentImageListResponse = {
  data: AppointmentImage[];
};
```

Only `upload_status = "ready"` images are returned by the list endpoint.

## Endpoints

### List Appointment Images

```http
GET /api/appointments/:appointmentId/images
```

Returns ready images ordered by `sort_order`, then creation time.

Response:

```ts
type Response = {
  data: AppointmentImage[];
};
```

Important frontend notes:

- Each image may include a `thumbnail_url`.
- Thumbnail URLs expire after about 5 minutes.
- If an image load fails with an expired signed URL, call list again or update local state after a fresh list response.
- Do not request display-size URLs for the grid/list.

### Create Upload Intent

```http
POST /api/appointments/:appointmentId/images/upload-intent
```

Request:

```ts
type CreateUploadIntentRequest = {
  original_filename?: string | null;
  content_type: "image/jpeg" | "image/png" | "image/webp";
  input_size_bytes: number;
  display_content_type: "image/jpeg" | "image/png" | "image/webp";
  thumbnail_content_type: "image/jpeg" | "image/png" | "image/webp";
};
```

Response:

```ts
type SignedUploadUrl = {
  signedUrl: string;
  token: string;
  path: string;
};

type CreateUploadIntentResponse = {
  data: AppointmentImage & {
    signed_upload_urls: {
      display: SignedUploadUrl;
      thumbnail: SignedUploadUrl;
    };
    max_constraints: {
      max_images: 10;
      max_file_size_bytes: 5242880;
      upload_expires_in_minutes: 15;
    };
  };
};
```

Important frontend notes:

- The backend creates a pending DB row.
- The backend decides the only valid Storage paths.
- Use the returned `path` values later in finalize.
- Upload must finish before `upload_expires_at`.
- If the appointment already has 10 active images, this returns `409`.

### Upload To Supabase Storage

After creating the upload intent, upload both generated files directly to Supabase Storage.

Use the private bucket:

```ts
const bucket = "appointment-images";
```

Preferred Supabase JS shape:

```ts
await supabase.storage
  .from("appointment-images")
  .uploadToSignedUrl(display.path, display.token, displayFile, {
    contentType: displayContentType,
    upsert: true
  });

await supabase.storage
  .from("appointment-images")
  .uploadToSignedUrl(thumbnail.path, thumbnail.token, thumbnailFile, {
    contentType: thumbnailContentType,
    upsert: true
  });
```

Use the values returned from `signed_upload_urls`:

```ts
const display = intent.signed_upload_urls.display;
const thumbnail = intent.signed_upload_urls.thumbnail;
```

Important frontend notes:

- Upload the display image and thumbnail before calling finalize.
- The uploaded object metadata must match finalize metadata.
- `contentType` matters. If the app says `image/jpeg`, upload a real JPEG with that content type.
- `file_size_bytes` in finalize must match the display object size.
- `thumbnail_size_bytes` in finalize should match the thumbnail object size.

### Finalize Appointment Image

```http
POST /api/appointments/:appointmentId/images
```

Request:

```ts
type FinalizeAppointmentImageRequest = {
  image_id: string;
  storage_path: string;
  thumbnail_path: string;
  original_filename?: string | null;
  content_type: "image/jpeg" | "image/png" | "image/webp";
  file_size_bytes: number;
  thumbnail_size_bytes?: number | null;
  width?: number | null;
  height?: number | null;
  image_role?: AppointmentImageRole; // defaults to "general"
  captured_at?: string | null; // ISO datetime
  label?: string | null; // 1-120 trimmed chars
  tags?: string[]; // max 10, each 1-40 chars
  caption?: string | null; // max 1000 chars
  sort_order?: number; // >= 0
};
```

Response:

```ts
type FinalizeAppointmentImageResponse = {
  data: AppointmentImage;
};
```

What the backend verifies:

- Pending row exists for this user and appointment.
- Upload intent has not expired.
- `storage_path` and `thumbnail_path` match the pending row.
- Paths match the server-owned path convention.
- Display Storage object exists.
- Thumbnail Storage object exists.
- Display object content type equals `content_type`.
- Display object byte size equals `file_size_bytes`.
- Thumbnail content type is inferred from its file extension.
- Thumbnail byte size equals `thumbnail_size_bytes` when supplied.
- Neither object exceeds 5 MB.

Finalize failure behavior:

- If verification fails, backend deletes the uploaded objects and marks the DB row `failed`.
- The frontend should show upload failed and allow the user to start over with a new upload intent.
- Reusing the same failed intent is not supported.

### Get Display Image URL

```http
GET /api/appointments/:appointmentId/images/:imageId/display-url
```

Response:

```ts
type DisplayUrlResponse = {
  data: {
    image_id: string;
    display_url: string;
    updated_at: string;
    cache_version: number;
    content_type: "image/jpeg" | "image/png" | "image/webp";
    width: number | null;
    height: number | null;
  };
};
```

Important frontend notes:

- Call this only when the user opens the full-screen viewer.
- Display URLs expire after about 5 minutes.
- If the full-screen image fails due to URL expiry, request a fresh display URL.
- Do not prefetch display-size images in Chunk 7.

### Update Image Metadata

```http
PATCH /api/appointments/:appointmentId/images/:imageId
```

Request:

```ts
type UpdateAppointmentImageRequest = {
  caption?: string | null;
  image_role?: AppointmentImageRole;
  sort_order?: number;
  label?: string | null;
  tags?: string[];
};
```

At least one field is required.

Response:

```ts
type UpdateAppointmentImageResponse = {
  data: AppointmentImage;
};
```

### Reorder Images

```http
POST /api/appointments/:appointmentId/images/reorder
```

Request:

```ts
type ReorderAppointmentImagesRequest = {
  image_ids: string[]; // 1-50 UUIDs
};
```

Response:

```ts
type ReorderAppointmentImagesResponse = {
  data: AppointmentImage[];
};
```

Important frontend notes:

- Every ID must belong to the appointment and be ready.
- Backend writes `sort_order` sequentially from array order.
- Optimistic reorder is okay, but revert on error.

### Delete Image

```http
DELETE /api/appointments/:appointmentId/images/:imageId
```

Response:

```http
204 No Content
```

Important frontend notes:

- Backend deletes Storage objects first, then DB row.
- If Storage delete fails, the API returns an error and the image remains in DB.
- The UI should not remove the image permanently until the API succeeds.
- Optimistic removal is okay if reverted on error.

## Recommended Upload Flow

```ts
async function uploadAppointmentImage(input: {
  appointmentId: string;
  originalAsset: LocalImageAsset;
  role?: AppointmentImageRole;
  label?: string | null;
  caption?: string | null;
}) {
  // 1. Pick or capture image.
  const original = input.originalAsset;

  // 2. Generate display image and thumbnail locally.
  const display = await createDisplayImage(original);
  const thumbnail = await createThumbnailImage(original);

  // 3. Enforce limits before creating an intent.
  if (display.sizeBytes > 5 * 1024 * 1024) {
    throw new Error("Image is too large");
  }

  // 4. Create upload intent.
  const intentResponse = await api.post(
    `/api/appointments/${input.appointmentId}/images/upload-intent`,
    {
      original_filename: original.filename ?? null,
      content_type: display.contentType,
      input_size_bytes: display.sizeBytes,
      display_content_type: display.contentType,
      thumbnail_content_type: thumbnail.contentType
    }
  );

  const intent = intentResponse.data;

  // 5. Upload both files to Supabase Storage.
  await supabase.storage
    .from("appointment-images")
    .uploadToSignedUrl(
      intent.signed_upload_urls.display.path,
      intent.signed_upload_urls.display.token,
      display.file,
      { contentType: display.contentType, upsert: true }
    );

  await supabase.storage
    .from("appointment-images")
    .uploadToSignedUrl(
      intent.signed_upload_urls.thumbnail.path,
      intent.signed_upload_urls.thumbnail.token,
      thumbnail.file,
      { contentType: thumbnail.contentType, upsert: true }
    );

  // 6. Finalize metadata.
  const finalized = await api.post(
    `/api/appointments/${input.appointmentId}/images`,
    {
      image_id: intent.id,
      storage_path: intent.storage_path,
      thumbnail_path: intent.thumbnail_path,
      original_filename: original.filename ?? null,
      content_type: display.contentType,
      file_size_bytes: display.sizeBytes,
      thumbnail_size_bytes: thumbnail.sizeBytes,
      width: display.width,
      height: display.height,
      image_role: input.role ?? "general",
      captured_at: original.capturedAt ?? null,
      label: input.label ?? null,
      tags: [],
      caption: input.caption ?? null
    }
  );

  return finalized.data;
}
```

## UI Placement

Add an appointment images section to the private appointment detail screen.

Recommended section behavior:

- Header: "Images" plus count, for example `3/10`.
- Add button opens camera/gallery action sheet.
- Thumbnail grid or horizontal strip depending on appointment detail layout.
- Empty state only when there are no ready images.
- Show upload progress cells inline while uploading.
- Failed upload cells should include retry/remove actions.

Avoid loading display-size images in the appointment detail screen.

## Thumbnail UI

Each thumbnail card should show:

- Thumbnail image.
- Optional role chip or small label.
- Optional client-sourced indicator when `image_source = "client"` in later chunks.
- Upload/progress overlay for local pending uploads.
- Error overlay for local failed uploads.

Use `thumbnail_url` for the image source. If the URL expires or image loading fails, refresh the image list.

## Full-Screen Viewer

When the stylist taps a thumbnail:

1. Open viewer shell immediately with thumbnail or skeleton.
2. Call `GET /api/appointments/:appointmentId/images/:imageId/display-url`.
3. Load `display_url`.
4. Show metadata such as role, label, captured date, source, dimensions, and caption when present.
5. Include delete action.

If display URL expires while viewer is open, request a new display URL.

## Image Processing Requirements

Before upload, generate two files:

### Display Image

Purpose: full-screen viewing.

Recommended:

- Preserve useful quality.
- Limit long edge to a reasonable mobile display size, for example 1600-2400 px.
- Keep under 5 MB.
- Prefer JPEG/WebP unless the source transparency matters.
- Capture final `width`, `height`, `contentType`, and byte size after compression.

### Thumbnail Image

Purpose: appointment detail grid/list.

Recommended:

- Square crop or center-fit depending on UI.
- Around 300-600 px.
- Keep small; ideally well under 500 KB.
- Use JPEG/WebP.
- Capture final `contentType` and byte size after generation.

The backend validates object metadata against finalize metadata, so the frontend must use post-compression metadata, not original asset metadata.

## Error Handling

Recommended mappings:

```ts
type AppointmentImageUiError =
  | "permission_denied"
  | "image_too_large"
  | "unsupported_type"
  | "upload_limit_reached"
  | "upload_expired"
  | "storage_upload_failed"
  | "finalize_failed"
  | "signed_url_expired"
  | "delete_failed"
  | "network_error";
```

Backend status codes to expect:

- `400`: invalid payload, unsupported type, object metadata mismatch, incomplete upload.
- `401`: missing/invalid auth.
- `404`: appointment or image not found.
- `409`: appointment image limit reached.
- `410`: upload intent expired.
- `500`: Storage/signing/backend failure.

Suggested user-facing behavior:

- `400 image too large`: Ask user to choose a smaller image or retry compression.
- `409`: Disable add button and show max count reached.
- `410`: Restart upload from a new intent.
- Storage upload failure: Keep local failed cell and allow retry from the beginning.
- Finalize failure: Assume backend cleaned Storage and restart from a new intent.
- Delete failure: Keep image visible and show retry.

## Local UI State Model

The API only returns persisted ready images. The frontend should maintain local transient upload items.

```ts
type LocalAppointmentImageItem =
  | {
      kind: "remote";
      image: AppointmentImage;
    }
  | {
      kind: "uploading";
      localId: string;
      previewUri: string;
      progress: number;
      role: AppointmentImageRole;
    }
  | {
      kind: "failed";
      localId: string;
      previewUri?: string;
      error: AppointmentImageUiError;
      canRetry: boolean;
    };
```

After finalize succeeds:

- Replace the local uploading item with the returned remote image.
- Or refetch `GET /images` and reconcile by `id`.

## Retry Rules

Retry from the beginning for:

- Upload intent expired.
- Storage upload failed.
- Finalize failed.
- Backend returned `400`, `410`, or `500` during finalize.

Do not retry by reusing the same pending `image_id` unless the original finalize request failed due to a pure network interruption and you know both files were uploaded. Even then, safest MVP behavior is to start over.

## Privacy And Security Requirements

- Never expose raw Storage paths in visible UI.
- Never persist signed URLs as durable records.
- Never send Storage paths chosen by the user. Always use backend-returned paths.
- Never list images from public booking screens.
- Do not prefetch display-size images.
- Treat all image URLs as private, short-lived credentials.
- Do not include signed URLs in analytics/logging.

## Scope Boundaries

### In Chunk 7

- Appointment detail image section.
- List thumbnails.
- Upload image.
- Finalize image.
- View display image on demand.
- Delete image.
- Basic metadata display/update if product wants it now.
- Empty/progress/failure/retry states.

### Not In Chunk 7

- Local disk cache.
- Offline image rendering.
- Upcoming appointment thumbnail prefetch.
- Public booking reference uploads.
- Client-facing image UI.
- Storage usage dashboard.
- Drag-and-drop reorder unless it is already cheap in the UI framework.

## QA Checklist

Use these as manual acceptance tests.

1. Appointment with no images shows empty state and add action.
2. Add image from gallery succeeds and thumbnail appears.
3. Add image from camera succeeds and thumbnail appears.
4. Full-screen viewer loads display image only after tap.
5. Closing and reopening viewer refreshes display signed URL when needed.
6. Delete removes image after API success.
7. Delete failure keeps image visible.
8. Uploading an image over 5 MB is blocked before or rejected by backend.
9. Unsupported file type is blocked before upload.
10. 10 existing ready images disables or rejects additional upload.
11. Upload can recover cleanly after network failure.
12. Upload intent expiration starts a new upload.
13. Thumbnail URL expiry is handled by refreshing list.
14. Another stylist cannot access the appointment images.
15. Appointment list/detail does not load display-size images automatically.

## Useful Backend References

- Routes: `src/routes/appointmentRoutes.ts`
- Validators: `src/validators/appointmentImageValidators.ts`
- Controller: `src/controllers/appointmentImagesController.ts`
- Service: `src/services/appointmentImagesService.ts`
- Storage helper: `src/services/appointmentImageStorageService.ts`
- Cleanup service: `src/services/appointmentImageCleanupService.ts`
- Tests: `src/__tests__/appointmentImages.test.ts`
