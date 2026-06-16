# Appointment Images Implementation Plan

## Current Architecture Findings

DripDesk/ShearSync in this checkout is the backend API repo, not the mobile frontend repo.

Current backend stack:

- Node.js 20, TypeScript, Express 4.
- Supabase Auth, Postgres, and Storage are the platform assumptions.
- Runtime uses `supabaseAdmin` with `SUPABASE_SERVICE_ROLE_KEY` for business data and `supabaseAnon` for JWT claim validation.
- Routes are mounted through `src/routes/index.ts`.
- Authenticated `/api/*` routes pass through `requireAuth` in `src/middleware/auth.ts`.
- Controllers are thin; most logic belongs in `src/services/*`.
- Validation uses Zod validators in `src/validators/*`.
- Errors use `ApiError` and `handleSupabaseError`, returning `{ error: { message, details } }`.

Current Supabase/database patterns:

- Business-owned records are scoped by `user_id`.
- `appointments.user_id`, `clients.user_id`, `photos.user_id`, `services.user_id`, and similar tables use `user_id` as the ownership field.
- `appointments.client_id` is currently `not null` and cascades on client delete.
- `clients` already has `deleted_at` and `deleted_reason`, but current service code still hard-deletes clients.
- `stylists` exists, but it is profile/booking-page metadata with a unique `user_id`; most private CRM tables do not reference `stylist_id`.
- Existing services validate ownership by querying with both resource ID and `user_id`.
- `appointmentsService.getOwned(userId, appointmentId)` already exists and is the right ownership primitive for appointment images.
- `clientsService.assertOwned(userId, clientId)` is reused by photos, appointments, and reminders.

Existing image/photo support:

- `public.photos` exists with `id`, `user_id`, `client_id`, `file_path`, `photo_type`, `caption`, `created_at`.
- `GET /api/clients/:id/photos` lists client photo metadata.
- `POST /api/photos` records metadata only.
- There is no upload signing, no backend Storage write, no signed read URL generation, no thumbnail handling, and no delete/cleanup endpoint.
- `cover_photo_url` is a plain URL string on `stylists`; it is not a protected storage-path pattern and should not be reused for private appointment images.

Frontend/mobile findings:

- The actual mobile app code is not present in this repo.
- Docs confirm a mobile-first app and appointment detail API, but no local `AppointmentDetail` or `ClientDetail` screen implementation is inspectable here.
- Any frontend file/component names below are recommended targets for the mobile codebase, not confirmed files in this checkout.
- No Expo/image-picker/compression/cache dependencies can be verified from this backend repo.

Reusable patterns to keep:

- Add new `appointmentImagesController`, `appointmentImagesService`, route file, and validator file.
- Use `getAuthUserId(req)` and route params like existing appointment routes.
- Use `appointmentsService.getOwned()` before every list/upload/update/delete.
- Use Zod for MIME type, size, role, caption, and reorder validation.
- Use `{ data: ... }` response wrappers for new appointment-image endpoints.
- Use service-role Supabase only on the backend.

Gaps and risks:

- Existing `photos` support is metadata-only and may mislead frontend expectations.
- RLS is enabled on many tables, but checked-in schema/migrations only show explicit policies for some tables. New `appointment_images` must include complete select/insert/update/delete policies.
- Existing Express JSON body limit is `1mb`, which reinforces avoiding base64 uploads through JSON.
- There is no existing storage bucket migration/convention in code.
- There is no cleanup job infrastructure yet beyond internal script-style routes.
- Local image caching will need to be implemented in the mobile app, not this backend repo.

## Recommended Data Model

Create a new table instead of extending `photos`.

Recommended table: `public.appointment_images`

Fields:

- `id uuid primary key default gen_random_uuid()`
- `user_id uuid not null references public.users(id) on delete cascade`
- `client_id uuid null references public.clients(id) on delete set null`
- `appointment_id uuid not null references public.appointments(id) on delete cascade`
- `bucket text not null default 'appointment-images'`
- `storage_path text not null`
- `thumbnail_path text null`
- `original_filename text null`
- `content_type text not null`
- `file_size_bytes bigint not null`
- `thumbnail_size_bytes bigint null`
- `width integer null`
- `height integer null`
- `image_role text not null default 'general'`
- `image_source text not null default 'stylist'`
- `captured_at timestamptz null`
- `label text null`
- `tags text[] not null default '{}'`
- `uploaded_by_user_id uuid null references public.users(id) on delete set null`
- `public_upload_token_id uuid null`
- `caption text null`
- `sort_order integer not null default 0`
- `cache_version integer not null default 1`
- `upload_status text not null default 'ready'`
- `upload_expires_at timestamptz null`
- `finalized_at timestamptz null`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

`cache_version` should be required so the mobile app can determine whether locally cached image files are stale without relying on broad `updated_at` behavior. Image bytes should be immutable for MVP: metadata updates such as caption, role, and sort order do not change `cache_version`; deleting and re-uploading creates a new `image_id`. A future image-replace flow can increment `cache_version`.

Recommended mobile cache keys:

- Thumbnail: `appointment-image/{image_id}/thumb/v{cache_version}`
- Display image: `appointment-image/{image_id}/display/v{cache_version}`

`updated_at` should still be returned for metadata display/sync, but it should not be the primary image-byte cache key.

`upload_status` values:

- `pending`
- `ready`
- `failed`
- `expired`

The pending state prevents upload races. Upload-intent creation should reserve an `image_id` and paths before the client uploads to Storage. Max image enforcement should count both `pending` and `ready` rows that have not expired.

I would not include `stylist_id` in the MVP table. The current private-data ownership model is `user_id`, and `stylists.id` is not used by appointments/clients/photos. If product later needs multi-stylist teams, that should be a broader ownership model change rather than a one-off nullable FK. If included anyway, make it nullable and denormalized from `stylists.user_id`, not trusted from the frontend.

Allowed `image_role` values:

- `before`
- `after`
- `inspiration`
- `reference`
- `formula`
- `progress`
- `general`

Allowed `image_source` values:

- `stylist`
- `client`

Metadata notes:

- `captured_at` should default to the appointment time for client-uploaded booking reference photos and to upload time for stylist-created appointment documentation unless the mobile client provides a more specific capture date.
- `label` is a short human-readable label for UI display, for example "Consultation reference", "Before color", or "After cut".
- `tags` gives the product room to support multiple labels later without schema churn. Start with controlled UI values that overlap with `image_role`, then expand only when needed.
- `image_role` should remain the primary normalized category for filtering/reporting.
- `image_source` distinguishes stylist-taken documentation from client-submitted booking reference photos.

Indexes:

