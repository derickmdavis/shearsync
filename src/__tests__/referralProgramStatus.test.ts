import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = process.env.AUTH_MODE ?? "production";
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key";

const { installMockSupabase } = require("./helpers/mockSupabase") as typeof import("./helpers/mockSupabase");
const { referralProgramStatusService } =
  require("../services/referralProgramStatusService") as typeof import("../services/referralProgramStatusService");

const userId = "11111111-1111-4111-8111-111111111111";

const program = (overrides: Record<string, unknown> = {}) => ({
  user_id: userId,
  enabled: false,
  offer_name: null,
  offer_description: null,
  created_at: "2026-07-21T00:00:00.000Z",
  updated_at: "2026-07-21T00:00:00.000Z",
  ...overrides
});

const getStatus = async (options: {
  program?: Record<string, unknown>;
  thankYouEnabled?: boolean;
  campaigns?: Array<Record<string, unknown>>;
  planTier?: "basic" | "pro" | "premium";
  planStatus?: "trialing" | "active" | "past_due" | "cancelled";
} = {}) => {
  const supabase = installMockSupabase({
    users: [{
      id: userId,
      plan_tier: options.planTier ?? "pro",
      plan_status: options.planStatus ?? "active"
    }],
    referral_programs: options.program ? [options.program] : [],
    automation_settings: options.thankYouEnabled === undefined
      ? []
      : [{ user_id: userId, key: "thank_you_emails", enabled: options.thankYouEnabled }],
    campaigns: options.campaigns ?? []
  });

  try {
    return await referralProgramStatusService.getForUser(userId);
  } finally {
    supabase.restore();
  }
};

describe("referral program status", () => {
  it("resolves an enabled configured program without other entry points", async () => {
    const status = await getStatus({
      program: program({
        enabled: true,
        offer_name: "$20 off a first visit",
        offer_description: "Share your link with a friend."
      })
    });

    assert.deepEqual(status, {
      configured: true,
      active: true,
      program_enabled: true,
      offer_configured: true,
      thank_you_referral_enabled: false,
      active_campaign_count: 0,
      setup_state: {
        icon_key: "referral_program",
        title: "Turn happy clients into new bookings",
        body: "Create a referral offer and share your personal links to start earning more clients.",
        cta_label: "Start referral program",
        accessibility_label: "Set up your referral program"
      }
    });
  });

  it("resolves thank-you-email automation as a live referral entry point", async () => {
    const status = await getStatus({ thankYouEnabled: true });

    assert.equal(status.configured, false);
    assert.equal(status.active, true);
    assert.equal(status.thank_you_referral_enabled, true);
    assert.equal(status.active_campaign_count, 0);
  });

  it("counts only scheduled and sending referral-link campaigns as active", async () => {
    const status = await getStatus({
      campaigns: [
        { id: "scheduled-referral", user_id: userId, link_type: "referral_link", status: "scheduled" },
        { id: "sending-referral", user_id: userId, link_type: "referral_link", status: "sending" },
        { id: "completed-referral", user_id: userId, link_type: "referral_link", status: "completed" },
        { id: "scheduled-booking", user_id: userId, link_type: "booking_link", status: "scheduled" },
        { id: "draft-referral", user_id: userId, link_type: "referral_link", status: "draft" }
      ]
    });

    assert.equal(status.configured, false);
    assert.equal(status.active, true);
    assert.equal(status.active_campaign_count, 2);
  });

  it("returns an inactive state when no program or referral entry point is enabled", async () => {
    const status = await getStatus({
      program: program({
        enabled: false,
        offer_name: "$20 off a first visit",
        offer_description: "Share your link with a friend."
      })
    });

    assert.equal(status.configured, true);
    assert.equal(status.active, false);
    assert.equal(status.program_enabled, false);
  });

  it("does not report a referral program active for a disabled entitlement", async () => {
    const status = await getStatus({
      planTier: "basic",
      program: program({
        enabled: true,
        offer_name: "$20 off a first visit",
        offer_description: "Share your link with a friend."
      }),
      thankYouEnabled: true,
      campaigns: [{ id: "sending-referral", user_id: userId, link_type: "referral_link", status: "sending" }]
    });

    assert.equal(status.configured, true);
    assert.equal(status.program_enabled, true);
    assert.equal(status.thank_you_referral_enabled, false);
    assert.equal(status.active_campaign_count, 1);
    assert.equal(status.active, false);
  });
});
