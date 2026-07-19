import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { campaignStoreService } from "../services/campaignStoreService";
import { installMockSupabase } from "./helpers/mockSupabase";

const migrationPath = join(process.cwd(), "supabase/migrations/202607180002_campaign_schema_foundation.sql");
const draftMigrationPath = join(process.cwd(), "supabase/migrations/202607180003_campaign_drafts_and_templates.sql");
const ownerId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const campaignId = "33333333-3333-4333-8333-333333333333";

describe("campaign schema foundation", () => {
  it("contains ownership, lifecycle, initial-run, and queue index invariants", () => {
    const sql = readFileSync(migrationPath, "utf8");

    for (const table of [
      "campaign_templates", "campaigns", "campaign_runs", "campaign_audience_selections",
      "campaign_recipients", "campaign_idempotency_records"
    ]) {
      assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`));
    }

    assert.match(sql, /campaigns_name_length_check/);
    assert.match(sql, /campaigns_subject_length_check/);
    assert.match(sql, /campaigns_message_length_check/);
    assert.match(sql, /validate_campaign_status_transition/);
    assert.match(sql, /campaigns_create_initial_run/);
    assert.match(sql, /campaign_runs_require_initial/);
    assert.match(sql, /campaign_runs_campaign_sequence_unique/);
    assert.match(sql, /campaign_runs_due_idx/);
    assert.match(sql, /campaign_recipients_run_status_idx/);
    assert.match(sql, /campaign_recipients_run_campaign_user_fkey/);
    assert.match(sql, /campaign_audience_selections_client_user_fkey/);
  });

  it("never returns another user's campaign or run through the foundation service", async () => {
    const db = installMockSupabase({
      campaigns: [{ id: campaignId, user_id: ownerId, status: "draft" }],
      campaign_runs: [{
        id: "44444444-4444-4444-8444-444444444444",
        campaign_id: campaignId,
        user_id: ownerId,
        sequence_number: 1,
        status: "draft"
      }]
    });

    try {
      assert.equal((await campaignStoreService.getCampaignForUser(ownerId, campaignId)).id, campaignId);
      await assert.rejects(
        () => campaignStoreService.getCampaignForUser(otherId, campaignId),
        (error: unknown) => (error as { statusCode?: number }).statusCode === 404
      );
      await assert.rejects(
        () => campaignStoreService.getRunForUser(
          otherId,
          campaignId,
          "44444444-4444-4444-8444-444444444444"
        ),
        (error: unknown) => (error as { statusCode?: number }).statusCode === 404
      );
    } finally {
      db.restore();
    }
  });

  it("keeps template snapshotting and audience replacement inside revision-locked database functions", () => {
    const sql = readFileSync(draftMigrationPath, "utf8");
    assert.match(sql, /create or replace function public\.create_campaign_draft/);
    assert.match(sql, /create or replace function public\.update_campaign_draft/);
    assert.match(sql, /for update;/);
    assert.match(sql, /campaign_revision_conflict/);
    assert.match(sql, /delete from public\.campaign_audience_selections/);
    assert.match(sql, /insert into public\.campaign_audience_selections/);
    assert.match(sql, /v_template\.version/);
  });
});