- `appointment_images_appointment_id_idx on appointment_images(appointment_id)`
- `appointment_images_client_id_idx on appointment_images(client_id)`
- `appointment_images_user_id_idx on appointment_images(user_id)`
- `appointment_images_user_appointment_sort_idx on appointment_images(user_id, appointment_id, sort_order, created_at desc)`
- `appointment_images_user_client_idx on appointment_images(user_id, client_id)`
- `appointment_images_user_created_idx on appointment_images(user_id, created_at desc)`

Constraints:

- `image_role` check constraint.
- `file_size_bytes > 0`.
- `thumbnail_size_bytes is null or thumbnail_size_bytes > 0`.
- `width is null or width > 0`.
- `height is null or height > 0`.
- `upload_status` check constraint.
- `image_source` check constraint.
- `captured_at is null or captured_at <= now() + interval '1 day'` if the team wants to block accidental far-future capture dates.
- `char_length(label) <= 120`.
- Optional tag count/length constraint, for example max 10 tags and max 40 chars per tag.
- `unique(bucket, storage_path)`.
- Partial unique index on `(bucket, thumbnail_path) where thumbnail_path is not null`.
- Optional: `content_type in ('image/jpeg', 'image/png', 'image/webp')`.

Relationships:

- `user_id` is the primary ownership scope.
- `appointment_id` is required and cascades DB rows when an appointment is deleted.
- `client_id` should be copied from the appointment at creation time, not accepted from the frontend.
- With the recommended soft-delete model, normal client deletion should not cascade appointment/image rows immediately. If a client is purged after retention, hard delete will cascade DB rows after Storage cleanup.

RLS:

- Enable RLS on `appointment_images`.
- Add full owner policies:
  - select: `auth.uid() = user_id`
  - insert: `auth.uid() = user_id`
  - update: `auth.uid() = user_id`
  - delete: `auth.uid() = user_id`
- The backend will still use service role, but RLS matters for defense in depth and any future direct Supabase access.

`updated_at` and `cache_version`:

- Current schema has many `updated_at` columns but no obvious global trigger pattern in this repo.
- Either add a local `set_updated_at` trigger if one already exists in production, or update `updated_at` from the backend on PATCH/reorder.
- Metadata-only changes should update `updated_at` but should not increment `cache_version`.
- Any future image replacement that changes image bytes should increment `cache_version`.

Usage summary:

- MVP should calculate usage from `appointment_images`.
- Add a view now or later:
  - `user_storage_usage`
  - grouped by `user_id`
  - sums `file_size_bytes + coalesce(thumbnail_size_bytes, 0)`
  - includes `image_count`
- Do not create a cached usage table until there is plan enforcement, billing UI, or performance pressure.

Client retention model:

- Change client deletion from immediate hard delete to soft delete.
- Existing `clients.deleted_at` and `clients.deleted_reason` can be reused.
- Add `clients.purge_after timestamptz null`.
- Recommended retention: 30 days from `deleted_at`.
- Normal client lists/search should exclude `deleted_at is not null` by default.
- Add an explicit deleted/archived client view if the UI needs reactivation.
- Reactivation clears `deleted_at`, `deleted_reason`, and `purge_after`.
- During retention, appointments and appointment images remain in Postgres and Supabase Storage.
- After retention expires, a purge job hard-deletes the client and removes related appointment image Storage objects.
- Public booking/client matching should explicitly decide how to handle soft-deleted clients. Recommended MVP behavior: do not silently match/reactivate deleted clients from public booking; require stylist reactivation or create a new active client record based on product preference.

Complexity impact:

- This adds moderate backend complexity, not a full rewrite.
- The schema already anticipated deletion metadata, which helps.
- The main work is changing `clientsService.remove()` semantics, filtering normal client queries, adding reactivation/purge paths, and ensuring Storage cleanup happens during purge.
- It reduces data-loss risk and gives users a safety window, but it requires clear UI states so deleted clients do not appear as normal active clients.

## Storage/Bucket Plan

Use one private Supabase Storage bucket for MVP:

- Bucket: `appointment-images`
- Public: false
- File size limit: ideally aligned with backend/client limits.
- Allowed MIME types: `image/jpeg`, `image/png`, `image/webp`.

Supabase Storage remains the source of truth. Local device cache is only a performance and offline-read layer. The app must never treat locally cached files as authoritative records, and it must not support images that exist only locally after upload completes.

I would not reuse the existing `photos` metadata table or `cover_photo_url` convention. The current cover photo can be public/plain URL, while appointment images must be private and signed.

Recommended path pattern:

```text
users/{user_id}/clients/{client_id}/appointments/{appointment_id}/{image_id}.{ext}
users/{user_id}/clients/{client_id}/appointments/{appointment_id}/{image_id}_thumb.{ext}
```

Fallback if `client_id` ever becomes unavailable:

```text
users/{user_id}/appointments/{appointment_id}/{image_id}.{ext}
users/{user_id}/appointments/{appointment_id}/{image_id}_thumb.{ext}
```

Since current appointments require `client_id`, the client-scoped path should be available.

`ext` should be derived from the final stored content type:

- `image/webp` -> `.webp`
- `image/jpeg` -> `.jpg`
- `image/png` -> `.png`

The backend should generate paths after it knows the processed display and thumbnail MIME types. Do not hardcode `.webp` unless the mobile stack has been proven to output WebP reliably.

Signed read URLs:

- Backend generates signed read URLs using the service-role Supabase client.
- List endpoint should return signed thumbnail URLs only by default.
- Full display signed URL should be returned only on detail/view endpoint or by a specific "get image URL" action.
- Suggested TTL:
  - thumbnails: 15 to 60 minutes
  - display image: 5 to 15 minutes
- Do not expose public URLs.
- Storage paths may appear in authenticated API responses if needed for debugging, but the frontend should render via signed URLs and should not construct URLs itself.

Dynamic transformations:

- Do not rely on dynamic Supabase transformations at runtime for MVP.
- Store both display and thumbnail files at upload time.

## Backend/API Plan

Add routes under existing authenticated appointment routes:

- `GET /api/appointments/:id/images`
- `POST /api/appointments/:id/images/upload-intent`
- `POST /api/appointments/:id/images`
- `GET /api/appointments/:id/images/:imageId/display-url`
- `PATCH /api/appointments/:id/images/:imageId`
- `DELETE /api/appointments/:id/images/:imageId`
- `POST /api/appointments/:id/images/reorder`
- `GET /api/appointment-images/prefetch?start=YYYY-MM-DD&end=YYYY-MM-DD&limit=50`

Add public booking reference-photo routes:

- `POST /api/public/appointments/:token/reference-image/upload-intent`
- `POST /api/public/appointments/:token/reference-image`
- Optional: `DELETE /api/public/appointments/:token/reference-image`

