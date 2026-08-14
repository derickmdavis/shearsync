import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getExpectedTwilioSignature } from "twilio";

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = process.env.AUTH_MODE ?? "production";
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key";

const { getTwilioWebhookUrl, isValidTwilioWebhook } =
  require("../lib/twilioWebhook") as typeof import("../lib/twilioWebhook");

const authToken = "test-auth-token";
const baseUrl = "https://shearsync-api-production.up.railway.app";
const originalUrl = "/api/communications/sms/inbound?source=twilio";
const body = { From: "+13035550123", To: "+13035550999", Body: "STOP", MessageSid: "SM123" };
const url = `${baseUrl}${originalUrl}`;

describe("Twilio webhook validation utility", () => {
  it("validates a correctly signed form callback using the trusted public URL", () => {
    const signature = getExpectedTwilioSignature(authToken, url, body);
    assert.equal(isValidTwilioWebhook({ authToken, publicApiBaseUrl: baseUrl, signature, originalUrl, body }), true);
    assert.equal(getTwilioWebhookUrl(`${baseUrl}/`, originalUrl), url);
  });

  it("rejects an invalid or missing signature", () => {
    assert.equal(isValidTwilioWebhook({ authToken, publicApiBaseUrl: baseUrl, signature: "invalid", originalUrl, body }), false);
    assert.equal(isValidTwilioWebhook({ authToken, publicApiBaseUrl: baseUrl, originalUrl, body }), false);
  });

  it("fails closed when the callback body is not form parameters or the URL is untrusted", () => {
    assert.equal(isValidTwilioWebhook({ authToken, publicApiBaseUrl: undefined, signature: "signature", originalUrl, body }), false);
    assert.equal(isValidTwilioWebhook({ authToken, publicApiBaseUrl: baseUrl, signature: "signature", originalUrl, body: "From=+1303" }), false);
  });
});
