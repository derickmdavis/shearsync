import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { campaignAudienceEstimateService } from "../services/campaignAudienceEstimateService";
import { clientsService } from "../services/clientsService";
import { installMockSupabase } from "./helpers/mockSupabase";

const userId = "11111111-1111-4111-8111-111111111111";
const foreignUserId = "22222222-2222-4222-8222-222222222222";
const ids = {
  duplicateWinner: "10000000-0000-4000-8000-000000000001",
  duplicateLoser: "10000000-0000-4000-8000-000000000002",
  missing: "10000000-0000-4000-8000-000000000003",
  invalid: "10000000-0000-4000-8000-000000000004",
  optedOut: "10000000-0000-4000-8000-000000000005",
  global: "10000000-0000-4000-8000-000000000006",
  foreign: "10000000-0000-4000-8000-000000000007"
};

const baseState = (): Record<string, Record<string, unknown>[]> => ({
  users: [{ id: userId, timezone: "UTC" }],
  clients: [
    { id: ids.duplicateWinner, user_id: userId, first_name: "Ada", last_name: "A", email: "DUP@example.com", deleted_at: null },
    { id: ids.duplicateLoser, user_id: userId, first_name: "Bea", last_name: "B", email: "dup@example.com", deleted_at: null },
    { id: ids.missing, user_id: userId, first_name: "Cam", last_name: "C", email: null, deleted_at: null },
    { id: ids.invalid, user_id: userId, first_name: "Dee", last_name: "D", email: "not-an-email", deleted_at: null },
    { id: ids.optedOut, user_id: userId, first_name: "Eve", last_name: "E", email: "opted@example.com", deleted_at: null },
    { id: ids.global, user_id: userId, first_name: "Flo", last_name: "F", email: "global@example.com", deleted_at: null },
    { id: ids.foreign, user_id: foreignUserId, first_name: "Gia", last_name: "G", email: "foreign@example.com", deleted_at: null }
  ],
  client_communication_preferences: [
    {
      id: "30000000-0000-4000-8000-000000000001",
      user_id: userId,
      client_id: ids.duplicateWinner,
      email_normalized: "dup@example.com",
      email_marketing_enabled: true,
      opted_out_all_email: false
    },
    {
      id: "30000000-0000-4000-8000-000000000002",
      user_id: userId,
      client_id: ids.optedOut,
      email_normalized: "opted@example.com",
      email_marketing_enabled: false,
      opted_out_all_email: true
    }
  ],
  global_email_unsubscribes: [{
    id: "40000000-0000-4000-8000-000000000001",
    email_normalized: "global@example.com"
  }],
  appointments: []
});

describe("campaign audience eligibility", () => {
  it("uses stable consent, contact, and duplicate exclusions for everyone", async () => {
    const db = installMockSupabase(baseState());
    try {
      const result = await campaignAudienceEstimateService.estimateForUser(
        userId,
        { mode: "everyone", client_ids: [] },
        new Date("2026-07-18T18:00:00.000Z")
      );
      assert.equal(result.total_count, 6);
      assert.equal(result.eligible_count, 1);
      assert.equal(result.excluded_count, 5);
      assert.equal(result.exclusions.missing_email, 1);
      assert.equal(result.exclusions.invalid_email, 1);
      assert.equal(result.exclusions.email_marketing_disabled, 1);
      assert.equal(result.exclusions.globally_unsubscribed, 1);
      assert.equal(result.exclusions.duplicate_recipient, 1);
    } finally { db.restore(); }
  });

  it("uses the same rules for selected clients without revealing foreign ownership", async () => {
    const db = installMockSupabase(baseState());
    try {
      const result = await campaignAudienceEstimateService.estimateForUser(userId, {
        mode: "specific",
        client_ids: [ids.duplicateWinner, ids.duplicateLoser, ids.foreign]
      });
      assert.equal(result.eligible_count, 1);
      assert.equal(result.excluded_count, 2);
      assert.deepEqual(result.selections, [
        { client_id: ids.duplicateWinner, eligible: true, reason: null },
        { client_id: ids.duplicateLoser, eligible: false, reason: "duplicate_recipient" },
        { client_id: ids.foreign, eligible: false, reason: "not_owned_or_not_found" }
      ]);
    } finally { db.restore(); }
  });

  it("annotates client search with individual campaign eligibility", async () => {
    const db = installMockSupabase(baseState());
    try {
      const result = await clientsService.list(userId, {
        search: "Eve",
        page: 1,
        pageSize: 25,
        campaign_eligibility: "email_marketing"
      });
      assert.equal(result.data.length, 1);
      assert.deepEqual(result.data[0]?.campaign_eligibility, {
        eligible: false,
        reason: "email_marketing_disabled"
      });
    } finally { db.restore(); }
  });

  it("treats a missing marketing preference as no marketing consent", async () => {
    const state = baseState();
    state.clients = [{
      id: ids.invalid,
      user_id: userId,
      first_name: "No Consent",
      email: "valid-but-unconsented@example.com",
      deleted_at: null
    }];
    const db = installMockSupabase(state);
    try {
      const result = await campaignAudienceEstimateService.estimateForUser(
        userId,
        { mode: "everyone", client_ids: [] }
      );
      assert.equal(result.eligible_count, 0);
      assert.equal(result.exclusions.email_marketing_disabled, 1);
    } finally { db.restore(); }
  });

  it("does not apply a plan or implementation recipient cap", async () => {
    const largeState = baseState();
    largeState.clients = Array.from({ length: 1_205 }, (_, index) => ({
      id: `50000000-0000-4000-8${String(index).padStart(3, "0")}-000000000001`,
      user_id: userId,
      first_name: `Client${index}`,
      last_name: "Test",
      email: `client${index}@example.com`,
      deleted_at: null
    }));
    largeState.client_communication_preferences = largeState.clients.map((client, index) => ({
      id: `60000000-0000-4000-8${String(index).padStart(3, "0")}-000000000001`,
      user_id: userId,
      client_id: client.id,
      email_normalized: client.email,
      email_marketing_enabled: true,
      opted_out_all_email: false
    }));
    largeState.global_email_unsubscribes = [{
      id: "70000000-0000-4000-8000-000000000001",
      email_normalized: "client1204@example.com"
    }];
    const queryLog: Array<{ table: string; operation: "in"; column: string; values: unknown[] }> = [];
    const db = installMockSupabase(largeState, { queryLog });
    try {
      const result = await campaignAudienceEstimateService.estimateForUser(userId, { mode: "everyone", client_ids: [] });
      assert.equal(result.total_count, 1_205);
      assert.equal(result.eligible_count, 1_204);
      assert.equal(result.exclusions.globally_unsubscribed, 1);
      const preferenceQueries = queryLog.filter((query) => query.table === "client_communication_preferences");
      const unsubscribeQueries = queryLog.filter((query) => query.table === "global_email_unsubscribes");
      assert.ok(preferenceQueries.length > 1);
      assert.ok(unsubscribeQueries.length > 1);
      assert.ok([...preferenceQueries, ...unsubscribeQueries].every((query) => query.values.length <= 200));
    } finally { db.restore(); }
  });
});