These public routes should use a short-lived appointment-scoped token, not raw appointment IDs. The existing public appointment management-token pattern is a good conceptual fit, but the implementation should decide whether to extend that token or return a narrower one-time `reference_photo_upload_token` in the public booking confirmation response.

Recommended upload flow: direct-to-Supabase Storage with backend-issued signed upload URLs.

Flow:

1. Mobile app picks and compresses image locally.
2. Mobile app requests `POST /api/appointments/:id/images/upload-intent`.
3. Backend calls `appointmentsService.getOwned(userId, appointmentId)`.
4. Backend derives `client_id` and `user_id` from the appointment.
5. Backend enforces max image count by counting non-expired `pending` plus `ready` rows.
6. Backend validates declared MIME/size and derives file extensions from processed MIME types.
7. Backend creates a `pending` `appointment_images` row with `image_id`, display path, thumbnail path, `upload_expires_at`, and ownership fields.
8. Backend returns signed upload URLs for both display and thumbnail.
9. Mobile uploads display and thumbnail directly to Supabase Storage.
10. Mobile calls `POST /api/appointments/:id/images` to finalize metadata.
11. Backend revalidates ownership, path prefix, image count, MIME, sizes, and Storage object existence.
12. Backend updates the pending row to `ready`, stores final metadata, sets `finalized_at`, and keeps `cache_version = 1`.
13. Backend returns image metadata plus signed thumbnail URL.
14. Mobile writes the fetched/created thumbnail into local cache using `image_id` and `cache_version`.

This keeps large binary uploads out of Express while ensuring the backend controls paths and metadata.

Alternative backend-proxy upload should be avoided for MVP because:

- Current Express body limit is `1mb`.
- Multipart parsing is not installed.
- Backend upload would increase server bandwidth/memory pressure.

Endpoint behavior:

`GET /api/appointments/:id/images`

- Validate appointment ownership.
- Query `appointment_images` by `user_id` and `appointment_id`.
- Order by `sort_order`, then `created_at`.
- Return metadata, `cache_version`, `updated_at`, and signed thumbnail URLs.
- Do not return full display URLs unless requested via query like `includeDisplayUrls=true`, and avoid using that in normal screen load.
- The mobile app should use returned metadata to decide whether cached thumbnails are fresh.

`POST /api/appointments/:id/images/upload-intent`

Request:

- `original_filename`
- `content_type`
- `input_size_bytes`
- `display_content_type`
- `thumbnail_content_type`

Response:

- `image_id`
- `bucket`
- `storage_path`
- `thumbnail_path`
- `upload_expires_at`
- signed upload URL/token for display
- signed upload URL/token for thumbnail
- max constraints for client UX

Validation:

- Appointment belongs to authenticated user.
- Current non-expired pending plus ready image count is less than 10.
- Input file size <= 5 MB.
- MIME is one of JPEG/PNG/WebP.
- Path is backend-generated only.
- Existing expired pending rows for the same appointment may be marked `expired` or cleaned up before counting.

`POST /api/appointments/:id/images`

Purpose: finalize metadata after successful upload.

Request:

- `image_id`
- `storage_path`
- `thumbnail_path`
- `original_filename`
- `content_type`
- `file_size_bytes`
- `thumbnail_size_bytes`
- `width`
- `height`
- `image_role`
- `captured_at`
- `label`
- `tags`
- `caption`
- optional `sort_order`

Backend should:

- Validate appointment ownership.
- Derive `client_id` from appointment.
- Validate storage paths match the generated pattern for `user_id`, `client_id`, `appointment_id`, and `image_id`.
- Require an existing non-expired `pending` row for the same `image_id`, `user_id`, and `appointment_id`.
- Verify both display and thumbnail objects exist in Storage before finalizing.
- Verify object byte sizes and MIME/content type match the finalized metadata and allowed limits.
- Update the pending row to `ready` with final metadata, `image_source = 'stylist'`, `cache_version = 1`, and `finalized_at = now()`.
- If finalization fails after upload, attempt to delete both storage objects and mark the pending row `failed` or `expired`.

`GET /api/appointments/:id/images/:imageId/display-url`

- Validate appointment ownership and image ownership.
- Generate a short-lived signed URL for the display-size image.
- Return metadata including `image_id`, `updated_at`, `cache_version`, `content_type`, `width`, and `height`.
- The mobile app should use this URL only when the full-screen viewer needs it, then cache the display-size file locally after first successful fetch.

`PATCH /api/appointments/:id/images/:imageId`

- Validate image belongs to `user_id` and `appointment_id`.
- Allow only metadata updates:
  - `caption`
  - `image_role`
  - maybe `sort_order`
- Do not allow changing `storage_path`, `bucket`, `file_size_bytes`, or ownership fields.
- If the rendered image bytes do not change, do not increment `cache_version`.
- If a future image-replace endpoint changes image bytes, increment `cache_version`.

`DELETE /api/appointments/:id/images/:imageId`

- Validate image belongs to `user_id` and `appointment_id`.
- Delete storage objects first or after row lookup.
- Delete DB row.
- Return `204`.
- If storage delete fails because object is missing, still delete the DB row and log the missing object.
- If storage delete fails for another reason, return error unless an explicit "force DB cleanup" strategy is added.
- Response should be enough for the mobile app to clear local thumbnail/display cache entries for that `image_id`.

`POST /api/appointments/:id/images/reorder`

- Validate all image IDs belong to the appointment and user.
- Accept ordered IDs or `{ id, sort_order }[]`.
- Update `sort_order` in a transaction/RPC if possible.
- Return updated list.

`GET /api/appointment-images/prefetch?start=YYYY-MM-DD&end=YYYY-MM-DD&limit=50`

- Purpose: avoid N+1 endpoint calls when the mobile app prefetches thumbnails for today's and upcoming appointments.
- Validate authenticated user.
- Bound the date window, for example max 14 days.
- Bound the image count, for example max 50 thumbnails per request.
- Return only `ready` image rows.
- Return metadata needed for cache freshness: `image_id`, `appointment_id`, `client_id`, `cache_version`, `updated_at`, `thumbnail_size_bytes`, and signed thumbnail URL.
- Do not return display-size signed URLs.
- Order by appointment date, then image `sort_order`, then image `created_at`.

Public booking reference image flow:

1. Client completes public booking through `POST /api/public/bookings`.
2. Booking confirmation returns appointment/client IDs as it does today, plus a short-lived reference-photo upload token if reference uploads are enabled.
3. Public booking UI allows at most one reference photo.
4. Client picks one image and the frontend compresses/resizes it like stylist uploads.
5. Public UI requests `POST /api/public/appointments/:token/reference-image/upload-intent`.
6. Backend resolves token to exactly one appointment, client, and stylist/business owner.
7. Backend verifies the appointment is still valid and belongs to the token context.
8. Backend verifies there is no existing `ready` or non-expired `pending` client-sourced reference image for this appointment.
9. Backend creates a pending `appointment_images` row with:
   - `image_source = 'client'`
   - `image_role = 'reference'`
   - `label = 'Client reference'` unless the client supplies a short label
   - `captured_at = appointment.appointment_date` or upload time, depending on product preference
   - appointment/client/user ownership derived server-side
