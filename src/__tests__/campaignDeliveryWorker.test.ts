import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { campaignDeliveryWorkerService } from "../services/campaignDeliveryWorkerService";
import type { EmailProvider } from "../services/appointmentEmailDeliveryService";
import { installMockSupabase } from "./helpers/mockSupabase";

const userId = "11111111-1111-4111-8111-111111111111";
const campaignId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const now = new Date("2026-07-18T12:00:00.000Z");

const recipient = (id: string, clientId: string, email: string, attemptCount = 0) => ({
  id, campaign_id: campaignId, campaign_run_id: runId, user_id: userId, client_id: clientId,
  recipient_email_snapshot: email, eligibility_status: "eligible", status: "queued", attempt_count: attemptCount,
  subject_snapshot: "Hello", rendered_text_snapshot: "Text", rendered_html_snapshot: "<p>Text</p>",
  idempotency_key: `campaign-recipient-${id}`, queued_at: "2026-07-18T11:00:00.000Z"
});

const state = () => ({
  campaigns: [{ id: campaignId, user_id: userId, status: "scheduled" }],
  campaign_runs: [{ id: runId, campaign_id: campaignId, user_id: userId, status: "scheduled", scheduled_for: "2026-07-18T11:00:00.000Z" }],
  campaign_recipients: [
    recipient("44444444-4444-4444-8444-444444444444", "client-1", "one@example.com"),
    recipient("55555555-5555-4555-8555-555555555555", "client-2", "two@example.com", 2)
  ],
  client_communication_preferences: [
    { id: "pref-1", user_id: userId, client_id: "client-1", email_normalized: "one@example.com", email_marketing_enabled: true, opted_out_all_email: false },
    { id: "pref-2", user_id: userId, client_id: "client-2", email_normalized: "two@example.com", email_marketing_enabled: true, opted_out_all_email: false }
  ],
  global_email_unsubscribes: []
});

describe("campaign delivery worker", () => {
  it("keeps successful recipient delivery when another recipient exhausts retries", async () => {
    const db = installMockSupabase(state());
    const provider: EmailProvider = {
      async send(message) {
        if (message.to === "two@example.com") throw new Error("provider outage");
        return { status: "sent", provider: "test", providerMessageId: "provider-1" };
      }
    };
    try {
      const result = await campaignDeliveryWorkerService.processDueCampaigns({ provider, now });
      assert.deepEqual({ sent: result.sent, failed: result.failed, retrying: result.retrying }, { sent: 1, failed: 1, retrying: 0 });
      assert.equal(db.state.campaign_recipients[0]?.provider_message_id, "provider-1");
      assert.equal(db.state.campaign_recipients[1]?.status, "failed");
      assert.equal(db.state.campaign_runs[0]?.status, "partially_failed");
      assert.equal(db.state.campaigns[0]?.status, "partially_failed");
    } finally { db.restore(); }
  });

  it("does not send after marketing consent is withdrawn", async () => {
    const db = installMockSupabase(state());
    db.state.client_communication_preferences[0]!.email_marketing_enabled = false;
    let sends = 0;
    const provider: EmailProvider = { async send() { sends += 1; return { status: "sent", provider: "test" }; } };
    try {
      await campaignDeliveryWorkerService.processDueCampaigns({ provider, limit: 1, now });
      assert.equal(sends, 0);
      assert.equal(db.state.campaign_recipients[0]?.status, "skipped");
    } finally { db.restore(); }
  });

  it("does not double-claim a recipient when workers overlap", async () => {
    const current = state();
    current.campaign_recipients = [current.campaign_recipients[0]!];
    const db = installMockSupabase(current);
    let sends = 0;
    const provider: EmailProvider = { async send() { sends += 1; return { status: "sent", provider: "test" }; } };
    try {
      await Promise.all([
        campaignDeliveryWorkerService.processDueCampaigns({ provider, now }),
        campaignDeliveryWorkerService.processDueCampaigns({ provider, now })
      ]);
      assert.equal(sends, 1);
    } finally { db.restore(); }
  });
});
