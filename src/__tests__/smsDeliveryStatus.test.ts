import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = process.env.AUTH_MODE ?? "production";
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key";

const { installMockSupabase } = require("./helpers/mockSupabase") as typeof import("./helpers/mockSupabase");
const { smsDeliveryStatusService } =
  require("../services/smsDeliveryStatusService") as typeof import("../services/smsDeliveryStatusService");

describe("SMS delivery status service", () => {
  it("updates Twilio sent messages to delivered idempotently", async () => {
    const supabase = installMockSupabase({
      sms_messages: [{ id: "sms-1", user_id: "11111111-1111-1111-1111-111111111111", provider: "twilio", provider_message_id: "SM123", status: "sent", metadata: {} }],
      communication_events: []
    });
    try {
      assert.deepEqual(await smsDeliveryStatusService.applyTwilioStatus({ messageSid: "SM123", messageStatus: "delivered", to: "+13035550123" }), { updated: true });
      assert.equal(supabase.state.sms_messages[0]?.status, "delivered");
      assert.equal(supabase.state.communication_events.length, 1);
      assert.equal(supabase.state.communication_events[0]?.status, "delivered");
      assert.deepEqual(await smsDeliveryStatusService.applyTwilioStatus({ messageSid: "SM123", messageStatus: "delivered" }), { updated: false });
      assert.equal(supabase.state.communication_events.length, 1);
    } finally {
      supabase.restore();
    }
  });

  it("records Twilio delivery failures without making the message retryable", async () => {
    const supabase = installMockSupabase({
      sms_messages: [{ id: "sms-1", user_id: "11111111-1111-1111-1111-111111111111", provider: "twilio", provider_message_id: "SM123", status: "sent", metadata: {} }],
      communication_events: []
    });
    try {
      await smsDeliveryStatusService.applyTwilioStatus({ messageSid: "SM123", messageStatus: "undelivered", errorCode: "30003" });
      assert.equal(supabase.state.sms_messages[0]?.status, "failed");
      assert.equal(supabase.state.sms_messages[0]?.error_code, "twilio_30003");
      assert.equal(supabase.state.sms_messages[0]?.next_attempt_at, null);
      assert.equal(supabase.state.communication_events.length, 1);
      assert.equal(supabase.state.communication_events[0]?.status, "failed");
      assert.equal(supabase.state.communication_events[0]?.error_code, "twilio_30003");
      assert.deepEqual(await smsDeliveryStatusService.applyTwilioStatus({ messageSid: "SM123", messageStatus: "failed", errorCode: "30003" }), { updated: false });
      assert.equal(supabase.state.communication_events.length, 1);
    } finally {
      supabase.restore();
    }
  });

  it("maps accepted through sent callbacks to sent and retains informational status metadata", async () => {
    const supabase = installMockSupabase({
      sms_messages: [{ id: "sms-1", user_id: "11111111-1111-1111-1111-111111111111", provider: "twilio", provider_message_id: "SM123", status: "sending", metadata: {} }],
      communication_events: []
    });
    try {
      await smsDeliveryStatusService.applyTwilioStatus({ messageSid: "SM123", messageStatus: "accepted" });
      assert.equal(supabase.state.sms_messages[0]?.status, "sent");
      assert.equal(supabase.state.communication_events.length, 0);

      await smsDeliveryStatusService.applyTwilioStatus({
        messageSid: "SM123", messageStatus: "read", providerDiagnostics: { ChannelPrefix: "SMS" }
      });
      assert.equal(supabase.state.sms_messages[0]?.status, "sent");
      assert.equal((supabase.state.sms_messages[0]?.metadata as { twilio_last_status?: string }).twilio_last_status, "read");
    } finally {
      supabase.restore();
    }
  });

  it("acknowledges an unknown provider SID without updating an outbox row or audit trail", async () => {
    const supabase = installMockSupabase({ sms_messages: [], communication_events: [] });
    try {
      assert.deepEqual(await smsDeliveryStatusService.applyTwilioStatus({ messageSid: "SM-unknown", messageStatus: "delivered" }), { updated: false });
      assert.equal(supabase.state.communication_events.length, 0);
    } finally {
      supabase.restore();
    }
  });

  it("does not regress terminal delivery states with late callbacks, but reconciles unknown outcomes with final callbacks", async () => {
    const supabase = installMockSupabase({
      sms_messages: [
        { id: "delivered", user_id: "11111111-1111-1111-1111-111111111111", provider: "twilio", provider_message_id: "SM-delivered", status: "delivered", metadata: {} },
        { id: "failed", user_id: "11111111-1111-1111-1111-111111111111", provider: "twilio", provider_message_id: "SM-failed", status: "failed", metadata: {} },
        { id: "unknown", user_id: "11111111-1111-1111-1111-111111111111", provider: "twilio", provider_message_id: "SM-unknown", status: "unknown", metadata: {} }
      ],
      communication_events: []
    });
    try {
      assert.deepEqual(await smsDeliveryStatusService.applyTwilioStatus({ messageSid: "SM-delivered", messageStatus: "sent" }), { updated: false });
      assert.equal(supabase.state.sms_messages[0]?.status, "delivered");
      assert.deepEqual(await smsDeliveryStatusService.applyTwilioStatus({ messageSid: "SM-failed", messageStatus: "sent" }), { updated: false });
      assert.equal(supabase.state.sms_messages[1]?.status, "failed");
      assert.deepEqual(await smsDeliveryStatusService.applyTwilioStatus({ messageSid: "SM-unknown", messageStatus: "sent" }), { updated: false });
      assert.equal(supabase.state.sms_messages[2]?.status, "unknown");
      assert.deepEqual(await smsDeliveryStatusService.applyTwilioStatus({ messageSid: "SM-unknown", messageStatus: "delivered" }), { updated: true });
      assert.equal(supabase.state.sms_messages[2]?.status, "delivered");
      assert.equal(supabase.state.communication_events.length, 1);
    } finally {
      supabase.restore();
    }
  });

  it("stores bounded, sanitized provider failure diagnostics without raw callback payloads", async () => {
    const supabase = installMockSupabase({
      sms_messages: [{ id: "sms-1", user_id: "11111111-1111-1111-1111-111111111111", provider: "twilio", provider_message_id: "SM123", status: "sent", metadata: {} }],
      communication_events: []
    });
    try {
      await smsDeliveryStatusService.applyTwilioStatus({
        messageSid: "SM123", messageStatus: "undelivered", errorCode: "30003",
        errorMessage: "Unable to deliver to +13035550123 using AC11111111111111111111111111111111",
        providerDiagnostics: { ChannelPrefix: "SMS" }
      });
      assert.equal(supabase.state.sms_messages[0]?.error_code, "twilio_30003");
      assert.equal(supabase.state.sms_messages[0]?.error_message, "Unable to deliver to [redacted-phone] using [redacted-credential]");
      assert.deepEqual((supabase.state.sms_messages[0]?.metadata as { twilio_diagnostics?: unknown }).twilio_diagnostics, { ChannelPrefix: "SMS" });
    } finally {
      supabase.restore();
    }
  });

  it("falls back to twilio_undelivered when ErrorCode is not a safe bounded token", async () => {
    const supabase = installMockSupabase({
      sms_messages: [{ id: "sms-1", user_id: "11111111-1111-1111-1111-111111111111", provider: "twilio", provider_message_id: "SM123", status: "sent", metadata: {} }],
      communication_events: []
    });
    try {
      await smsDeliveryStatusService.applyTwilioStatus({
        messageSid: "SM123", messageStatus: "failed", errorCode: "x".repeat(65)
      });
      assert.equal(supabase.state.sms_messages[0]?.error_code, "twilio_undelivered");
      assert.equal(supabase.state.communication_events[0]?.error_code, "twilio_undelivered");
    } finally {
      supabase.restore();
    }
  });
});
