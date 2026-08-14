import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = process.env.AUTH_MODE ?? "production";
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key";

const { installMockSupabase } = require("./helpers/mockSupabase") as typeof import("./helpers/mockSupabase");
const { smsInboundEventRetentionService } =
  require("../services/smsInboundEventRetentionService") as typeof import("../services/smsInboundEventRetentionService");

describe("SMS inbound event retention", () => {
  it("redacts raw inbound bodies and phone data while preserving the event record after the retention cutoff", async () => {
    const supabase = installMockSupabase({
      sms_inbound_events: [
        { id: "expired", status: "processed", redacted_at: null, received_at: "2000-01-01T00:00:00.000Z", body: "STOP", from_phone: "+13035550123", from_phone_normalized: "+13035550123" },
        { id: "current", status: "processed", redacted_at: null, received_at: new Date().toISOString(), body: "HELP", from_phone: "+13035550124" }
      ]
    });
    try {
      const result = await smsInboundEventRetentionService.cleanup(30);
      assert.equal(result.retentionDays, 30);
      assert.equal(result.redacted, 1);
      assert.equal(supabase.state.sms_inbound_events.length, 2);
      assert.equal(supabase.state.sms_inbound_events[0]?.body, null);
      assert.equal(supabase.state.sms_inbound_events[0]?.from_phone, null);
      assert.deepEqual(supabase.state.sms_inbound_events[0]?.provider_metadata, { retention_redacted: true });
      assert.equal(supabase.state.sms_inbound_events[1]?.body, "HELP");
    } finally {
      supabase.restore();
    }
  });
});
