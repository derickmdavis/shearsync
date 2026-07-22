import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.NODE_ENV = "test";
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key";

const { installMockSupabase } = require("./helpers/mockSupabase") as typeof import("./helpers/mockSupabase");
const { referralLinksService } = require("../services/referralLinksService") as typeof import("../services/referralLinksService");
const { insightsReferralPresentationService } =
  require("../services/insightsReferralPresentationService") as typeof import("../services/insightsReferralPresentationService");

const userId = "11111111-1111-4111-8111-111111111111";
const now = new Date("2026-07-21T18:00:00.000Z");
const options = { range: "this_month" as const, timeZone: "America/Denver", now };

const getStats = () => referralLinksService.getInsightsReferralStats(userId, options);

describe("Referral Insights aggregation", () => {
  it("uses booked referral appointments divided by opens, with zero for no denominator", async () => {
    const supabase = installMockSupabase({
      client_referral_links: [],
      referral_events: [],
      clients: [],
      appointments: []
    });

    try {
      const aggregate = await getStats();
      assert.equal(aggregate.linksClicked, 0);
      assert.equal(aggregate.appointmentsBooked, 0);
      assert.equal(aggregate.conversionRatePercent, 0);
      assert.equal(insightsReferralPresentationService.build(aggregate).metrics[2].supporting_text, "No bookings yet");
    } finally {
      supabase.restore();
    }
  });

  it("calculates conversion from selected-period booked appointments divided by opens", async () => {
    const referrerId = "40000000-0000-4000-8000-000000000001";
    const supabase = installMockSupabase({
      client_referral_links: [],
      clients: [{ id: referrerId, user_id: userId, first_name: "Avery" }],
      referral_events: Array.from({ length: 4 }, (_, index) => ({
        id: `30000000-0000-4000-8000-0000000000${index + 1}`,
        user_id: userId,
        referred_by_client_id: referrerId,
        event_type: "opened",
        created_at: "2026-07-02T12:00:00.000Z"
      })),
      appointments: [
        { id: "50000000-0000-4000-8000-000000000001", user_id: userId, referred_by_client_id: referrerId, referral_attributed_at: "2026-07-03T12:00:00.000Z", status: "scheduled" },
        { id: "50000000-0000-4000-8000-000000000002", user_id: userId, referred_by_client_id: referrerId, referral_attributed_at: "2026-07-04T12:00:00.000Z", status: "completed" }
      ]
    });

    try {
      const aggregate = await getStats();
      assert.equal(aggregate.linksClicked, 4);
      assert.equal(aggregate.appointmentsBooked, 2);
      assert.equal(aggregate.conversionRatePercent, 50);
    } finally {
      supabase.restore();
    }
  });

  it("uses engagement evidence to produce a pre-conversion top referrer", async () => {
    const firstReferrerId = "40000000-0000-4000-8000-000000000001";
    const secondReferrerId = "40000000-0000-4000-8000-000000000002";
    const supabase = installMockSupabase({
      client_referral_links: [],
      clients: [
        { id: firstReferrerId, user_id: userId, first_name: "Avery" },
        { id: secondReferrerId, user_id: userId, first_name: "Bianca" }
      ],
      appointments: [],
      referral_events: [
        { id: "30000000-0000-4000-8000-000000000001", user_id: userId, referred_by_client_id: firstReferrerId, event_type: "opened", created_at: "2026-07-02T12:00:00.000Z" },
        { id: "30000000-0000-4000-8000-000000000002", user_id: userId, referred_by_client_id: firstReferrerId, event_type: "opened", created_at: "2026-07-03T12:00:00.000Z" },
        { id: "30000000-0000-4000-8000-000000000003", user_id: userId, referred_by_client_id: secondReferrerId, event_type: "opened", created_at: "2026-07-04T12:00:00.000Z" },
        { id: "30000000-0000-4000-8000-000000000004", user_id: userId, referred_by_client_id: secondReferrerId, event_type: "opened", created_at: "2026-07-05T12:00:00.000Z" },
        { id: "30000000-0000-4000-8000-000000000005", user_id: userId, referred_by_client_id: secondReferrerId, event_type: "link_clicked", created_at: "2026-07-06T12:00:00.000Z" }
      ]
    });

    try {
      const aggregate = await getStats();
      assert.deepEqual(aggregate.topReferrer, {
        clientId: secondReferrerId,
        displayName: "Bianca",
        successfulOutcomeCount: 0,
        engagementCount: 3
      });
      assert.equal(insightsReferralPresentationService.build(aggregate).top_referrer?.result_text, "3 clicks");
    } finally {
      supabase.restore();
    }
  });

  it("ranks successful outcomes before engagement", async () => {
    const engagementLeaderId = "40000000-0000-4000-8000-000000000001";
    const conversionLeaderId = "40000000-0000-4000-8000-000000000002";
    const tieBreakerId = "40000000-0000-4000-8000-000000000003";
    const supabase = installMockSupabase({
      client_referral_links: [],
      clients: [
        { id: engagementLeaderId, user_id: userId, first_name: "Avery" },
        { id: conversionLeaderId, user_id: userId, first_name: "Bianca" },
        { id: tieBreakerId, user_id: userId, first_name: "Cleo" },
        { id: "50000000-0000-4000-8000-000000000001", user_id: userId, original_referred_by_client_id: conversionLeaderId, original_referral_attributed_at: "2026-07-05T12:00:00.000Z" }
      ],
      appointments: [],
      referral_events: [
        ...Array.from({ length: 5 }, (_, index) => ({
          id: `30000000-0000-4000-8000-0000000000${index + 1}`,
          user_id: userId,
          referred_by_client_id: engagementLeaderId,
          event_type: "opened",
          created_at: "2026-07-02T12:00:00.000Z"
        })),
        { id: "30000000-0000-4000-8000-000000000010", user_id: userId, referred_by_client_id: conversionLeaderId, event_type: "opened", created_at: "2026-07-02T12:00:00.000Z" },
        { id: "30000000-0000-4000-8000-000000000011", user_id: userId, referred_by_client_id: tieBreakerId, event_type: "opened", created_at: "2026-07-02T12:00:00.000Z" }
      ]
    });

    try {
      const aggregate = await getStats();
      assert.equal(aggregate.topReferrer?.clientId, conversionLeaderId);
      assert.equal(aggregate.topReferrer?.successfulOutcomeCount, 1);
    } finally {
      supabase.restore();
    }
  });

  it("breaks equal outcome and engagement counts by stable client ID", async () => {
    const firstId = "40000000-0000-4000-8000-000000000001";
    const secondId = "40000000-0000-4000-8000-000000000002";
    const supabase = installMockSupabase({
      client_referral_links: [],
      clients: [
        { id: firstId, user_id: userId, first_name: "Avery" },
        { id: secondId, user_id: userId, first_name: "Bianca" }
      ],
      appointments: [],
      referral_events: [
        { id: "30000000-0000-4000-8000-000000000001", user_id: userId, referred_by_client_id: secondId, event_type: "opened", created_at: "2026-07-02T12:00:00.000Z" },
        { id: "30000000-0000-4000-8000-000000000002", user_id: userId, referred_by_client_id: firstId, event_type: "opened", created_at: "2026-07-02T12:00:00.000Z" }
      ]
    });

    try {
      assert.equal((await getStats()).topReferrer?.clientId, firstId);
    } finally {
      supabase.restore();
    }
  });

  it("never exposes an unowned top-referrer ID", async () => {
    const unownedId = "40000000-0000-4000-8000-000000000001";
    const ownedId = "40000000-0000-4000-8000-000000000002";
    const supabase = installMockSupabase({
      client_referral_links: [],
      clients: [{ id: ownedId, user_id: userId, first_name: "Bianca" }],
      appointments: [],
      referral_events: [
        { id: "30000000-0000-4000-8000-000000000001", user_id: userId, referred_by_client_id: unownedId, event_type: "opened", created_at: "2026-07-02T12:00:00.000Z" },
        { id: "30000000-0000-4000-8000-000000000002", user_id: userId, referred_by_client_id: unownedId, event_type: "opened", created_at: "2026-07-03T12:00:00.000Z" },
        { id: "30000000-0000-4000-8000-000000000003", user_id: userId, referred_by_client_id: ownedId, event_type: "opened", created_at: "2026-07-04T12:00:00.000Z" }
      ]
    });

    try {
      const aggregate = await getStats();
      assert.equal(aggregate.topReferrer?.clientId, ownedId);
    } finally {
      supabase.restore();
    }
  });
});
