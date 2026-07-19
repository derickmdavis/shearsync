import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { campaignDraftsService } from "../services/campaignDraftsService";
import { campaignTemplatesService } from "../services/campaignTemplatesService";
import { updateCampaignDraftSchema } from "../validators/campaignDraftValidators";
import { installMockSupabase } from "./helpers/mockSupabase";

const userId = "11111111-1111-4111-8111-111111111111";
const otherUserId = "22222222-2222-4222-8222-222222222222";
const templateId = "10000000-0000-4000-8000-000000000001";
const clientId = "33333333-3333-4333-8333-333333333333";

const state = () => ({
  users: [{ id: userId, timezone: "America/Denver" }, { id: otherUserId, timezone: "UTC" }],
  campaign_templates: [{
    id: templateId,
    name: "Booking Boost",
    description: "Invite clients to book.",
    link_type: "booking_link",
    subject: "Original subject",
    message: "Hi {{first_name}}, original message",
    version: 1,
    active: true,
    sort_order: 10,
    icon_key: "calendar"
  }],
  campaigns: [],
  campaign_runs: [],
  campaign_audience_selections: [],
  clients: [{ id: clientId, user_id: userId, first_name: "Sara" }]
});

describe("campaign templates and immediate drafts", () => {
  it("lists active versioned campaign templates", async () => {
    const db = installMockSupabase(state());
    try {
      const response = await campaignTemplatesService.list({ status: "active", limit: 20 });
      assert.equal(response.data.length, 1);
      assert.equal(response.data[0]?.version, 1);
      assert.deepEqual(response.data[0]?.suggested_audience, { mode: "everyone" });
    } finally { db.restore(); }
  });

  it("immediately creates a durable draft and initial run with template snapshots", async () => {
    const db = installMockSupabase(state());
    try {
      const created = await campaignDraftsService.createForUser(userId, templateId);
      assert.ok(created.id);
      assert.equal(created.revision, 1);
      assert.equal(created.template_version, 1);
      assert.equal(created.content.subject, "Original subject");
      assert.equal(db.state.campaigns.length, 1);
      assert.equal(db.state.campaign_runs.length, 1);
      assert.equal(db.state.campaign_runs[0]?.sequence_number, 1);
    } finally { db.restore(); }
  });

  it("atomically saves setup, content, and specific selections and restores them", async () => {
    const db = installMockSupabase(state());
    try {
      const created = await campaignDraftsService.createForUser(userId, templateId);
      const saved = await campaignDraftsService.updateForUser(userId, String(created.id), {
        revision: 1,
        name: "August Booking Boost",
        send_mode: "scheduled",
        send_at: "2026-08-15T15:00:00.000Z",
        audience: { mode: "specific", client_ids: [clientId] },
        content: { subject: "Updated subject", message: "Hi {{first_name}}, updated message" }
      });
      assert.equal(saved.revision, 2);

      const reopened = await campaignDraftsService.getForUser(userId, String(created.id));
      assert.equal(reopened.name, "August Booking Boost");
      assert.equal(reopened.send_at, "2026-08-15T15:00:00.000Z");
      assert.equal(reopened.content.subject, "Updated subject");
      assert.deepEqual(reopened.audience, { mode: "specific", client_ids: [clientId] });
    } finally { db.restore(); }
  });

  it("returns 409 for stale autosave without overwriting the newer revision", async () => {
    const db = installMockSupabase(state());
    try {
      const created = await campaignDraftsService.createForUser(userId);
      await campaignDraftsService.updateForUser(userId, String(created.id), { revision: 1, name: "Newest" });
      await assert.rejects(
        () => campaignDraftsService.updateForUser(userId, String(created.id), { revision: 1, name: "Stale" }),
        (error: unknown) => (error as { statusCode?: number }).statusCode === 409
      );
      assert.equal(db.state.campaigns[0]?.name, "Newest");
      assert.equal(db.state.campaigns[0]?.revision, 2);
    } finally { db.restore(); }
  });

  it("keeps draft snapshots unchanged when the source template changes", async () => {
    const db = installMockSupabase(state());
    try {
      const created = await campaignDraftsService.createForUser(userId, templateId);
      db.state.campaign_templates[0]!.subject = "A later template edit";
      db.state.campaign_templates[0]!.version = 2;
      const reopened = await campaignDraftsService.getForUser(userId, String(created.id));
      assert.equal(reopened.content.subject, "Original subject");
      assert.equal(reopened.template_version, 1);
    } finally { db.restore(); }
  });

  it("deletes only owned drafts", async () => {
    const db = installMockSupabase(state());
    try {
      const created = await campaignDraftsService.createForUser(userId);
      await assert.rejects(
        () => campaignDraftsService.deleteForUser(otherUserId, String(created.id)),
        (error: unknown) => (error as { statusCode?: number }).statusCode === 404
      );
      await campaignDraftsService.deleteForUser(userId, String(created.id));
      assert.equal(db.state.campaigns.length, 0);
    } finally { db.restore(); }
  });

  it("rejects unsupported personalization during autosave validation", () => {
    assert.equal(updateCampaignDraftSchema.safeParse({
      revision: 1,
      content: { message: "Hi {{business_name}}" }
    }).success, false);
  });
});
