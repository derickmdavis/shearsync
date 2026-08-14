import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = process.env.AUTH_MODE ?? "production";
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key";

const { installMockSupabase } = require("./helpers/mockSupabase") as typeof import("./helpers/mockSupabase");
const { smsInboundEventsService } =
  require("../services/smsInboundEventsService") as typeof import("../services/smsInboundEventsService");

const event = {
  from: "+13035550123", fromNormalized: "+13035550123", to: "+13035550999", toNormalized: "+13035550999",
  body: "STOP", messageSid: "SM123", classification: "stop" as const, classificationSource: "twilio_opt_out_type" as const,
  providerMetadata: { opt_out_type: "STOP" }
};

describe("SMS inbound events", () => {
  it("dedupes processed events and safely reclaims failed or expired processing events", async () => {
    const supabase = installMockSupabase({
      sms_inbound_events: [{ id: "inbound-1", provider: "twilio", provider_message_id: "SM123", status: "processed" }]
    });
    try {
      const result = await smsInboundEventsService.claimTwilioInboundEvent(event);
      assert.equal(result.claimed, false);
      assert.equal(result.processed, true);
      assert.equal(result.event?.id, "inbound-1");
      assert.equal(supabase.state.sms_inbound_events.length, 1);

      supabase.state.sms_inbound_events[0] = {
        ...supabase.state.sms_inbound_events[0], status: "failed", attempt_count: 1
      };
      const recovered = await smsInboundEventsService.claimTwilioInboundEvent(event);
      assert.equal(recovered.claimed, true);
      assert.equal(supabase.state.sms_inbound_events[0]?.status, "processing");
      assert.equal(supabase.state.sms_inbound_events[0]?.attempt_count, 2);

      supabase.state.sms_inbound_events[0] = {
        ...supabase.state.sms_inbound_events[0], status: "processing", lease_expires_at: "2099-01-01T00:00:00.000Z"
      };
      const active = await smsInboundEventsService.claimTwilioInboundEvent(event);
      assert.equal(active.claimed, false);
      assert.equal(active.processed, false);
    } finally {
      supabase.restore();
    }
  });
});
