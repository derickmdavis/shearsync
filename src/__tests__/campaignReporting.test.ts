import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { campaignsService } from "../services/campaignsService";
import { installMockSupabase } from "./helpers/mockSupabase";

const userId = "11111111-1111-4111-8111-111111111111";
const campaignOne = "22222222-2222-4222-8222-222222222222";
const campaignTwo = "33333333-3333-4333-8333-333333333333";

const state = () => ({
  campaigns: [
    { id: campaignOne, user_id: userId, name: "First", status: "completed", send_mode: "now", audience_mode: "everyone", created_at: "2026-07-18T12:00:00Z" },
    { id: campaignTwo, user_id: userId, name: "Second", status: "scheduled", send_mode: "scheduled", audience_mode: "specific", created_at: "2026-07-17T12:00:00Z" }
  ],
  campaign_recipients: [
    { id: "r-1", campaign_id: campaignOne, user_id: userId, eligibility_status: "eligible", status: "sent" },
    { id: "r-2", campaign_id: campaignOne, user_id: userId, eligibility_status: "eligible", status: "failed" },
    { id: "r-3", campaign_id: campaignOne, user_id: userId, eligibility_status: "excluded", status: "skipped" },
    { id: "r-4", campaign_id: campaignOne, user_id: userId, eligibility_status: "eligible", status: "queued" },
    { id: "r-5", campaign_id: campaignTwo, user_id: userId, eligibility_status: "eligible", status: "queued" }
  ],
  appointments: [
    { id: "a-1", user_id: userId, campaign_id: campaignOne, status: "scheduled", price: 125.25 },
    { id: "a-2", user_id: userId, campaign_id: campaignOne, status: "cancelled", price: 99.99 }
  ]
});

describe("campaign first-release reporting", () => {
  it("returns per-campaign list summaries from raw recipient and attributed appointment records", async () => {
    const db = installMockSupabase(state());
    try {
      const list = await campaignsService.listForUser(userId, { limit: 20 });
      assert.equal(list.data.length, 2);
      const first = list.data.find((campaign) => campaign.id === campaignOne)!;
      assert.deepEqual(first.summary.recipients, {
        total: 4, eligible: 3, excluded: 1, pending: 0, queued: 1, sending: 0,
        sent: 1, delivered: 0, failed: 1, skipped: 1, cancelled: 0
      });
      assert.deepEqual(first.summary.attribution, { booked_count: 1, booked_revenue_cents: 12525, currency: "USD" });
      assert.equal(list.metric_definitions.revenue_unit, "cents");
      assert.equal(list.metric_definitions.delivery_analytics.opens.available, true);
      assert.equal(list.metric_definitions.delivery_analytics.clicks.available, true);
    } finally { db.restore(); }
  });

  it("uses the same reconciled summary and metadata on campaign detail", async () => {
    const db = installMockSupabase(state());
    try {
      const detail = await campaignsService.getForUser(userId, campaignOne);
      assert.equal(detail.metrics.recipients.total, 4);
      assert.equal(detail.metrics.attribution.booked_revenue_cents, 12525);
      assert.equal(detail.metric_definitions.attribution_window.duration_days, 30);
      assert.equal(detail.metric_definitions.attribution_window.cancelled_appointments_included, false);
    } finally { db.restore(); }
  });
});
