# Application Content Operations Runbook

## Prerequisites

Apply these Supabase migrations in order before deploying the backend that
contains the app-content routes:

1. `202607220001_app_content_foundation.sql`
2. `202607220002_app_content_draft_audit.sql`
3. `202607220003_app_content_publication.sql`
4. `202607220004_app_content_publication_function_privileges.sql`

Run the matching files under `supabase/smoke/`. Supabase SQL Editor reporting
`Success. No rows returned` means a smoke script passed.

Before the first real `en-US` publication, also run
`20260722_app_content_publication_transaction_smoke.sql`. It verifies the
publish, stale-version rejection, invalid-draft atomicity, rollback, and
revision immutability paths in one transaction, then rolls every smoke row
back. It deliberately refuses to run after real content has been published.

`public.admin_users` controls content administration. The caller must have a
normal Supabase user session and an active admin row; see
`docs/internal-dashboard-runbook.md` for enablement SQL.

## Admin API workflow

All requests use a normal bearer token and the `/api/admin/app-content` path.

1. Create an approved semantic definition:

```json
POST /api/admin/app-content/definitions
{
  "key": "insights.screen.title",
  "namespace": "insights",
  "category": "screen",
  "description": "Primary title for the Insights screen.",
  "allowed_placeholders": [],
  "max_length": 80,
  "multiline_allowed": false,
  "fallback_required": true
}
```

2. Save a draft. A new draft uses `null`; subsequent writes use the returned
`draft_version`.

```json
PUT /api/admin/app-content/drafts/insights.screen.title
{
  "locale": "en-US",
  "value": "Insights",
  "expected_draft_version": null
}
```

3. Validate all active definitions:

```json
POST /api/admin/app-content/validate
{ "locale": "en-US" }
```

4. Publish the whole locale using the current `active_version` from the most
recent publication response or locale-state-aware operations workflow:

```json
POST /api/admin/app-content/publish
{ "locale": "en-US", "expected_active_version": 0 }
```

5. Inspect immutable revision and audit history through `/revisions` and
`/audit`. If necessary, roll back by creating a new revision:

```json
POST /api/admin/app-content/rollback
{
  "locale": "en-US",
  "revision_id": "<prior revision UUID>",
  "expected_active_version": 1
}
```

Do not update `app_content_*` rows directly for routine content changes. That
bypasses the API's validation and optimistic-concurrency contract.

## Client bundle behavior

`GET /api/app-content?locale=en-US` requires normal authentication and returns
only the active immutable revision. It sends an ETag and:

```text
Cache-Control: private, max-age=300, stale-while-revalidate=86400
```

Clients should retain their last-known-good bundle and use bundled fallback
copy if the endpoint returns an error or a requested key is absent. A valid
locale without its own active publication resolves to the active `en-US`
bundle and returns `fallback_applied: true`.

## Incident response

- Failed publish with `409`: reload the current revision/version and retry only
  after reviewing the newer publication.
- Failed publish with `422`: use `/validate`; every active definition needs a
  safe draft before a complete locale can publish.
- Bad published copy: use `/revisions` then `/rollback`; never mutate a
  historical revision.
- Bundle/database outage: clients continue with last-known-good or bundled
  fallback copy. Review `app_content_bundle_served`,
  `app_content_bundle_not_modified`, `app_content_publication_failed`, and
  `app_content_rollback_failed` structured logs.
