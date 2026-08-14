import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = process.env.AUTH_MODE ?? "production";
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key";

const { assertTwilioSmsProviderConfigured, createTwilioSmsProvider, SmsProviderError } =
  require("../services/twilioSmsProvider") as typeof import("../services/twilioSmsProvider");

const config = {
  accountSid: "AC11111111111111111111111111111111",
  apiKeySid: "SK11111111111111111111111111111111",
  apiKeySecret: "test-api-key-secret",
  messagingServiceSid: "MG11111111111111111111111111111111"
};

describe("Twilio SMS provider", () => {
  it("uses the Messaging Service and returns Twilio's message SID", async () => {
    let input: Record<string, string> | undefined;
    const provider = createTwilioSmsProvider(config, {
      messages: { async create(value) { input = value; return { sid: "SM11111111111111111111111111111111" }; } }
    });
    const result = await provider.send({ to: "+13035550123", body: "Appointment reminder", idempotencyKey: "message-1" });
    assert.deepEqual(input, {
      to: "+13035550123", body: "Appointment reminder", messagingServiceSid: config.messagingServiceSid
    });
    assert.deepEqual(result, { status: "sent", provider: "twilio", providerMessageId: "SM11111111111111111111111111111111" });
  });

  it("fails closed for incomplete Twilio configuration", () => {
    assert.throws(() => createTwilioSmsProvider({ ...config, messagingServiceSid: undefined }), /not fully configured/);
    assert.throws(() => assertTwilioSmsProviderConfigured(), /not fully configured/);
  });

  it("normalizes provider errors without exposing provider payloads", async () => {
    const provider = createTwilioSmsProvider(config, {
      messages: { async create() { throw { code: 21610, message: "sensitive provider detail" }; } }
    });
    await assert.rejects(
      () => provider.send({ to: "+13035550123", body: "Message", idempotencyKey: "message-2" }),
      (error) => error instanceof SmsProviderError && error.code === "twilio_21610" && error.message === "Twilio rejected the SMS request."
    );
  });
});
