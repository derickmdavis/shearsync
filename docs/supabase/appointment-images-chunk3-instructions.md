# Appointment Images Chunk 3 Supabase Instructions

These scripts are for manual execution in the Supabase dashboard SQL editor. They are intentionally stored under `docs/supabase/` instead of `supabase/migrations/` so you can apply them yourself.

## Scripts

Run in this order:

1. `docs/supabase/appointment-images-chunk3-01-storage.sql`
2. `docs/supabase/appointment-images-chunk3-02-schema.sql`
3. `docs/supabase/appointment-images-chunk3-03-verify.sql`

## Step 1: Create The Private Storage Bucket

Open Supabase Dashboard -> SQL Editor -> New query.

Paste and run:

```text
docs/supabase/appointment-images-chunk3-01-storage.sql
```

Expected result:

- A private Storage bucket named `appointment-images`.
- `file_size_limit` set to `2097152` bytes, which is 2 MB for display objects.
- Thumbnail objects are further limited by backend finalize validation and DB checks to `307200` bytes, which is 300 KB.
- Allowed MIME types: `image/jpeg`, `image/png`, `image/webp`.

Do not create broad `storage.objects` policies for this bucket right now. Later backend chunks will use service-role generated signed upload/read URLs so the backend keeps control of paths and metadata.

## Step 2: Create Metadata Table, RLS, Indexes, And Usage View

Open a second SQL editor query.

Paste and run:

```text
docs/supabase/appointment-images-chunk3-02-schema.sql
```

Expected result:

- New table: `public.appointment_images`.
- RLS enabled on `public.appointment_images`.
- Owner policies for select, insert, update, and delete.
- Required `cache_version` and upload lifecycle fields.
- `public.user_storage_usage` view for ready appointment image counts and bytes by user.

Important behavior:

- `ready` rows require `finalized_at`.
- `pending` rows require `upload_expires_at`.
- `cache_version` starts at `1` and should not change for metadata-only updates.
- `public_upload_token_id` is a nullable UUID without a foreign key for now because the token table does not exist yet.
- Far-future `captured_at` validation is intentionally left to backend validation. Time-dependent database check constraints become awkward as time passes.

## Step 3: Verify

Open a third SQL editor query.

Paste and run:

```text
docs/supabase/appointment-images-chunk3-03-verify.sql
```

Check for:

- One bucket row with `id = appointment-images` and `public = false`.
- `appointment_images` columns including `cache_version`, `upload_status`, `upload_expires_at`, and `finalized_at`.
- Indexes beginning with `appointment_images_`.
- Four policies:
  - `appointment_images_select_own`
  - `appointment_images_insert_own`
  - `appointment_images_update_own`
  - `appointment_images_delete_own`
- `rls_enabled = true`.
- A `user_storage_usage` view definition.

## After Running

Once the scripts are applied, tell me they’re live and I’ll update the local source-of-truth schema/migration files to match exactly, then continue with Chunk 4 storage helpers.

If a script fails, stop there and send me the exact Supabase error text before rerunning. The most likely repair path depends on whether anything was partially created.
