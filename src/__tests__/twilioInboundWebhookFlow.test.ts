import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NextFunction, Request, Response } from "express";
import { getExpectedTwilioSignature } from "twilio";

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = "production";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
process.env.SMS_PROVIDER = "twilio";
process.env.TWILIO_AUTH_TOKEN = "test-auth-token";
process.env.PUBLIC_API_BASE_URL = "https://shearsync-api-production.up.railway.app";

const { installMockSupabase } = require("./helpers/mockSupabase") as typeof import("./helpers/mockSupabase");
const { requireValidTwilioWebhook } = require("../middleware/twilioWebhook") as typeof import("../middleware/twilioWebhook");
const { communicationsController } = require("../controllers/communicationsController") as typeof import("../controllers/communicationsController");

const inboundPath = "/api/communications/sms/inbound";
const publicBaseUrl = "https://shearsync-api-production.up.railway.app";
const userId = "11111111-1111-1111-1111-111111111111";
const clientId = "22222222-2222-2222-2222-222222222222";

interface WebhookResult {
  status?: number;
  type?: string;
  body?: unknown;
  nextCalled: boolean;
}

const signedInbound = (body: Record<string, string>) => {
  const signature = getExpectedTwilioSignature("test-auth-token", `${publicBaseUrl}${inboundPath}`, body);
  return { body, signature };
};

const invokeInbound = async (body: Record<string, string>): Promise<WebhookResult> => {
  const { signature } = signedInbound(body);
  return new Promise((resolve, reject) => {
    const result: WebhookResult = { nextCalled: false };
    const req = {
      originalUrl: inboundPath,
      body,
      ip: "127.0.0.1",
      get(name: string) { return name === "X-Twilio-Signature" ? signature : undefined; }
    } as Partial<Request> as Request;
    const res = {
      status(code: number) { result.status = code; return this; },
      type(value: string) { result.type = value; return this; },
      send(value: unknown) { result.body = value; resolve(result); return this; },
      json(value: unknown) { result.body = value; resolve(result); return this; }
    } as Partial<Response> as Response;
    const next = (() => {
      result.nextCalled = true;
      communicationsController.inboundSms(req, res).catch(reject);
    }) as NextFunction;
    requireValidTwilioWebhook(req, res, next);
  });
};

const preference = () => ({
  id: "preference-1", user_id: userId, client_id: clientId, phone: "+13035550123", phone_normalized: "+13035550123",
  sms_transactional_enabled: true, sms_reminders_enabled: true, sms_marketing_enabled: true, sms_rebooking_enabled: true,
  opted_out_all_sms: false
});

describe("signed Twilio inbound SMS flow", () => {
  it("handles signed STOP, START, and HELP callbacks and preserves the safe START policy", async () => {
    const supabase = installMockSupabase({
      client_communication_preferences: [preference()], communication_events: [], communication_consent_events: [], sms_inbound_events: []
    });
    try {
      const stop = await invokeInbound({ From: "+13035550123", To: "+13035550999", Body: "STOP", MessageSid: "SM-stop" });
      assert.equal(stop.status, 200);
      assert.match(String(stop.body), /<Message>.*unsubscribed/);
      assert.equal(supabase.state.client_communication_preferences[0]?.opted_out_all_sms, true);

      const start = await invokeInbound({ From: "+13035550123", To: "+13035550999", Body: "START", MessageSid: "SM-start" });
      assert.match(String(start.body), /<Message>.*opted back in/);
      const updated = supabase.state.client_communication_preferences[0] ?? {};
      assert.equal(updated.sms_transactional_enabled, true);
      assert.equal(updated.sms_reminders_enabled, true);
      assert.equal(updated.sms_marketing_enabled, false);
      assert.equal(updated.sms_rebooking_enabled, false);

      const help = await invokeInbound({ From: "+13035550123", To: "+13035550999", Body: "HELP", MessageSid: "SM-help" });
      assert.match(String(help.body), /<Message>DripDesk sends appointment messages/);
      assert.deepEqual(
        supabase.state.communication_consent_events.map((event) => event.event_type),
        ["inbound_stop", "inbound_start", "inbound_help"]
      );
      assert.deepEqual(
        supabase.state.communication_events.map((event) => event.status),
        ["inbound_stop", "inbound_start", "inbound_help"]
      );
    } finally {
      supabase.restore();
    }
  });

  it("prefers OptOutType over Body and returns empty TwiML for Advanced Opt-Out", async () => {
    const supabase = installMockSupabase({
      client_communication_preferences: [preference()], communication_events: [], communication_consent_events: [], sms_inbound_events: []
    });
    try {
      const response = await invokeInbound({
        From: "+13035550123", To: "+13035550999", Body: "START", OptOutType: "STOP", MessageSid: "SM-provider-stop"
      });
      assert.equal(response.status, 200);
      assert.match(String(response.body), /<Response\/>/);
      assert.doesNotMatch(String(response.body), /<Message>/);
      assert.equal(supabase.state.client_communication_preferences[0]?.opted_out_all_sms, true);
      assert.equal(supabase.state.communication_events[0]?.status, "inbound_stop");
      assert.equal((supabase.state.communication_events[0]?.metadata as { provider_classified?: boolean }).provider_classified, true);
    } finally {
      supabase.restore();
    }
  });

  it("dedupes the same MessageSid while separately auditing distinct idempotent STOP callbacks", async () => {
    const supabase = installMockSupabase({
      client_communication_preferences: [preference()], communication_events: [], communication_consent_events: [], sms_inbound_events: []
    });
    try {
      const first = { From: "+13035550123", To: "+13035550999", Body: "STOP", MessageSid: "SM-stop-one" };
      await invokeInbound(first);
      const optedOutAt = supabase.state.client_communication_preferences[0]?.sms_opted_out_at;
      await invokeInbound(first);
      assert.equal(supabase.state.client_communication_preferences[0]?.sms_opted_out_at, optedOutAt);
      assert.equal(supabase.state.communication_events.length, 1);
      assert.equal(supabase.state.communication_consent_events.length, 1);

      await invokeInbound({ ...first, MessageSid: "SM-stop-two" });
      assert.equal(supabase.state.client_communication_preferences[0]?.opted_out_all_sms, true);
      assert.equal(supabase.state.communication_events.length, 2);
      assert.equal(supabase.state.communication_consent_events.length, 2);
    } finally {
      supabase.restore();
    }
  });

  it("rejects signed malformed callbacks without mutating preferences or writing audits", async () => {
    const supabase = installMockSupabase({
      client_communication_preferences: [preference()], communication_events: [], communication_consent_events: [], sms_inbound_events: []
    });
    try {
      await assert.rejects(() => invokeInbound({ To: "+13035550999", Body: "STOP", MessageSid: "SM-no-from" }), /valid From/);
      await assert.rejects(() => invokeInbound({ From: "+13035550123", To: "+13035550999", Body: "STOP" }), /MessageSid/);
      assert.equal(supabase.state.sms_inbound_events.length, 0);
      assert.equal(supabase.state.communication_events.length, 0);
      assert.equal(supabase.state.communication_consent_events.length, 0);
      assert.equal(supabase.state.client_communication_preferences[0]?.opted_out_all_sms, false);
    } finally {
      supabase.restore();
    }
  });
});
