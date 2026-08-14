import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Request, Response } from "express";

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = process.env.AUTH_MODE ?? "production";
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key";

const { installMockSupabase } = require("./helpers/mockSupabase") as typeof import("./helpers/mockSupabase");
const { communicationsController } = require("../controllers/communicationsController") as typeof import("../controllers/communicationsController");

const createResponse = () => {
  const result: { type?: string; body?: string; status?: number } = {};
  const response = {
    status(code: number) { result.status = code; return this; },
    type(value: string) { result.type = value; return this; },
    send(value: string) { result.body = value; return this; }
  } as Partial<Response> as Response;
  return { result, response };
};

const request = (body: Record<string, string>): Request => ({ body, ip: "127.0.0.1", get: () => null } as unknown as Request);

describe("inbound SMS controller", () => {
  it("does not duplicate Twilio Advanced Opt-Out replies and dedupes the same MessageSid", async () => {
    const supabase = installMockSupabase({
      client_communication_preferences: [{
        id: "preference-1", user_id: "11111111-1111-1111-1111-111111111111", phone: "+13035550123",
        phone_normalized: "+13035550123", sms_transactional_enabled: true, sms_reminders_enabled: true,
        sms_marketing_enabled: false, sms_rebooking_enabled: false, opted_out_all_sms: false
      }]
    });
    const body = { From: "+13035550123", To: "+13035550999", Body: "STOP", MessageSid: "SM-controller", OptOutType: "STOP" };
    try {
      const first = createResponse();
      await communicationsController.inboundSms(request(body), first.response);
      assert.equal(first.result.status, 200);
      assert.match(first.result.body ?? "", /<Response\/>/);
      assert.doesNotMatch(first.result.body ?? "", /<Message>/);
      assert.equal(supabase.state.communication_consent_events.length, 1);
      assert.equal(supabase.state.communication_events.length, 1);
      assert.deepEqual(supabase.state.communication_consent_events[0]?.metadata, {
        provider: "twilio",
        provider_message_id: "SM-controller",
        destination_number: "+13035550999",
        opt_out_type: "STOP",
        classification: "stop",
        classification_source: "twilio_opt_out_type",
        provider_classified: true,
        consent_scope: "shared_messaging_service",
        consent_scope_destination: "+13035550999"
      });

      const duplicate = createResponse();
      await communicationsController.inboundSms(request(body), duplicate.response);
      assert.match(duplicate.result.body ?? "", /<Response\/>/);
      assert.equal(supabase.state.communication_consent_events.length, 1);
      assert.equal(supabase.state.communication_events.length, 1);
    } finally {
      supabase.restore();
    }
  });

  it("returns a TwiML message for normal keyword fallback callbacks", async () => {
    const supabase = installMockSupabase({
      client_communication_preferences: [{
        id: "preference-help", user_id: "11111111-1111-1111-1111-111111111111", client_id: "22222222-2222-2222-2222-222222222222",
        phone: "+13035550123", phone_normalized: "+13035550123"
      }],
      communication_consent_events: [],
      communication_events: []
    });
    try {
      const response = createResponse();
      await communicationsController.inboundSms(request({
        From: "+13035550123", To: "+13035550999", Body: "HELP", MessageSid: "SM-controller-help"
      }), response.response);
      assert.match(response.result.body ?? "", /<Message>DripDesk sends appointment messages/);
      assert.equal(supabase.state.communication_consent_events[0]?.event_type, "inbound_help");
      assert.deepEqual(supabase.state.communication_events[0]?.metadata, {
        provider: "twilio",
        provider_message_id: "SM-controller-help",
        destination_number: "+13035550999",
        opt_out_type: null,
        classification: "help",
        classification_source: "keyword_fallback",
        provider_classified: false,
        consent_scope: "shared_messaging_service",
        consent_scope_destination: "+13035550999"
      });
    } finally {
      supabase.restore();
    }
  });
});
