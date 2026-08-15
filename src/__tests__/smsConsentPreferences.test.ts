import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = process.env.AUTH_MODE ?? "production";
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key";

const { installMockSupabase } = require("./helpers/mockSupabase") as typeof import("./helpers/mockSupabase");
const { communicationPreferencesService } = require("../services/communicationPreferences") as typeof import("../services/communicationPreferences");

describe("client SMS consent preferences", () => {
  it("requires an explicit opt-in, keeps marketing and rebooking disabled, and links each mutation to its audit event", async () => {
    const userId = "11111111-1111-1111-1111-111111111111";
    const clientId = "22222222-2222-2222-2222-222222222222";
    const supabase = installMockSupabase({
      clients: [{ id: clientId, user_id: userId, phone: "+15555550123" }],
      client_communication_preferences: [],
      communication_consent_events: []
    });
    try {
      const initial = await communicationPreferencesService.getSmsPreferenceForClient(userId, clientId);
      assert.equal(initial.optedIn, false);
      assert.equal(initial.optedOut, false);
      assert.equal(initial.categories.transactional, false);

      await assert.rejects(
        communicationPreferencesService.updateSmsPreferenceForClient(userId, clientId, {
          action: "preferences", source: "staff", marketingEnabled: true
        }),
        /require an explicit opt-in/
      );

      const optedIn = await communicationPreferencesService.updateSmsPreferenceForClient(userId, clientId, {
        action: "opt_in", source: "staff", consentText: "Client verbally agreed to appointment texts."
      });
      assert.equal(optedIn.optedIn, true);
      assert.deepEqual(optedIn.categories, { transactional: true, reminders: true, marketing: false, rebooking: false });
      assert.equal(optedIn.consent.optedInSource, "staff");
      assert.ok(optedIn.consent.lastAuditEventId);

      const updated = await communicationPreferencesService.updateSmsPreferenceForClient(userId, clientId, {
        action: "preferences", source: "staff", marketingEnabled: true, rebookingEnabled: true
      });
      assert.equal(updated.categories.marketing, true);
      assert.equal(updated.categories.rebooking, true);
      assert.ok(updated.consent.lastAuditEventId);

      await communicationPreferencesService.updateSmsPreferenceForClient(userId, clientId, {
        action: "preferences", source: "staff", marketingEnabled: true, rebookingEnabled: true
      });
      assert.equal(supabase.state.communication_consent_events.length, 2);

      const optedOut = await communicationPreferencesService.updateSmsPreferenceForClient(userId, clientId, {
        action: "opt_out", source: "client_portal"
      });
      assert.equal(optedOut.optedOut, true);
      assert.deepEqual(optedOut.categories, { transactional: false, reminders: false, marketing: false, rebooking: false });
      assert.equal(supabase.state.communication_consent_events.length, 3);
    } finally {
      supabase.restore();
    }
  });

  it("rejects an SMS preference read for another account or a client without a valid phone", async () => {
    const userId = "11111111-1111-1111-1111-111111111111";
    const otherUserId = "33333333-3333-3333-3333-333333333333";
    const supabase = installMockSupabase({
      clients: [
        { id: "22222222-2222-2222-2222-222222222222", user_id: otherUserId, phone: "+15555550123" },
        { id: "44444444-4444-4444-4444-444444444444", user_id: userId, phone: null }
      ]
    });
    try {
      await assert.rejects(
        communicationPreferencesService.getSmsPreferenceForClient(userId, "22222222-2222-2222-2222-222222222222"),
        /Client not found/
      );
      await assert.rejects(
        communicationPreferencesService.getSmsPreferenceForClient(userId, "44444444-4444-4444-4444-444444444444"),
        /requires a valid phone/
      );
    } finally {
      supabase.restore();
    }
  });
});
