# Appointment Images Release Review

This is the Chunk 12 backend/product review for appointment images before release beyond internal or beta users.

## Backend Release Status

Ready for beta release from the backend side, subject to frontend QA on device/web flows and final product copy approval.

Implemented backend surfaces:

- Authenticated appointment image list/upload/finalize/display-url/update/reorder/delete.
- Authenticated upcoming thumbnail prefetch.
- Authenticated client visual history.
- Public booking reference photo upload token, upload intent, and finalize.
- Expired pending upload cleanup.
- Orphan Storage cleanup/reporting.
- Client purge Storage cleanup before hard delete.
- Storage usage view.

## Storage Usage

Storage usage is calculated from ready `appointment_images` rows in the `public.user_storage_usage` view:

- `appointment_image_count`: count of rows where `upload_status = 'ready'`.
- `appointment_image_bytes`: `file_size_bytes + thumbnail_size_bytes` for ready rows.

Important limits:

- Display image max: 2 MB.
- Thumbnail max: 300 KB.
- Display dimensions max: 1600 px longest edge.
- Thumbnail dimensions max: 400 px longest edge.
- Private stylist appointment image active limit: 10 ready or unexpired pending images per appointment.
- Public client reference image active limit: 1 ready or unexpired pending reference image per appointment.

Review result:

- Usage excludes pending, failed, and expired rows, which is the right behavior for billable/visible usage.
- Usage depends on finalize metadata matching Storage object metadata. Finalize verifies content type and byte sizes before a row becomes ready.
- Current view does not include orphaned Storage objects because they have no DB row. Orphan cleanup remains the recovery path for drift.

## Deletion And Cleanup

Deletion paths:

- Private image delete deletes Storage objects first, then deletes the DB row.
- If Storage delete fails, the DB row remains so the user does not lose the ability to retry cleanup.
- Client hard purge deletes appointment image Storage objects before deleting the client.
- If client image Storage cleanup fails, client purge skips hard delete.
- Expired pending cleanup deletes Storage objects before marking rows expired.
- Orphan cleanup scans Storage under `users/`, compares object paths with `appointment_images.storage_path` and `thumbnail_path`, and defaults to dry run.

Review result:

- Normal delete, failed finalize cleanup, expired pending cleanup, orphan cleanup, and client purge cleanup all have automated tests.
- Frontend cache cleanup remains a frontend responsibility: delete success, logout, account switch, and LRU eviction should clear app-private cached files.

## Signed URLs And Tokens

Signed URL durations:

- Thumbnail read URL: 300 seconds.
- Display read URL: 300 seconds.
- Upload intent lifetime: 15 minutes.

Public reference photo token:

- Returned from `POST /api/public/bookings`.
- Scoped to appointment ID, client ID, stylist ID, and appointment start time.
- Expires at appointment start time.
- Rejected if the appointment start time no longer matches, which invalidates old tokens after reschedule.
- Rejected when the appointment is cancelled.
- Does not authorize public listing or reading appointment images.

Review result:

- Signed read URLs are short-lived and should not be persisted by frontend clients.
- Public upload token is appropriately narrow for a confirmation-screen reference photo upload.
- If product wants upload-token recovery after page refresh, that should be a separate token recovery/design chunk.

## Prefetch And List Behavior

Bounded endpoints:

- `GET /api/appointments/images/thumbnail-prefetch`
  - Appointment cap: 1-100.
  - Per-appointment image cap: 1-10.
  - Total image return cap: 1-100.
  - Only signs thumbnail URLs.

- `GET /api/clients/:id/visual-history`
  - Limit cap: 1-100.
  - Signs thumbnail URLs by default.
  - Signs display URLs only when `include_display_urls=true`.

Review result:

- Thumbnail prefetch is safe for today/upcoming cache warming and does not sign display-size URLs.
- Appointment image list, thumbnail prefetch, and visual history responses omit raw Storage paths.
- Client visual history is thumbnail-first by default; the frontend should use the on-demand display URL endpoint when opening an image.
- A regression test covers 100 appointments with 10 images each and verifies only the requested total thumbnail URLs are signed.
- Frontend should throttle prefetch by date window, app lifecycle, network type, and cache misses.

## Privacy And Product Copy

Required frontend/user-facing expectations:

- Public reference upload copy should say the image is private appointment context shared with the stylist.
- Public pages must not show appointment galleries or stylist-created private images.
- Signed URLs and public upload tokens must not be sent to analytics or logs.
- Raw Storage paths must not be visible in UI.
- Appointment detail should distinguish client-sourced reference photos from stylist photos.

Review result:

- Backend enforces public write-only reference upload behavior.
- Backend does not expose public image list/read routes.
- Final product copy still needs frontend/product approval.

## Product Decisions Confirmed For Release

Current release decisions:

- Stylist-added appointment photos default to `image_role = 'general'`.
- Client-submitted booking photos use `image_source = 'client'` and `image_role = 'reference'`.
- Public reference replacement is not supported in this release.
- Public reference upload is optional and limited to one active reference image per appointment.
- Labels/tags/captions remain optional metadata. Public reference photo supports optional `caption`; labels and tags stay stylist/private metadata.
- Existing public booking idempotency remains intact; repeated confirmations may return a fresh reference upload token for the same appointment.

Product follow-ups to explicitly confirm before broad release:

- Whether public reference photo replacement should exist after a failed or successful upload.
- Whether clients should recover a reference upload token after refreshing the confirmation page.
- Whether client visual history should show display images immediately or defer display URL fetches to image open.
- Whether soft-deleted client matching behavior should block, allow, or reactivate clients during public booking. Current booking logic follows existing client matching behavior and does not add image-specific soft-delete rules.

## Release Checklist

- Run `npm run typecheck`.
- Run `npm test`.
- Run Supabase SQL verification from `docs/supabase/appointment-images-chunk3-03-verify.sql` against the target environment.
- Smoke test private upload intent, signed Storage upload, finalize, display URL, and delete.
- Smoke test public booking confirmation token, public reference upload intent, signed Storage upload, and finalize.
- Run internal appointment image cleanup in dry-run mode and review orphan output before enabling deletes.
- QA frontend offline cache behavior on a real device or simulator.
- QA public booking reference upload copy and failure states.
