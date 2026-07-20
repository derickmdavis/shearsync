import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.NODE_ENV = "test";
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key";

const { installMockSupabase } = require("./helpers/mockSupabase") as typeof import("./helpers/mockSupabase");
const { insightsSnapshotConfigurationService } =
  require("../services/insightsSnapshotConfigurationService") as typeof import("../services/insightsSnapshotConfigurationService");

const configurationId = "20260720-0000-4000-8000-000000000001";
const updatedAt = "2026-07-20T18:42:00.000Z";

const activeConfiguration = (overrides: Record<string, unknown> = {}) => ({
  id: configurationId,
  configuration_version: 2,
  is_active: true,
  enabled: true,
  pages: [
    {
      id: "custom_performance",
      title: "Custom Performance",
      layout: "list",
      period_behavior: "selected_period",
      enabled: true,
      metrics: [
        { metric_id: "appointments_booked", enabled: true },
        { metric_id: "booked_revenue", enabled: true },
        { metric_id: "average_ticket", enabled: false }
      ]
    },
    {
      id: "disabled_page",
      title: "Disabled",
      layout: "grid_2x2",
      period_behavior: "selected_period",
      enabled: false,
      metrics: [{ metric_id: "rebooking_rate", enabled: true }]
    }
  ],
  target_plan_tiers: null,
  rollout_percentage: 100,
  updated_by: "admin@example.com",
  updated_at: updatedAt,
  ...overrides
});

describe("runtime Insights snapshot configuration", () => {
  it("uses an ordered, validated database configuration and honors page/metric enablement", async () => {
    const supabase = installMockSupabase({ insight_snapshot_configurations: [activeConfiguration()] });
    try {
      const result = await insightsSnapshotConfigurationService.resolveForUser({
        userId: "11111111-1111-1111-1111-111111111111",
        planTier: "pro"
      });

      assert.deepEqual(result, {
        source: "database",
        configurationVersion: 2,
        updatedAt,
        updatedBy: "admin@example.com",
        pages: [{
          id: "custom_performance",
          title: "Custom Performance",
          layout: "list",
          periodBehavior: "selected_period",
          requiredFeature: undefined,
          metricIds: ["appointments_booked", "booked_revenue"]
        }]
      });
    } finally {
      supabase.restore();
    }
  });

  it("falls back when the active configuration is malformed or disabled", async () => {
    const malformed = activeConfiguration({
      pages: [{
        id: "bad_page",
        title: "Bad Page",
        layout: "grid_2x2",
        period_behavior: "selected_period",
        enabled: true,
        metrics: [{ metric_id: "not_a_registered_metric", enabled: true }]
      }]
    });
    const supabase = installMockSupabase({ insight_snapshot_configurations: [malformed] });
    try {
      const result = await insightsSnapshotConfigurationService.resolveForUser({
        userId: "11111111-1111-1111-1111-111111111111"
      });
      assert.equal(result.source, "fallback");
      assert.equal(result.configurationVersion, null);
      assert.equal(result.pages[0].id, "business_performance");
    } finally {
      supabase.restore();
    }
  });

  it("falls back for accounts outside a plan target or rollout", async () => {
    const supabase = installMockSupabase({
      insight_snapshot_configurations: [activeConfiguration({ target_plan_tiers: ["premium"], rollout_percentage: 0 })]
    });
    try {
      const result = await insightsSnapshotConfigurationService.resolveForUser({
        userId: "11111111-1111-1111-1111-111111111111",
        planTier: "pro"
      });
      assert.equal(result.source, "fallback");
    } finally {
      supabase.restore();
    }
  });
});
