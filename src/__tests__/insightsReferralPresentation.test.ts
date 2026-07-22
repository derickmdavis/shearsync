import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.NODE_ENV = "test";
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key";

const {
  insightsReferralPresentationService,
  REFERRAL_INSIGHTS_ICON_KEYS
} = require("../services/insightsReferralPresentationService") as typeof import("../services/insightsReferralPresentationService");
import type { InsightsReferralStats } from "../services/referralLinksService";

const stats = (overrides: Partial<InsightsReferralStats> = {}): InsightsReferralStats => ({
  period: {
    label: "This Month",
    startAt: "2026-07-01T06:00:00.000Z",
    endAt: "2026-07-21T18:00:00.000Z"
  },
  newClients: 0,
  appointmentsBooked: 0,
  conversionRatePercent: 0,
  linksSent: 0,
  linksClicked: 0,
  attributedRevenueMinor: 0,
  bookedValueMinor: 0,
  currency: "USD",
  historicalResults: {
    newClients: 0,
    appointmentsBooked: 0,
    hasSuccessfulConversions: false
  },
  topReferrer: null,
  ...overrides
});

describe("Referral Impact presentation", () => {
  it("exports the stable icon contract", () => {
    assert.deepEqual(REFERRAL_INSIGHTS_ICON_KEYS, [
      "referral_program",
      "referral_clients",
      "referral_appointments",
      "referral_conversion",
      "referral_top_referrer"
    ]);
  });

  it("converts the calculation aggregate into the ordered three-card display model", () => {
    const presentation = insightsReferralPresentationService.build(stats({
      newClients: 1_240,
      appointmentsBooked: 36,
      conversionRatePercent: 12,
      linksSent: 2_000,
      linksClicked: 300,
      historicalResults: {
        newClients: 1_240,
        appointmentsBooked: 36,
        hasSuccessfulConversions: true
      }
    }));

    assert.equal(presentation.has_successful_conversions, true);
    assert.deepEqual(presentation.metrics, [
      {
        id: "new_clients",
        icon_key: "referral_clients",
        display_value: "1,240",
        label: "New clients",
        supporting_text: "2,000 links sent",
        semantic_tone: "positive",
        accessibility_label: "1,240 new clients from 2,000 referral links sent"
      },
      {
        id: "appointments_booked",
        icon_key: "referral_appointments",
        display_value: "36",
        label: "Appointments",
        supporting_text: "300 clicks",
        semantic_tone: "positive",
        accessibility_label: "36 referral appointments from 300 clicks"
      },
      {
        id: "conversion_rate",
        icon_key: "referral_conversion",
        display_value: "12%",
        label: "Conversion",
        supporting_text: "300 clicks",
        semantic_tone: "positive",
        accessibility_label: "12 percent referral conversion, 300 clicks"
      }
    ]);
  });

  it("renders valid zero values and lifetime state without exposing legacy fields", () => {
    const presentation = insightsReferralPresentationService.build(stats());

    assert.equal(presentation.has_successful_conversions, false);
    assert.deepEqual(presentation.metrics.map((metric) => metric.display_value), ["0", "0", "0%"]);
    assert.equal(presentation.metrics[2].supporting_text, "No bookings yet");
    assert.equal(presentation.metrics[2].semantic_tone, "neutral");
    assert.equal(presentation.top_referrer, null);
    assert.equal("links_sent" in presentation, false);
    assert.equal("historical_results" in presentation, false);
  });

  it("creates a complete top-referrer display model", () => {
    const presentation = insightsReferralPresentationService.build(stats({
      topReferrer: {
        clientId: "40000000-0000-4000-8000-000000000010",
        displayName: "Sarah J.",
        successfulOutcomeCount: 3,
        engagementCount: 0
      }
    }));

    assert.deepEqual(presentation.top_referrer, {
      client_id: "40000000-0000-4000-8000-000000000010",
      icon_key: "referral_top_referrer",
      eyebrow: "Top referrer",
      title: "Sarah J.",
      result_text: "3 referrals",
      accessibility_label: "Top referrer Sarah J., 3 referrals"
    });
  });
});
