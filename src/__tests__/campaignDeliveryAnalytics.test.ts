import assert from "node:assert/strict";
import { createHmac } from "crypto";
import { describe, it } from "node:test";
import { campaignDeliveryAnalyticsService, verifyResendWebhookSignature } from "../services/campaignDeliveryAnalyticsService";
import { campaignsService } from "../services/campaignsService";
import { installMockSupabase } from "./helpers/mockSupabase";

const userId = "11111111-1111-4111-8111-111111111111";
const campaignId = "22222222-2222-4222-8222-222222222222";
const recipientId = "33333333-3333-4333-8333-333333333333";

const state = () => ({
  campaigns: [{ id: campaignId, user_id: userId, status: "completed", send_mode: "now", audience_mode: "everyone" }],
  campaign_recipients: [{
    id: recipientId, campaign_id: campaignId, campaign_run_id: "run-1", user_id: userId,
    provider: "resend", provider_message_id: "email-1", eligibility_status: "eligible", status: "sent"
  }],
  campaign_delivery_events: [], appointments: []
});

describe("campaign delivery analytics", () => {
  it("idempotently records provider delivery and open events using the provider event ID", async () => {
    const db = installMockSupabase(state());
    try {
      const payload = { type: "email.delivered", data: { email_id: "email-1", created_at: "2026-07-18T12:00:00Z" } };
      const first = await campaignDeliveryAnalyticsService.recordResendWebhook(payload, "evt-delivered-1");
      const second = await campaignDeliveryAnalyticsService.recordResendWebhook(payload, "evt-delivered-1");
      await campaignDeliveryAnalyticsService.recordResendWebhook({ type: "email.opened", data: { email_id: "email-1" } }, "evt-open-1");
      assert.deepEqual(first, { accepted: true, duplicate: false });
      assert.deepEqual(second, { accepted: false, duplicate: true });
      assert.equal(db.state.campaign_delivery_events.length, 2);
      assert.equal(db.state.campaign_recipients[0]?.status, "delivered");
      const detail = await campaignsService.getForUser(userId, campaignId);
      assert.deepEqual(detail.metrics.delivery_analytics.opens.rate, { numerator: 1, denominator: 1, value: 1 });
    } finally { db.restore(); }
  });

  it("verifies the signed raw Resend webhook payload", () => {
    const raw = Buffer.from('{"type":"email.delivered"}');
    const secret = `whsec_${Buffer.from("analytics-test-secret").toString("base64")}`;
    const signature = createHmac("sha256", Buffer.from("analytics-test-secret"))
      .update(`msg_123.1721304000.${raw.toString("utf8")}`).digest("base64");
    assert.equal(verifyResendWebhookSignature(raw, { id: "msg_123", timestamp: "1721304000", signature: `v1,${signature}` }, secret), true);
    assert.equal(verifyResendWebhookSignature(raw, { id: "msg_123", timestamp: "1721304000", signature: "v1,forged" }, secret), false);
  });
});
