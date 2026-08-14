import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = process.env.AUTH_MODE ?? "production";
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key";

const { parseTwilioInboundSms } = require("../lib/twilioInboundSms") as typeof import("../lib/twilioInboundSms");

describe("Twilio inbound SMS payload", () => {
  it("prefers Twilio OptOutType over the message body", () => {
    const payload = parseTwilioInboundSms({
      From: "303-555-0123", To: "+13035550999", Body: "this is not a keyword", MessageSid: "SM123", OptOutType: "STOP"
    });
    assert.equal(payload.fromNormalized, "+13035550123");
    assert.equal(payload.toNormalized, "+13035550999");
    assert.equal(payload.classification, "stop");
    assert.equal(payload.classificationSource, "twilio_opt_out_type");
  });

  it("falls back to the existing keyword vocabulary when OptOutType is absent", () => {
    const payload = parseTwilioInboundSms({ From: "+13035550123", Body: "unstop", MessageSid: "SM124" });
    assert.equal(payload.classification, "start");
    assert.equal(payload.classificationSource, "keyword_fallback");
  });

  it("rejects callback payloads without a valid sender or Twilio MessageSid", () => {
    assert.throws(() => parseTwilioInboundSms({ From: "invalid", MessageSid: "SM125" }), /valid From, To, and MessageSid/);
    assert.throws(() => parseTwilioInboundSms({ From: "+13035550123" }), /valid From, To, and MessageSid/);
    assert.throws(() => parseTwilioInboundSms({ From: "+13035550123", To: "invalid", MessageSid: "SM126" }), /valid From, To, and MessageSid/);
  });
});