10. Backend returns signed upload URLs for display and thumbnail.
11. Client uploads directly to private Supabase Storage.
12. Client finalizes through `POST /api/public/appointments/:token/reference-image`.
13. Backend verifies Storage objects, updates the row to `ready`, and returns a minimal success payload.

Public reference-photo constraints:

- One client-sourced reference image per appointment for MVP.
- Must be distinguishable from stylist-created images via `image_source = 'client'`.
- Must use `image_role = 'reference'`.
- Public routes must never list all appointment images.
- Public routes must never return stylist-created image URLs.
- Public routes should only allow create/finalize/delete for the single client reference photo tied to the token.
- Token should expire, for example after 24 hours or at appointment start, whichever comes first.
- Token should not grant access to client profile history or other appointment images.
- If the appointment is cancelled, rejected, or outside the allowed upload window, reference upload should be rejected.

Security specifics:

- Never trust `user_id` or `client_id` from the frontend.
- Never accept arbitrary paths from the frontend in upload intent.
- Do not expose `SUPABASE_SERVICE_ROLE_KEY` outside backend.
- Use service role for signed URL generation, object verification, and deletes.
- Keep public booking image access limited to the one client-sourced reference image tied to a short-lived token. Public routes must not expose stylist-created appointment images.

Suggested files:

- `src/routes/appointmentImageRoutes.ts` or extend `appointmentRoutes.ts`
- `src/controllers/appointmentImagesController.ts`
- `src/services/appointmentImagesService.ts`
- `src/validators/appointmentImageValidators.ts`
- `src/types/api.ts`
- tests in `src/__tests__/apiRoutes.test.ts` or a focused new test file
- Supabase migration later, not in this planning task

## Frontend/Mobile Plan

Because frontend code is not present here, this is an integration plan for the mobile app.

Appointment detail changes:

- Add a compact `Images` or `Photos` section to appointment detail.
- Place it below core appointment/client/service info and above long history/activity, or in a tab/accordion if the detail screen is already dense.
- Show thumbnails only on initial load.
- Use horizontal carousel for 1 to 6 images, or a compact grid for denser visual history.
- Show an empty state with a small add action when no images exist.

Likely components:

- `AppointmentImagesSection`
- `AppointmentImageGrid` or `AppointmentImageCarousel`
- `AppointmentImageUploader`
- `AppointmentImageViewer`
- `AppointmentImageActionsMenu`
- `AppointmentImageRolePicker` later or MVP-light inline menu
- `AppointmentImageSourceBadge`
- `AppointmentImageCache` or shared image-cache utility

Behavior:

- On appointment detail mount, fetch:
  - `GET /api/appointments/:appointmentId`
  - `GET /api/appointments/:appointmentId/images`
- Render signed thumbnail URLs only when no fresh local cached thumbnail exists.
- Prefer fresh cached thumbnails when available.
- On thumbnail tap, use fresh cached display image if available.
- If no fresh cached display image exists, request `GET /api/appointments/:appointmentId/images/:imageId/display-url`, load the signed display URL, and cache the display-size image after first full-screen view.
- Do not load full images in appointment list/calendar views.
- If any high-level list later shows an image, use one small cached or signed thumbnail only.
- Show a subtle source indicator for client-submitted reference photos so the stylist can distinguish them from stylist-created documentation.
- Capture/display basic metadata:
  - role/category, such as reference, before, after, formula, progress, or general
  - source, such as client or stylist
  - date, preferably `captured_at` with fallback to `created_at`
  - short label when present
  - tags when the UI has room for them

Add image flow:

- User taps add.
- Offer camera and photo library.
- Allow multi-select from library if supported.
- Enforce max remaining slots before picker where possible.
- Compress/resize locally.
- Generate thumbnail locally.
- Request upload intent.
- Upload display image and thumbnail directly to Supabase Storage.
- Finalize metadata via backend.
- Refresh image list or optimistically insert returned metadata.
- Store local cache entries for the newly uploaded thumbnail and display image after finalize succeeds.
- Do not keep a local-only image as a completed record if upload/finalize fails.
- If upload intent expires before finalize, restart the upload flow with a new intent and clear the old temporary upload state.

Public booking reference photo UI:

- On the public booking confirmation screen, allow the client to add one optional reference photo.
- Use copy that frames this as a reference/inspiration image for the appointment, not a public portfolio upload.
- Compress and thumbnail the image before upload.
- Show upload progress and a success state.
- If upload fails, let the client retry while the token is valid.
- Do not show existing stylist-created appointment images in the public booking UI.
- If a reference photo already exists, show replace/delete only if product explicitly wants that behavior; otherwise show that the reference photo was received.

Delete flow:

- Confirm delete.
- Call backend delete endpoint.
- Optimistically remove from UI or remove after success.
- Clear cached thumbnail/display files for the deleted `image_id`.
- If delete fails, restore item/show retry.

Loading/failure states:

- Per-image upload progress.
- Per-image retry for failed uploads.
- Cancel upload if supported.
- Skeletons or neutral placeholders for thumbnail loading.
- Expired signed URL handling by refetching image list or requesting a new display URL.
- Offline fallback to fresh cached thumbnails/images when signed URLs are unavailable.

Dependencies to verify in frontend repo:

- If Expo: `expo-image-picker`.
- If Expo: `expo-image-manipulator` or current `expo-image`/manipulation capability for resizing/compression.
- If Expo: `expo-file-system` or equivalent for local image cache storage and file metadata.
- If bare React Native: equivalent picker/compressor such as `react-native-image-picker` and a maintained image-resizer library.
- Confirm WebP output support. If not reliable, use JPEG for MVP.

## Local Image Caching Plan

Local image caching is a performance and offline-read layer. Supabase Storage and `appointment_images` remain the source of truth.

What to cache:

- Cache thumbnails locally after first successful fetch.
- Cache display-size images locally after first successful full-screen view.
- Do not cache raw/original images because originals are not stored for MVP.
- Do not store images only locally after an upload has completed. Local files can exist temporarily during pending upload, but completed image records must correspond to Supabase Storage objects and DB metadata.

Prefetching:

- Prefetch thumbnails for today's appointments and upcoming appointments.
- Recommended prefetch window for MVP:
  - today
  - next 7 to 14 days
  - cap total prefetch work per app launch/session
