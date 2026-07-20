# Runtime Insights Snapshot Configuration

`public.insight_snapshot_configurations` controls the active Business Snapshot
page and metric assignment at runtime. It is intentionally SQL/admin-managed in
this phase; no mobile or backend deployment is required to rearrange, enable,
or disable supported metrics.

The database configuration does **not** contain formulas, SQL fragments, or
metric labels beyond page presentation. Every `metric_id` is validated against
the code-owned catalog in
[`insightsSnapshotService.ts`](../src/services/insightsSnapshotService.ts).
An unknown metric, unsupported layout, malformed page, disabled configuration,
or failed configuration read falls back safely to the checked-in default.

## Table fields

| Field | Purpose |
| --- | --- |
| `configuration_version` | Positive, operator-managed version for audit and rollout tracking. |
| `is_active` | Exactly one configuration may be active globally. |
| `enabled` | Turns an active configuration on/off without deleting it. Disabled falls back to the code default. |
| `pages` | Ordered JSON page and metric assignments. |
| `target_plan_tiers` | Optional `basic`, `pro`, and/or `premium` targeting. `null` targets all plans. |
| `rollout_percentage` | Deterministic account rollout from `0` to `100`. |
| `updated_by` | Required editor/audit identifier, such as an admin email or change ticket. |
| `updated_at` | Automatically maintained by a database trigger. |

Each page can also use `enabled: false`, and each individual metric assignment
can use `enabled: false`. Assignment order is display order.

## Allowed configuration shape

```json
[
  {
    "id": "business_performance",
    "title": "Business Performance",
    "layout": "grid_2x2",
    "period_behavior": "selected_period",
    "enabled": true,
    "required_feature": "optional_server_feature_key",
    "metrics": [
      { "metric_id": "booked_revenue", "enabled": true },
      { "metric_id": "appointments_booked", "enabled": true },
      { "metric_id": "rebooking_rate", "enabled": true },
      { "metric_id": "average_ticket", "enabled": true }
    ]
  }
]
```

Allowed layouts: `grid_2x2`, `list`.

Currently registered metric IDs: `booked_revenue`, `appointments_booked`,
`rebooking_rate`, and `average_ticket`. Adding a new metric ID still requires a
backend deployment because its calculation must be implemented and tested in
the catalog first.

## Publishing a configuration

Prefer immutable versions: insert a new row, then deactivate the former active
row in the same transaction. This preserves audit history and prevents the
unique active-config index from allowing two live configurations.

```sql
begin;

update public.insight_snapshot_configurations
set is_active = false,
    updated_by = 'admin@example.com'
where is_active = true;

insert into public.insight_snapshot_configurations (
  configuration_version,
  is_active,
  enabled,
  pages,
  target_plan_tiers,
  rollout_percentage,
  updated_by
)
values (
  2,
  true,
  true,
  '[
    {
      "id": "business_performance",
      "title": "Business Performance",
      "layout": "grid_2x2",
      "period_behavior": "selected_period",
      "enabled": true,
      "metrics": [
        { "metric_id": "appointments_booked", "enabled": true },
        { "metric_id": "booked_revenue", "enabled": true },
        { "metric_id": "average_ticket", "enabled": true }
      ]
    }
  ]'::jsonb,
  array['pro', 'premium'],
  25,
  'admin@example.com'
);

commit;
```

The 25% rollout is deterministic per account/configuration pair. A targeted or
not-yet-enrolled account safely receives the version-controlled default instead.
No arbitrary expression in `pages` is executed by the API.

## Runtime behavior

`insightsSnapshotConfigurationService.resolveForUser()` reads and validates the
active row for the authenticated account context. Its `buildPagesForUser()`
helper feeds the resolved page configuration into the existing code-owned
metric builders. The future `GET /api/insights` endpoint should call that
helper; Profile Overview intentionally continues to use its fixed legacy
presentation.
