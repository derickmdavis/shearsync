import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NextFunction, Request, Response } from "express";

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = "production";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
process.env.SMS_PROVIDER = "twilio";
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.PUBLIC_API_BASE_URL;

const { requireValidTwilioWebhook } =
  require("../middleware/twilioWebhook") as typeof import("../middleware/twilioWebhook");

describe("Twilio webhook configuration", () => {
  it("fails closed when Twilio is selected without callback validation configuration", () => {
    let statusCode: number | undefined;
    let nextCalled = false;
    const req = {
      originalUrl: "/api/communications/sms/status",
      body: { MessageSid: "SM123", MessageStatus: "delivered" },
      get() { return "any-signature"; }
    } as unknown as Request;
    const res = {
      status(code: number) { statusCode = code; return this; },
      json() { return this; }
    } as Partial<Response> as Response;
    requireValidTwilioWebhook(req, res, (() => { nextCalled = true; }) as NextFunction);
    assert.equal(statusCode, 403);
    assert.equal(nextCalled, false);
  });
});