- Prefetch only thumbnails, not display-size images.
- Run prefetch on Wi-Fi by default if the mobile stack can detect connection type.
- Avoid aggressive prefetching during low battery or constrained network if platform APIs make this available.

Offline behavior:

- When offline, show cached thumbnails/images if the cache key is still fresh for the latest locally known metadata.
- If signed URL generation fails or a signed URL expires, fall back to cached file when available.
- If neither signed URL nor cached file is available, show a placeholder and retry action.
- The app should still show image metadata from its normal API/cache layer if available, but should make clear that upload/delete actions require network.

Staleness rules:

- Cache identity should include:
  - `image_id`
  - variant: `thumb` or `display`
  - required `cache_version`
- If `cache_version` differs from the cached metadata, treat the local file as stale and refetch.
- Metadata-only changes like caption/role do not need to invalidate image bytes unless they alter rendered image output.
- Deletion immediately invalidates and removes all cached variants for the `image_id`.

Cache size:

- Recommended MVP limit: 500 MB total local image cache.
- Track cached file size, last accessed time, variant, `image_id`, and version metadata.
- Evict least-recently-used cached images when the cache exceeds the limit.
- Prefer evicting display-size images before thumbnails if both are present and the cache needs room.
- Never evict files currently being viewed or uploaded.

Cache index:

- Maintain a small local cache index using the mobile app's local persistence option.
- Minimum fields:
  - `image_id`
  - `variant`
  - `cache_version`
  - `local_uri`
  - `byte_size`
  - `last_accessed_at`
  - `created_at`
- On app startup or periodically, reconcile the cache index with actual files and remove broken entries.

Recommended cache lifecycle:

1. Image metadata is fetched from backend.
2. App computes cache key from `image_id`, variant, and version.
3. If fresh local file exists, render it and update `last_accessed_at`.
4. If no fresh local file exists, fetch signed URL, download/render image, then persist the file to cache.
5. After each cache write, run LRU eviction if total cache size exceeds 500 MB.
6. On delete success, remove all cached files for that `image_id`.
7. On logout or account switch, clear all cached images for the previous authenticated user. For privacy, clearing on logout is the safer MVP default.

Privacy note:

- Appointment images can include client faces and sensitive personal context.
- Local cached files should be stored in app-private storage, not the public camera roll.
- Cache directories should be scoped by authenticated account/user ID so account switching cannot reveal another user's cached images.
- Cached image files should be excluded from cloud/device backup where platform APIs support that.
- Do not expose cached files through share sheets or public document directories by default.
- Clear cached images on logout and account switch for MVP.
- Add an app-level "clear image cache" action when settings surface area allows it.

## Image Processing Plan

Preferred MVP: process on mobile before upload.

Settings:

- Display image longest edge: 1200 to 1600 px.
- Display quality: 0.75 to 0.85.
- Thumbnail longest edge: 300 to 400 px.
- Thumbnail quality: 0.65 to 0.75.
- Strip EXIF/location metadata if the mobile stack supports it.
- Correct orientation before upload.
- Capture final width/height and stored byte sizes.
- Do not store original/raw phone image.

Format:

- Prefer WebP if the current mobile stack reliably creates and displays it on target iOS/Android versions.
- Otherwise use JPEG for MVP.
- PNG should be accepted as input, but stored display output can still be JPEG/WebP unless transparency is truly needed.

HEIC:

- Support only if the mobile app can reliably convert HEIC to JPEG/WebP before upload.
- Do not upload HEIC directly for MVP unless Storage policies, render support, and processing are explicitly validated.

Backend processing alternative:

- Later add an Edge Function or backend worker to generate thumbnails server-side.
- This would reduce frontend complexity but adds worker/runtime complexity and potentially larger raw upload handling.
- Not recommended for first pass unless mobile compression is unavailable.

## Security and Privacy Plan

Required controls:

- Private bucket only.
- Signed URLs only.
- Backend validates appointment ownership for every action.
- Backend derives `user_id` and `client_id`.
- No public bucket listing.
- Public booking pages can upload one client reference photo, but must not expose stylist-created appointment images or broader client history.
- No service-role key in frontend.
- RLS on `appointment_images`.
- Storage paths scoped by authenticated user ID.
- EXIF/location metadata stripped where possible.
- Signed URLs short-lived.
- Logs should not include signed URLs or sensitive captions.
- Local cached files stored in app-private storage only.
- Cached images cleared on delete, logout, and account switch.
- Cached image files excluded from cloud/device backup where possible.

Client deletion:

- Current client delete is a hard delete, but appointment images should ship with a soft-delete retention model.
- During the retention period, appointment images remain in Storage and DB so the stylist can reactivate the client with history intact.
- After the retention window expires, purge must remove related Storage objects before the final hard delete.
- Mobile cache should clear cached images when it observes deletion or no longer sees records in refreshed metadata.

Account deletion:

- `users` cascades DB rows.
- Storage objects still need cleanup by prefix:
  - `users/{user_id}/...`
- Local cache should be cleared on logout and account deletion flows.

## Cleanup/Lifecycle Plan

Cases:

User deletes one appointment image:

- Backend reads row.
- Backend deletes `storage_path` and `thumbnail_path`.
- Backend deletes DB row.
- Missing storage object should be non-fatal after logging.
- Mobile clears cached thumbnail and display files for that `image_id`.

User deletes an appointment:

- DB row cascade can remove `appointment_images`.
- But Storage will not be cleaned automatically.
- Best MVP behavior: appointment delete service, if/when appointment delete exists, should explicitly list image rows first and delete storage objects before deleting the appointment.
- Current appointment routes do not expose delete, so this is future-facing.
- Mobile should remove cached images for appointment image records when appointment deletion is confirmed.

User soft-deletes a client:

- Current `clientsService.remove()` hard-deletes the client and must be changed before appointment images ship.
- Soft delete should set `deleted_at`, `deleted_reason`, and `purge_after = deleted_at + interval '30 days'`.
- Normal client lists/search should hide soft-deleted clients by default.
- Appointments and appointment images should remain available to a dedicated deleted-client/reactivation flow during retention.
- Mobile should remove cached images from normal active-client views after soft delete, but can refetch/cache them again if the stylist opens the deleted-client/reactivation view.

User reactivates a soft-deleted client:

- Backend validates ownership.
- Backend clears `deleted_at`, `deleted_reason`, and `purge_after`.
- Existing appointments and appointment images become visible again in normal client/appointment contexts.
- Storage objects do not need to move or change.

Retention expires and client is purged:

