import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NextFunction, Request, Response } from "express";
import { getExpectedTwilioSignature } from "twilio";

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = "production";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
process.env.TWILIO_AUTH_TOKEN = "test-auth-token";
process.env.PUBLIC_API_BASE_URL = "https://shearsync-api-production.up.railway.app";
process.env.SMS_PROVIDER = "twilio";

const { requireValidTwilioWebhook } =
  require("../middleware/twilioWebhook") as typeof import("../middleware/twilioWebhook");

const body = { From: "+13035550123", To: "+13035550999", Body: "STOP", MessageSid: "SM123" };

const run = (originalUrl: string, signature?: string) => {
  let statusCode: number | undefined;
  let responseBody: unknown;
  let nextCalled = false;
  const req = {
    originalUrl,
    body,
    get(name: string) { return name === "X-Twilio-Signature" ? signature : undefined; }
  } as Partial<Request> as Request;
  const res = {
    status(code: number) { statusCode = code; return this; },
    json(value: unknown) { responseBody = value; return this; }
  } as Partial<Response> as Response;
  requireValidTwilioWebhook(req, res, (() => { nextCalled = true; }) as NextFunction);
  return { statusCode, responseBody, nextCalled };
};

describe("Twilio webhook middleware", () => {
  it("allows valid signed inbound and delivery-status callbacks", () => {
    const inboundUrl = "/api/communications/sms/inbound";
    const statusUrl = "/api/communications/sms/status";
    const signature = getExpectedTwilioSignature(
      "test-auth-token", `https://shearsync-api-production.up.railway.app${inboundUrl}`, body
    );
    const statusSignature = getExpectedTwilioSignature(
      "test-auth-token", `https://shearsync-api-production.up.railway.app${statusUrl}`, body
    );
    assert.deepEqual(run(inboundUrl, signature), { statusCode: undefined, responseBody: undefined, nextCalled: true });
    assert.deepEqual(run(statusUrl, statusSignature), { statusCode: undefined, responseBody: undefined, nextCalled: true });
  });

  it("rejects invalid and missing signatures for both callbacks before downstream controllers run", () => {
    for (const path of ["/api/communications/sms/inbound", "/api/communications/sms/status"]) {
      const invalid = run(path, "invalid");
      const missing = run(path);
      assert.equal(invalid.statusCode, 403);
      assert.equal(invalid.nextCalled, false);
      assert.equal(missing.statusCode, 403);
      assert.equal(missing.nextCalled, false);
    }
  });
});
