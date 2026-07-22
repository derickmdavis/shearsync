import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

process.env.NODE_ENV = "test";
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key";

const { installMockSupabase } = require("./helpers/mockSupabase") as typeof import("./helpers/mockSupabase");
const { entitlementsService } = require("../services/entitlementsService") as typeof import("../services/entitlementsService");
const { insightsService } = require("../services/insightsService") as typeof import("../services/insightsService");
const { referralLinksService } = require("../services/referralLinksService") as typeof import("../services/referralLinksService");
const { referralProgramStatusService } =
  require("../services/referralProgramStatusService") as typeof import("../services/referralProgramStatusService");

const userId = "11111111-1111-4111-8111-111111111111";
const now = new Date("2026-07-21T18:00:00.000Z");

const getInsights = () => insightsService.getForUser(userId, {
  business_snapshot_period: "week",
  referral_period: "this_month"
}, now);

const installState = (options: {
  tier?: "basic" | "pro" | "premium";
  program?: Record<string, unknown>;
  clients?: Array<Record<string, unknown>>;
  appointments?: Array<Record<string, unknown>>;
}) => installMockSupabase({
  users: [{
    id: userId,
    timezone: "America/Denver",
    plan_tier: options.tier ?? "pro",
    plan_status: "active"
  }],
  referral_programs: options.program ? [options.program] : [],
  automation_settings: [],
  campaigns: [],
  clients: options.clients ?? [],
  appointments: options.appointments ?? [],
  client_referral_links: [],
  referral_events: [],
  activity_events: []
});

describe("Referral Insights state matrix", () => {
  it("keeps metrics calculated for accounts without referral entitlement", async () => {
    const supabase = installState({ tier: "basic" });
    try {
      const [plan, program, insights] = await Promise.all([
        entitlementsService.getEntitlementsForUser(userId),
        referralProgramStatusService.getForUser(userId),
        getInsights()
      ]);

      assert.equal(plan.features.referrals, false);
      assert.equal(program.active, false);
      assert.equal(insights.referrals.available, true);
    } finally {
      supabase.restore();
    }
  });

  it("reports setup-required state for an entitled account without program setup", async () => {
    const supabase = installState({});
    try {
      const [program, insights] = await Promise.all([referralProgramStatusService.getForUser(userId), getInsights()]);

      assert.equal(program.configured, false);
      assert.equal(program.active, false);
      assert.equal(insights.referrals.available, true);
    } finally {
      supabase.restore();
    }
  });

  it("returns available zero-valued current metrics for an active program with no conversions", async () => {
    const supabase = installState({
      program: {
        user_id: userId,
        enabled: true,
        offer_name: "$20 off a first visit",
        offer_description: "Share your link with a friend."
      }
    });
    try {
      const [program, insights] = await Promise.all([referralProgramStatusService.getForUser(userId), getInsights()]);
      assert.equal(program.configured, true);
      assert.equal(program.active, true);
      assert.equal(insights.referrals.available, true);
      if (!insights.referrals.available) throw new Error("Expected available referrals");

      assert.equal(insights.referrals.has_successful_conversions, false);
      assert.deepEqual(insights.referrals.metrics.map((metric) => metric.display_value), ["0", "0", "0%"]);
      assert.deepEqual(insights.referrals.metrics.map((metric) => metric.icon_key), [
        "referral_clients", "referral_appointments", "referral_conversion"
      ]);
    } finally {
      supabase.restore();
    }
  });

  it("retains historical conversion state when the selected period has no results", async () => {
    const supabase = installState({
      program: {
        user_id: userId,
        enabled: true,
        offer_name: "$20 off a first visit",
        offer_description: "Share your link with a friend."
      },
      clients: [{
        id: "40000000-0000-4000-8000-000000000010",
        user_id: userId,
        original_referral_attributed_at: "2026-06-10T12:00:00.000Z"
      }],
      appointments: [{
        id: "50000000-0000-4000-8000-000000000010",
        user_id: userId,
        referral_attributed_at: "2026-06-11T12:00:00.000Z",
        status: "completed"
      }]
    });
    try {
      const insights = await getInsights();
      assert.equal(insights.referrals.available, true);
      if (!insights.referrals.available) throw new Error("Expected available referrals");

      assert.deepEqual(insights.referrals.metrics.map((metric) => metric.display_value), ["0", "0", "0%"]);
      assert.equal(insights.referrals.has_successful_conversions, true);
    } finally {
      supabase.restore();
    }
  });

  it("uses unavailable only for a referral metrics calculation failure", async () => {
    const supabase = installState({});
    const getStatsMock = mock.method(referralLinksService, "getInsightsReferralStats", async () => {
      throw new Error("database unavailable");
    });

    try {
      const insights = await getInsights();
      assert.deepEqual(insights.referrals, {
        available: false,
        reason: "temporarily_unavailable",
        message: "Referral insights are temporarily unavailable.",
        retry_after_seconds: 30
      });
    } finally {
      getStatsMock.mock.restore();
      supabase.restore();
    }
  });

  it("uses unavailable when the referral Insights section is explicitly disabled", async () => {
    const supabase = installState({});
    const previousEnabledSections = process.env.INSIGHTS_ENABLED_SECTIONS;
    process.env.INSIGHTS_ENABLED_SECTIONS = "business_snapshot,campaigns,appointment_changes";

    try {
      const insights = await getInsights();
      assert.deepEqual(insights.referrals, {
        available: false,
        reason: "feature_unavailable",
        message: "Referral insights are not enabled for this account."
      });
    } finally {
      if (previousEnabledSections === undefined) {
        delete process.env.INSIGHTS_ENABLED_SECTIONS;
      } else {
        process.env.INSIGHTS_ENABLED_SECTIONS = previousEnabledSections;
      }
      supabase.restore();
    }
  });
});