- A backend purge job finds clients where `purge_after <= now()`.
- Before hard-deleting the client row, it queries affected appointment image paths.
- It deletes all display and thumbnail objects from Supabase Storage.
- It then hard-deletes the client row, allowing DB cascades to remove appointments and image metadata.
- Storage cleanup before hard delete should be treated as a release blocker.
- A weekly orphan cleanup job is still useful as a backstop for partial failures.
- Mobile should clear cached images for purged client/appointment records after sync.

User/account deleted:

- Add a future internal cleanup process that removes `users/{user_id}/` Storage prefix.
- Supabase Auth user deletion cascades DB records but not Storage.
- Mobile should clear all image cache for the account.

Upload succeeds but DB insert fails:

- Finalize endpoint should catch insert failure and attempt Storage cleanup for both paths.
- Return a clear retry/error response.
- If cleanup also fails, log enough structured metadata for orphan cleanup.
- Mobile should not mark the image as complete and should remove temporary local upload state unless the user chooses retry.

DB row exists but storage object missing:

- List endpoint can still return metadata but signed URL generation may fail.
- Prefer returning the image row with `thumbnail_url: null` and an internal warning, or omit broken images after logging.
- Mobile can use a fresh cached copy if available, but should treat Storage/DB inconsistency as a sync issue and retry later.
- Add repair/admin cleanup later.

Storage object exists but DB row missing:

- Weekly orphan cleanup job should list bucket prefixes and compare object paths against `appointment_images.storage_path` and `thumbnail_path`.
- Only delete objects under the controlled `users/{user_id}/clients/.../appointments/...` pattern.
- Use an age threshold, such as older than 24 hours, to avoid deleting in-progress uploads.

Local cache file exists but DB row is gone:

- On metadata refresh, remove cached files whose `image_id` is no longer present for the relevant appointment/client/user.
- Periodic cache reconciliation should remove unreferenced cache entries.

Cleanup job recommendation:

- Add an internal route/script later, protected by `INTERNAL_API_SECRET`.
- Weekly cadence is enough for MVP.
- Report:
  - orphan objects found
  - bytes reclaimed
  - failed deletes
  - suspicious paths skipped

## Cost Controls

MVP controls:

- Do not store originals.
- Compress before upload.
- Store thumbnails.
- Load thumbnails in appointment detail.
- Lazy-load display image only in viewer.
- Cache thumbnails locally after first fetch to reduce repeated egress.
- Cache display-size images locally after first full-screen view to reduce repeated egress.
- Prefetch only thumbnails for today's/upcoming appointments, not display-size images.
- Use a bounded batch prefetch endpoint to avoid N+1 image-list calls.
- Max 10 images per appointment.
- Max upload input size 5 MB before compression.
- Target display image under 1 MB.
- Target thumbnail 100 to 150 KB.
- Track stored display and thumbnail byte sizes.
- Avoid runtime transformations.
- Avoid showing images in high-level lists unless using one small thumbnail.
- Add logging/monitoring around per-user total bytes.

Important cost framing:

- Storage cost grows with total stored data, not a fixed monthly amount per feature.
- If compressed display images average around 500 KB plus a small thumbnail, usage should remain manageable.
- Raw 5 to 8 MB phone photos are the major avoidable storage risk.
- Egress can matter more than storage if stylists constantly view full-size images, so thumbnail-first loading and local caching are important.
- Local cache improves performance and reduces egress, but it does not replace Storage or DB retention controls.

Plan limits:

- Do not enforce complex tier limits in MVP unless product decides appointment images are plan-gated.
- Current plan system supports feature flags but has no storage quota model.
- Future limits can use `user_storage_usage`:
  - Basic: lower total storage and/or image cap
  - Pro: higher cap
  - Premium: highest cap

Where to enforce:

- Max images per appointment: backend upload-intent and finalize endpoints.
- Max input size: frontend before processing and backend declared validation.
- Max stored display/thumb size: frontend checks after compression; backend validates finalize metadata and optionally Storage object metadata.
- MIME types: frontend picker/manipulator and backend validators.
- Local cache size: mobile app image-cache layer with 500 MB limit and LRU eviction.
- Pending upload expiration: backend cleanup of expired `pending` rows and associated Storage objects.

## Phased Rollout

Phase 0: discovery and plan only

- This task.
- No code, migration, database, API, or frontend changes.

Phase 1: database and storage foundation

- Create private `appointment-images` bucket.
- Create `appointment_images` table.
- Add indexes, constraints, RLS policies.
- Add required `cache_version`.
- Add pending upload fields: `upload_status`, `upload_expires_at`, and `finalized_at`.
- Add image metadata fields: `image_source`, `captured_at`, `label`, `tags`, `uploaded_by_user_id`, and public upload token reference if used.
- Add client retention field such as `clients.purge_after`.
- Add `user_storage_usage` view if desired.
- Add seed/test schema support.
- No visible UI changes.

Phase 2: backend APIs

- Add validators/controller/service/routes.
- List image metadata.
- Generate upload intents and signed upload URLs.
- Create pending rows during upload intent.
- Finalize metadata rows.
- Require Storage object verification before finalization.
- Generate signed thumbnail/display URLs.
- Include `image_id`, `updated_at`, and `cache_version` in API responses.
- Add bounded thumbnail prefetch endpoint for today/upcoming appointments.
- Patch caption/role/sort.
- Delete DB rows and Storage objects.
- Enforce count, MIME, and size limits.
- Change client deletion flow to soft delete with 30-day retention and add reactivation/purge service paths.
- Add purge flow that removes appointment image Storage objects before hard-deleting clients whose retention has expired.
- Add public reference-photo upload-intent and finalize routes with one client-sourced reference image per appointment.
- Add tests for ownership, limits, validation, and cleanup behavior.

Phase 3: mobile UI

- Add appointment Photos section.
- Add picker/compression/thumbnail generation.
- Upload display and thumbnail.
- Show thumbnail carousel/grid.
- Fullscreen viewer with signed display URL.
- Delete image.
- Show source/date/role/label metadata in appointment image UI where appropriate.
- Loading/error/retry states.

Phase 3b: public booking reference photo UI

- Add optional one-photo reference upload after public booking confirmation.
- Compress and thumbnail before upload.
- Use short-lived reference-photo upload token.
- Show received/retry state.
- Do not show stylist-created images in public booking UI.

Phase 4: local caching and offline-read support

- Add image cache utility.
- Cache thumbnails after first fetch.
- Cache display-size images after first full-screen view.
- Prefetch thumbnails for today's and upcoming appointments.
- Use cached files when offline or signed URLs are unavailable.
- Enforce 500 MB cache limit.
- Add LRU eviction.
- Clear cached files on image delete/logout/account switch.
- Use `image_id` plus required `cache_version` for staleness.
- Store cache files in account-scoped app-private storage and exclude from backup where possible.

Phase 5: cleanup and monitoring

