import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NextFunction, Request, Response } from "express";

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = "production";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
process.env.SMS_PROVIDER = "none";
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.PUBLIC_API_BASE_URL;

const { requireValidTwilioWebhook } =
  require("../middleware/twilioWebhook") as typeof import("../middleware/twilioWebhook");

describe("Twilio webhook launch safety", () => {
  it("keeps inbound and delivery-status callback routes disabled while SMS_PROVIDER is none", () => {
    for (const originalUrl of ["/api/communications/sms/inbound", "/api/communications/sms/status"]) {
      let statusCode: number | undefined;
      let nextCalled = false;
      const req = {
        originalUrl,
        body: {},
        get() { return undefined; }
      } as Partial<Request> as Request;
      const res = {
        status(code: number) { statusCode = code; return this; },
        json() { return this; }
      } as Partial<Response> as Response;
      requireValidTwilioWebhook(req, res, (() => { nextCalled = true; }) as NextFunction);
      assert.equal(statusCode, 404);
      assert.equal(nextCalled, false);
    }
  });
});
