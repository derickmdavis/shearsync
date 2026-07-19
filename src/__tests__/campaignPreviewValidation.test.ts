import assert from "node:assert/strict";
import { describe, it } from "node:test";
import jwt from "jsonwebtoken";
import { verifyCampaignValidationToken } from "../lib/campaignValidationToken";
import { campaignDraftsService } from "../services/campaignDraftsService";
import { campaignPreviewValidationService } from "../services/campaignPreviewValidationService";
import { installMockSupabase } from "./helpers/mockSupabase";

const userId = "11111111-1111-4111-8111-111111111111";
const clientId = "33333333-3333-4333-8333-333333333333";

const state = () => ({
  users: [{ id: userId, timezone: "UTC" }],
  campaigns: [],
  campaign_runs: [],
  campaign_audience_selections: [],
  clients: [{ id: clientId, user_id: userId, first_name: "Sara", email: "sara@example.com", deleted_at: null }],
  client_communication_preferences: [{
    id: "40000000-0000-4000-8000-000000000001",
    user_id: userId,
    client_id: clientId,
    email_normalized: "sara@example.com",
    email_marketing_enabled: true,
    opted_out_all_email: false
  }],
  global_email_unsubscribes: [],
  campaign_templates: []
});

const configuredDraft = async () => {
  const created = await campaignDraftsService.createForUser(userId);
  return campaignDraftsService.updateForUser(userId, String(created.id), {
    revision: created.revision,
    name: "August booking update",
    send_mode: "now",
    link_type: "booking_link",
    audience: { mode: "specific", client_ids: [clientId] },
    content: { subject: "Hi {{first_name}}", message: "<strong>Book</strong> when you are ready." }
  });
};

describe("campaign rendering, preview, and validation", () => {
  it("renders escaped HTML, consistent text sections, fallback preview, and fake links only", async () => {
    const db = installMockSupabase(state());
    try {
      const draft = await configuredDraft();
      const preview = await campaignPreviewValidationService.previewForUser(userId, String(draft.id));
      assert.equal(preview.sample.subject, "Hi Sara");
      assert.equal(preview.missing_name_sample.subject, "Hi there");
      assert.match(preview.sample.text, /https:\/\/preview\.invalid\/campaign\/book/);
      assert.match(preview.sample.html, /&lt;strong&gt;Book&lt;\/strong&gt;/);
      assert.match(preview.sample.html, /Manage preferences/);
      assert.equal(db.state.client_referral_links?.length ?? 0, 0);
    } finally { db.restore(); }
  });

  it("reports field and schedule errors without issuing a validation token", async () => {
    const db = installMockSupabase(state());
    try {
      const created = await campaignDraftsService.createForUser(userId);
      const response = await campaignPreviewValidationService.validateForUser(
        userId, String(created.id), created.revision, new Date("2026-07-18T12:00:00.000Z")
      );
      assert.equal(response.valid, false);
      assert.equal(response.validation_token, null);
      assert.ok(response.field_errors.some((error) => error.field === "name"));
      assert.ok(response.field_errors.some((error) => error.field === "content.subject"));
    } finally { db.restore(); }
  });

  it("reports scheduled-send lead-time violations alongside current audience exclusions", async () => {
    const db = installMockSupabase(state());
    try {
      const draft = await configuredDraft();
      const scheduled = await campaignDraftsService.updateForUser(userId, String(draft.id), {
        revision: draft.revision,
        send_mode: "scheduled",
        send_at: "2026-07-18T12:04:59.000Z"
      });
      const response = await campaignPreviewValidationService.validateForUser(
        userId, String(scheduled.id), scheduled.revision, new Date("2026-07-18T12:00:00.000Z")
      );
      assert.equal(response.valid, false);
      assert.ok(response.field_errors.some((error) => error.field === "send_at"));
      assert.equal(response.audience.eligible_count, 1);
    } finally { db.restore(); }
  });

  it("issues a short-lived revision-bound token that cannot match an edited draft", async () => {
    const db = installMockSupabase(state());
    try {
      const draft = await configuredDraft();
      const result = await campaignPreviewValidationService.validateForUser(
        userId, String(draft.id), draft.revision, new Date("2026-07-18T12:00:00.000Z")
      );
      assert.equal(result.valid, true);
      assert.ok(result.validation_token);
      assert.equal(db.state.campaigns[0]?.validation_nonce_hash === null, false);

      const claims = jwt.decode(result.validation_token!) as { submission_hash: string };
      verifyCampaignValidationToken(result.validation_token!, {
        campaign_id: String(draft.id), user_id: userId, revision: draft.revision,
        submission_hash: claims.submission_hash,
        validation_nonce_hash: String(db.state.campaigns[0]?.validation_nonce_hash)
      });

      const edited = await campaignDraftsService.updateForUser(userId, String(draft.id), {
        revision: draft.revision, name: "Edited campaign"
      });
      assert.equal(db.state.campaigns[0]?.validation_nonce_hash, null);
      assert.throws(() => verifyCampaignValidationToken(result.validation_token!, {
        campaign_id: String(draft.id), user_id: userId, revision: edited.revision,
        submission_hash: campaignPreviewValidationService.getSubmissionHash(edited),
        validation_nonce_hash: null
      }), (error: unknown) => (error as { statusCode?: number }).statusCode === 409);
    } finally { db.restore(); }
  });
});