- Orphan cleanup script/internal job.
- Expired pending upload cleanup.
- Expired soft-deleted client purge job.
- Storage usage reporting.
- Local cache diagnostics if needed.
- Logging for failed deletes and signed URL failures.
- Optional usage view exposed through account/settings endpoint.

Phase 6: future enhancements

- Client-level gallery.
- Formula-specific image grouping.
- Before/after comparison view.
- Portfolio/public image pipeline with separate privacy rules.
- Captions, tags, and richer roles.
- Plan-based storage limits.
- AI-assisted notes later.

## Open Questions

- Is the mobile app Expo-based? This determines picker/compression/cache dependencies.
- Can the current mobile stack output WebP reliably, or should MVP store JPEG?
- Which local file cache mechanism is already used in the mobile app, if any?
- What upcoming-appointments window should thumbnail prefetch use: 7 days, 14 days, or a fixed appointment count?
- Should thumbnail prefetch run on cellular, or Wi-Fi only by default?
- Should appointment images be available on completed appointments only, or all statuses?
- Should images be visible from client detail as part of visual history in MVP, or only appointment detail?
- Should captions/roles ship in MVP UI or be backend-ready only?
- Should public booking reference-photo upload happen only on the confirmation screen, or also from appointment management links before the appointment?
- Should a client be allowed to replace/delete their reference photo while the token is valid, or only upload once?
- Should `captured_at` for client reference photos be appointment date or actual upload time?
- Should soft-deleted clients be hidden from public booking matching, automatically reactivated, or duplicated as new active clients?
- Should retention be exactly 30 days or configurable per environment/product tier?
- Is there an appointment delete endpoint planned soon? Cleanup design should be included with it.
- Should existing `photos` be deprecated, migrated later, or kept for future client-level gallery?

## Risks

- Orphaned Storage objects if DB cascades happen without service-layer cleanup.
- Orphaned Storage objects if pending uploads expire without cleanup.
- Mobile uploading raw images if compression is skipped or fails.
- Signed URL expiration causing broken thumbnails unless the UI refetches cleanly or uses cache fallback.
- RLS inconsistencies if direct Supabase frontend access is introduced later.
- Cost growth if thumbnails are not used and full images load frequently.
- WebP incompatibility depending on frontend stack/version.
- Existing `photos` API may confuse product/API semantics unless documented as legacy client-photo metadata.
- Local cache can retain sensitive client images on device; app-private storage and logout clearing should be treated as MVP privacy requirements.
- Cache staleness bugs could show old images unless `image_id` plus required `cache_version` is consistently used.
- Thumbnail prefetch could increase egress if the prefetch window is too broad or runs too often.
- Appointment thumbnail prefetch could create backend N+1 load unless implemented with a bounded batch endpoint.
- Soft-deleted clients can accidentally appear in normal lists/search/public matching unless every query path applies the intended filter.
- Public reference-photo uploads increase abuse risk because they are unauthenticated; token scope, count limits, file limits, and expiry need to be strict.
- Reactivation can restore appointment images only if purge has not run and Storage cleanup has not removed objects.

## Files Likely To Change

Backend:

- `src/routes/appointmentRoutes.ts`
- `src/controllers/appointmentImagesController.ts`
- `src/services/appointmentImagesService.ts`
- `src/services/clientRetentionService.ts` or updates to `src/services/clientsService.ts`
- `src/validators/appointmentImageValidators.ts`
- `src/validators/publicBookingValidators.ts`
- `src/controllers/publicController.ts`
- `src/services/publicBookingsService.ts`
- `src/lib/supabase.ts` if storage helpers are centralized
- `src/types/api.ts`
- `src/__tests__/apiRoutes.test.ts` or new appointment image tests
- `src/__tests__/helpers/mockSupabase.ts`
- `supabase/migrations/<new>_appointment_images.sql`
- `supabase/schema.sql`
- README/API docs after implementation

Frontend, in the mobile repo:

- Appointment detail screen.
- Public booking confirmation screen.
- API client/types.
- New appointment image section/grid/uploader/viewer components.
- Public reference-photo uploader component.
- Image picker/compression utilities.
- Image cache utility/service.
- Local cache index persistence.
- Appointment thumbnail prefetch scheduler.
- Cache cleanup hooks for delete/logout/account switch.
- Cache/query invalidation around appointment image list.

## Acceptance Criteria

- A stylist can attach up to 10 private images to an owned appointment.
- Supabase Storage remains the source of truth.
- The backend never trusts frontend `user_id`, `client_id`, or arbitrary storage paths.
- Images are stored in a private Supabase bucket.
- Appointment detail initially loads thumbnails only.
- Full display image is loaded only when viewing an image.
- DB rows track display size, thumbnail size, dimensions, role, caption, bucket, paths, `updated_at`, and required `cache_version`.
- DB rows include required `cache_version` and pending upload lifecycle fields.
- DB rows distinguish `image_source = 'stylist'` from `image_source = 'client'`.
- DB rows capture basic metadata: role/category, source, date via `captured_at`, optional label, and optional tags.
- Upload intent creates a pending row and max image enforcement counts non-expired pending plus ready images.
- Finalize verifies display and thumbnail objects exist in Storage and match expected MIME/size limits.
- RLS policies restrict rows to `auth.uid() = user_id`.
- Delete removes both DB metadata and Storage objects.
- Delete also clears local cached thumbnail/display files for the image.
- Failed finalize attempts try to clean up uploaded objects.
- Client delete soft-deletes clients for a 30-day retention period, supports reactivation, and purges Storage/DB only after retention expires.
- Purge removes related appointment image Storage objects before hard-deleting the client row.
- Public booking allows one optional client-sourced reference photo per appointment.
- Client reference photos are saved to the appointment/client and marked as `image_source = 'client'` and `image_role = 'reference'`.
- Public booking image routes never expose stylist-created appointment images.
- Storage usage can be calculated by `user_id`.
- Public booking pages do not expose appointment galleries, stylist-created images, or client history.
- No raw/original full-resolution images are stored for MVP.
- Thumbnails are cached locally after first fetch.
- Display-size images are cached locally after first full-screen view.
- Thumbnails for today's and upcoming appointments are prefetched within a bounded window.
- Cached thumbnails/images are used when offline or when signed URLs are unavailable.
- The app does not store completed image records only locally.
- Local image cache has a 500 MB MVP limit.
- Least-recently-used cached images are evicted when over the cache limit.
- Cache freshness is determined by `image_id` plus required `cache_version`.
- Cached images are stored in account-scoped app-private storage, excluded from backup where possible, and cleared on logout/account switch.

## Suggested Implementation Order

This work should be delivered in small reviewable chunks. Each chunk should be independently understandable, with tests or verification before moving on.

### Chunk 1: Client Soft Delete Foundation

