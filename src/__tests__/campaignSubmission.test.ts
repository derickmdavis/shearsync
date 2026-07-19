import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { campaignDraftsService } from "../services/campaignDraftsService";
import { campaignPreviewValidationService } from "../services/campaignPreviewValidationService";
import { campaignSubmissionService } from "../services/campaignSubmissionService";
import { campaignsService } from "../services/campaignsService";
import { outreachScheduledSendsService } from "../services/outreachScheduledSendsService";
import { installMockSupabase } from "./helpers/mockSupabase";

const userId = "11111111-1111-4111-8111-111111111111";
const clientId = "33333333-3333-4333-8333-333333333333";

const state = () => ({
  users: [{ id: userId, timezone: "UTC", plan_tier: "pro", plan_status: "active" }],
  campaigns: [], campaign_runs: [], campaign_recipients: [], campaign_audience_selections: [], campaign_idempotency_records: [],
  campaign_templates: [],
  clients: [{ id: clientId, user_id: userId, first_name: "Sara", email: "sara@example.com", deleted_at: null }],
  client_communication_preferences: [{
    id: "40000000-0000-4000-8000-000000000001", user_id: userId, client_id: clientId,
    email_normalized: "sara@example.com", email_marketing_enabled: true, opted_out_all_email: false
  }],
  global_email_unsubscribes: [],
  automation_settings: [], appointments: [], appointment_email_events: [], appointment_reminder_suppressions: [],
  rebook_nudges: [], birthday_reminders: [], thank_you_emails: []
});

const createValidatedDraft = async (mode: "now" | "scheduled" = "now") => {
  const created = await campaignDraftsService.createForUser(userId);
  const draft = await campaignDraftsService.updateForUser(userId, String(created.id), {
    revision: created.revision,
    name: "August booking update",
    send_mode: mode,
    ...(mode === "scheduled" ? { send_at: "2026-08-18T12:00:00.000Z" } : {}),
    link_type: "booking_link",
    audience: { mode: "specific", client_ids: [clientId] },
    content: { subject: "Hi {{first_name}}", message: "Book when you are ready." }
  });
  const validation = await campaignPreviewValidationService.validateForUser(
    userId, String(draft.id), draft.revision, new Date("2026-07-18T12:00:00.000Z")
  );
  assert.equal(validation.valid, true);
  return { draft, validation };
};

describe("campaign submission, idempotency, and cancellation", () => {
  it("repeats identical submit safely and rejects a reused key with another request", async () => {
    const db = installMockSupabase(state());
    try {
      const { draft, validation } = await createValidatedDraft();
      const request = {
        userId, campaignId: String(draft.id), revision: draft.revision,
        validationToken: validation.validation_token!, idempotencyKey: "submit-august-1", expectedSendMode: "now" as const
      };
      const first = await campaignSubmissionService.submitForUser(request);
      const second = await campaignSubmissionService.submitForUser(request);
      assert.deepEqual(second, first);
      assert.equal(db.state.campaign_runs.length, 1);
      assert.equal(db.state.campaign_recipients.length, 1);
      const list = await campaignsService.listForUser(userId, { limit: 20 });
      assert.deepEqual(list.data[0]?.allowed_actions, ["view", "cancel"]);
      db.state.appointments.push(
        { id: "booked", user_id: userId, campaign_id: draft.id, price: 125, status: "scheduled" },
        { id: "cancelled", user_id: userId, campaign_id: draft.id, price: 200, status: "cancelled" }
      );
      const detail = await campaignsService.getForUser(userId, String(draft.id));
      assert.equal(detail.id, draft.id);
      assert.deepEqual(detail.metrics.attribution, { booked_count: 1, booked_revenue_cents: 12500, currency: "USD" });
      await assert.rejects(
        () => campaignSubmissionService.submitForUser({ ...request, expectedSendMode: "scheduled" }),
        (error: unknown) => (error as { statusCode?: number }).statusCode === 409
      );
    } finally { db.restore(); }
  });

  it("rechecks eligibility immediately before snapshots and cancels through the scheduled-feed resource", async () => {
    const db = installMockSupabase(state());
    try {
      const { draft, validation } = await createValidatedDraft("scheduled");
      // Consent changed after validation; submission must not reuse the earlier estimate.
      db.state.client_communication_preferences[0]!.email_marketing_enabled = false;
      await assert.rejects(
        () => campaignSubmissionService.submitForUser({
          userId, campaignId: String(draft.id), revision: draft.revision,
          validationToken: validation.validation_token!, idempotencyKey: "submit-consent-changed", expectedSendMode: "scheduled"
        }),
        (error: unknown) => (error as { statusCode?: number }).statusCode === 400
      );

      db.state.client_communication_preferences[0]!.email_marketing_enabled = true;
      const submitted = await campaignSubmissionService.submitForUser({
        userId, campaignId: String(draft.id), revision: draft.revision,
        validationToken: validation.validation_token!, idempotencyKey: "submit-scheduled", expectedSendMode: "scheduled"
      }) as { campaign_id: string };
      const list = await outreachScheduledSendsService.listForUser(userId, { limit: 20, now: new Date("2026-07-18T12:00:00.000Z") });
      const item = list.data.find((candidate) => candidate.campaign_id === submitted.campaign_id);
      assert.ok(item);
      assert.equal(item?.kind, "campaign");
      assert.equal(item?.can_cancel, true);
      await outreachScheduledSendsService.cancelForUser(userId, item!.id, "No longer needed");
      assert.equal(db.state.campaigns[0]?.status, "cancelled");
      assert.equal(db.state.campaign_recipients[0]?.status, "cancelled");
    } finally { db.restore(); }
  });
});
