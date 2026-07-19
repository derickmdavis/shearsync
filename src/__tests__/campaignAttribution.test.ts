import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { env } from "../config/env";
import { hashToken } from "../lib/communications";
import { resolvePublicBookingContextToken } from "../lib/publicBookingContext";
import { campaignAttributionService } from "../services/campaignAttributionService";
import { installMockSupabase } from "./helpers/mockSupabase";

const userId = "11111111-1111-4111-8111-111111111111";
const campaignId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const recipientId = "44444444-4444-4444-8444-444444444444";
const clientId = "55555555-5555-4555-8555-555555555555";

const state = (linkType: "booking_link" | "referral_link") => ({
  users: [{ id: userId }],
  stylists: [{ id: "stylist-1", user_id: userId, slug: "sara-style", booking_enabled: true }],
  clients: [{ id: clientId, user_id: userId, first_name: "Sara", email: "sara@example.com", deleted_at: null }],
  campaigns: [{ id: campaignId, user_id: userId, status: "scheduled", link_type: linkType }],
  campaign_runs: [{ id: runId, campaign_id: campaignId, user_id: userId, sequence_number: 1 }],
  campaign_recipients: [{
    id: recipientId, campaign_id: campaignId, campaign_run_id: runId, user_id: userId, client_id: clientId,
    eligibility_status: "eligible", booking_tracking_token_hash: hashToken("opaque-campaign-token"),
    queued_at: "2026-07-01T00:00:00.000Z"
  }],
  client_referral_links: [{
    id: "66666666-6666-4666-8666-666666666666", user_id: userId, client_id: clientId,
    referral_code: "rf_existing12", referral_url: "https://example.test/r/rf_existing12", status: "active"
  }]
});

describe("campaign booking attribution", () => {
  it("resolves an opaque campaign link into a signed, expiring booking context", async () => {
    const previous = env.WEB_APP_URL;
    env.WEB_APP_URL = "https://booking.example.test";
    const db = installMockSupabase(state("booking_link"));
    try {
      const resolved = await campaignAttributionService.resolvePublicLink("opaque-campaign-token", new Date("2026-07-18T00:00:00.000Z"));
      const url = new URL(resolved.redirect_url);
      const context = resolvePublicBookingContextToken(url.searchParams.get("booking_context_token") ?? undefined, "sara-style");
      assert.deepEqual(context?.campaignAttribution, {
        campaignId, campaignRunId: runId, campaignRecipientId: recipientId, expiresAt: "2026-07-31T00:00:00.000Z"
      });
      assert.equal(url.searchParams.has("ref"), false);
      await assert.rejects(() => campaignAttributionService.resolvePublicLink("forged-campaign-id"), { statusCode: 404 });
    } finally { db.restore(); env.WEB_APP_URL = previous; }
  });

  it("adds referral attribution without replacing campaign attribution", async () => {
    const previous = env.WEB_APP_URL;
    env.WEB_APP_URL = "https://booking.example.test";
    const db = installMockSupabase(state("referral_link"));
    try {
      const resolved = await campaignAttributionService.resolvePublicLink("opaque-campaign-token", new Date("2026-07-18T00:00:00.000Z"));
      const url = new URL(resolved.redirect_url);
      assert.equal(url.searchParams.get("ref"), "rf_existing12");
      assert.equal(db.state.campaign_recipients[0]?.referral_link_id, db.state.client_referral_links[0]?.id);
      const fields = campaignAttributionService.toAppointmentFields(resolvePublicBookingContextToken(
        url.searchParams.get("booking_context_token") ?? undefined, "sara-style"
      ));
      assert.equal(fields.campaign_id, campaignId);
      assert.equal(fields.campaign_recipient_id, recipientId);
    } finally { db.restore(); env.WEB_APP_URL = previous; }
  });
});