Goal: Make client deletion reversible before image storage depends on client lifecycle.

Steps:

1. Add `clients.purge_after`.
2. Change `clientsService.remove()` from hard delete to soft delete.
3. Ensure normal client list/detail/search flows exclude soft-deleted clients by default.
4. Add a reactivation service/API path.
5. Add tests for soft delete, hidden deleted clients, and reactivation.

Stop when:

- Deleting a client no longer removes the row immediately.
- The client can be restored within the retention window.
- Existing active-client flows do not show deleted clients accidentally.

### Chunk 2: Client Purge Job

Goal: Hard-delete retained clients only after the retention period expires.

Steps:

1. Add an internal purge service that finds `clients.purge_after <= now()`.
2. For now, purge non-image client data safely.
3. Add the internal route/script protected by `INTERNAL_API_SECRET`.
4. Add tests for purge eligibility and non-eligible clients.

Stop when:

- Soft-deleted clients remain available until `purge_after`.
- Expired clients can be hard-deleted by an explicit internal process.

### Chunk 3: Appointment Images Schema And Bucket

Goal: Add the database/storage foundation without exposing UI.

Steps:

1. Create the private `appointment-images` bucket.
2. Add `appointment_images` table.
3. Add lifecycle fields: `upload_status`, `upload_expires_at`, `finalized_at`.
4. Add cache fields: required `cache_version`.
5. Add metadata fields: `image_source`, `captured_at`, `label`, `tags`, `uploaded_by_user_id`, public upload token reference if used.
6. Add constraints, indexes, and RLS policies.
7. Add `user_storage_usage` view if useful now.

Stop when:

- Schema supports stylist images, client reference images, pending uploads, and cache freshness.
- No app behavior has changed yet.

### Chunk 4: Backend Storage Helpers

Goal: Centralize safe Supabase Storage operations before adding endpoints.

Steps:

1. Add helper functions for path generation.
2. Add helper functions for signed upload/read URLs.
3. Add helper functions for object existence/metadata verification.
4. Add helper functions for deleting display and thumbnail objects.
5. Add tests with mocked Supabase Storage behavior.

Stop when:

- Storage path generation is server-owned.
- Verification and cleanup behavior can be reused by private and public upload flows.

### Chunk 5: Private Stylist Image Upload API

Goal: Let authenticated stylists upload appointment images safely.

Steps:

1. Add authenticated appointment image routes, controller, service, and validators.
2. Implement `upload-intent` that creates a pending row.
3. Implement finalize that verifies Storage objects and marks the row `ready`.
4. Implement list with signed thumbnail URLs.
5. Implement display URL endpoint.
6. Implement patch metadata.
7. Implement delete with Storage cleanup.
8. Add tests for ownership, max count, MIME limits, pending expiration, finalize verification, and delete cleanup.

Stop when:

- API can support stylist-uploaded appointment images end to end.
- No mobile UI is required yet.

### Chunk 6: Image Cleanup Backstops

Goal: Prevent Storage drift before broad UI usage.

Steps:

1. Add expired pending upload cleanup.
2. Extend client purge to delete appointment image Storage objects before hard delete.
3. Add orphan cleanup/reporting for Storage objects without DB rows.
4. Add logging for failed Storage deletes and signed URL failures.

Stop when:

- Client purge and failed uploads do not leave predictable Storage orphans.
- Weekly/manual cleanup can recover from partial failures.

### Chunk 7: Private Mobile Appointment Images UI

Goal: Add the stylist-facing appointment image experience.

Steps:

1. Add appointment images section to appointment detail.
2. Fetch image metadata and thumbnails.
3. Add picker, compression, display image generation, and thumbnail generation.
4. Upload through the private upload-intent/finalize flow.
5. Add full-screen viewer using display signed URLs.
6. Add delete and metadata display for role/source/date/label.
7. Add loading, progress, failure, retry, and empty states.

Stop when:

- Stylists can add, view, and delete private appointment images.
- Full-size images are only loaded on demand.

### Chunk 8: Local Image Cache

Goal: Improve performance and offline-read behavior after the basic UI works.

Steps:

1. Add account-scoped app-private cache directory/index.
2. Cache thumbnails after first fetch.
3. Cache display images after first full-screen view.
4. Use `image_id + cache_version` for freshness.
5. Add 500 MB LRU eviction.
6. Clear cached files on image delete, logout, and account switch.
7. Exclude cached files from backup where supported.

Stop when:

- Previously loaded images can render from cache offline.
- Cache does not grow unbounded.
- Cache privacy behavior is explicit.

### Chunk 9: Batched Thumbnail Prefetch

Goal: Add upcoming-appointment thumbnail prefetch without creating N+1 load.

Steps:

1. Add bounded backend prefetch endpoint.
2. Return only ready image metadata and signed thumbnail URLs.
3. Add mobile prefetch for today and upcoming appointments.
4. Throttle by date window, count, network type, and app lifecycle.
5. Verify no display-size images are prefetched.

Stop when:

- Today's/upcoming appointment thumbnails feel fast.
- Prefetch remains bounded and does not overload backend or egress.

### Chunk 10: Public Booking Reference Photo API

Goal: Allow one client-sourced reference photo per booked appointment.

Steps:

1. Decide token shape and expiration.
2. Return a reference-photo upload token from public booking confirmation.
3. Add public reference upload-intent route.
4. Add public reference finalize route.
5. Enforce one client-sourced reference photo per appointment.
6. Store `image_source = 'client'`, `image_role = 'reference'`, and basic metadata.
7. Ensure public routes never list or return stylist-created images.
8. Add abuse/limit tests.

Stop when:

- A booked client can upload exactly one private reference photo.
- The stylist can later see it as client-submitted reference material.

### Chunk 11: Public Booking Reference Photo UI

Goal: Add the client-facing reference upload experience.

Steps:

1. Add optional reference upload to the public booking confirmation flow.
2. Compress and thumbnail before upload.
3. Show upload progress, success, failure, and retry.
4. Make it clear the image is private appointment context.
5. Do not show appointment galleries or stylist-created images publicly.

Stop when:

- Clients can submit a reference photo during booking.
- The photo appears in the stylist appointment image section as client-sourced.

### Chunk 12: Final Hardening And Product Review

Goal: Review the feature as a whole before broad release.

Steps:

1. Verify storage usage calculations.
2. Verify deletion, purge, orphan cleanup, and cache cleanup paths.
3. Review signed URL TTLs and public token expiry.
4. Review UI copy and privacy expectations.
5. Load-test prefetch/list behavior at realistic appointment counts.
6. Confirm product decisions around labels, tags, reference replacement, and soft-deleted public booking matching.

Stop when:

- The feature is safe to release beyond internal/beta users.
