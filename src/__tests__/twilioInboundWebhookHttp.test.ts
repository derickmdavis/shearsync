import assert from "node:assert/strict";
import type { Server } from "node:http";
import { describe, it } from "node:test";
import { getExpectedTwilioSignature } from "twilio";

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = "production";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
process.env.SMS_PROVIDER = "twilio";
process.env.TWILIO_AUTH_TOKEN = "test-auth-token";
process.env.PUBLIC_API_BASE_URL = "http://127.0.0.1";

const { installMockSupabase } = require("./helpers/mockSupabase") as typeof import("./helpers/mockSupabase");
const { app } = require("../app") as typeof import("../app");
const { env } = require("../config/env") as typeof import("../config/env");

const listen = (): Promise<Server> => new Promise((resolve) => {
  const server = app.listen(0, "127.0.0.1", () => resolve(server));
});

const close = (server: Server): Promise<void> => new Promise((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve());
});

describe("Twilio inbound HTTP webhook", () => {
  it("validates a signed application/x-www-form-urlencoded callback through Express", async () => {
    const supabase = installMockSupabase({
      client_communication_preferences: [{
        id: "preference-1", user_id: "11111111-1111-1111-1111-111111111111", phone: "+13035550123",
        phone_normalized: "+13035550123", sms_transactional_enabled: true, sms_reminders_enabled: true,
        sms_marketing_enabled: false, sms_rebooking_enabled: false, opted_out_all_sms: false
      }], communication_events: [], communication_consent_events: [], sms_inbound_events: []
    });
    const server = await listen();
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    const previousBaseUrl = env.PUBLIC_API_BASE_URL;
    env.PUBLIC_API_BASE_URL = baseUrl;
    try {
      const path = "/api/communications/sms/inbound";
      const fields = { From: "+13035550123", To: "+13035550999", Body: "STOP", MessageSid: "SM-http-form" };
      const signature = getExpectedTwilioSignature("test-auth-token", `${baseUrl}${path}`, fields);
      const response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature },
        body: new URLSearchParams(fields).toString()
      });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /<Message>.*unsubscribed/);
      assert.equal(supabase.state.client_communication_preferences[0]?.opted_out_all_sms, true);
      assert.equal(supabase.state.sms_inbound_events.length, 1);
    } finally {
      env.PUBLIC_API_BASE_URL = previousBaseUrl;
      await close(server);
      supabase.restore();
    }
  });

  it("returns 204 for a validly signed but malformed status callback without an outbox mutation", async () => {
    const supabase = installMockSupabase({ sms_messages: [], communication_events: [] });
    const server = await listen();
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    const previousBaseUrl = env.PUBLIC_API_BASE_URL;
    env.PUBLIC_API_BASE_URL = baseUrl;
    try {
      const path = "/api/communications/sms/status";
      const fields = { MessageStatus: "delivered" };
      const signature = getExpectedTwilioSignature("test-auth-token", `${baseUrl}${path}`, fields);
      const response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature },
        body: new URLSearchParams(fields).toString()
      });
      assert.equal(response.status, 204);
      assert.equal(supabase.state.communication_events.length, 0);
    } finally {
      env.PUBLIC_API_BASE_URL = previousBaseUrl;
      await close(server);
      supabase.restore();
    }
  });
});
