import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = process.env.AUTH_MODE ?? "production";
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key";
process.env.SMS_DELIVERY_ENABLED = "true";

const { installMockSupabase } = require("./helpers/mockSupabase") as typeof import("./helpers/mockSupabase");
const { smsDeliveryService } = require("../services/smsDeliveryService") as typeof import("../services/smsDeliveryService");
const { env } = require("../config/env") as typeof import("../config/env");
import type { SmsProvider } from "../services/smsDeliveryService";

const USER_ID = "11111111-1111-1111-1111-111111111111";
const CLIENT_ID = "22222222-2222-2222-2222-222222222222";

describe("smsDeliveryService", () => {
  it("queues idempotently and sends only explicitly opted-in recipients", async () => {
    const supabase = installMockSupabase({
      client_communication_preferences: [{
        id: "preference-1", user_id: USER_ID, client_id: CLIENT_ID, phone: "+13035550123",
        phone_normalized: "+13035550123", sms_opted_in_at: "2026-08-01T00:00:00.000Z",
        sms_transactional_enabled: true, sms_reminders_enabled: true, sms_marketing_enabled: false,
        sms_rebooking_enabled: false, opted_out_all_sms: false
      }],
      communication_events: []
    });
    const provider: SmsProvider = {
      async send(message) {
        assert.equal(message.to, "+13035550123");
        return { status: "sent", provider: "test-sms", providerMessageId: "SM123" };
      }
    };
    try {
      const first = await smsDeliveryService.queueSms({
        userId: USER_ID, clientId: CLIENT_ID, messageType: "appointment_reminder", to: "303-555-0123",
        body: "Reminder: your appointment is tomorrow.", idempotencyKey: "reminder:appointment-1"
      });
      const duplicate = await smsDeliveryService.queueSms({
        userId: USER_ID, clientId: CLIENT_ID, messageType: "appointment_reminder", to: "303-555-0123",
        body: "Reminder: your appointment is tomorrow.", idempotencyKey: "reminder:appointment-1"
      });
      assert.equal(duplicate.id, first.id);
      assert.equal(supabase.state.sms_messages.length, 1);

      const result = await smsDeliveryService.processQueuedSms({ provider });
      assert.deepEqual(result, { processed: 1, sent: 1, skipped: 0, failed: 0 });
      assert.equal(supabase.state.sms_messages[0]?.status, "sent");
      assert.equal(supabase.state.sms_messages[0]?.provider_message_id, "SM123");
      assert.equal(supabase.state.communication_events[0]?.status, "sent");
    } finally {
      supabase.restore();
    }
  });

  it("skips a queued text when consent is absent", async () => {
    const supabase = installMockSupabase({ client_communication_preferences: [], communication_events: [] });
    try {
      await smsDeliveryService.queueSms({
        userId: USER_ID, clientId: CLIENT_ID, messageType: "appointment_reminder", to: "+13035550123",
        body: "Reminder", idempotencyKey: "reminder:appointment-2"
      });
      const result = await smsDeliveryService.processQueuedSms({
        provider: { async send() { throw new Error("provider must not be called"); } },
        now: new Date()
      });
      assert.deepEqual(result, { processed: 1, sent: 0, skipped: 1, failed: 0 });
      assert.equal(supabase.state.sms_messages[0]?.status, "skipped");
      assert.equal(supabase.state.sms_messages[0]?.error_code, "missing_sms_consent");
      assert.equal(supabase.state.communication_events[0]?.status, "skipped_missing_consent");
    } finally {
      supabase.restore();
    }
  });

  it("records provider failures and retries them up to the configured limit", async () => {
    const supabase = installMockSupabase({
      client_communication_preferences: [{
        id: "preference-1", user_id: USER_ID, phone_normalized: "+13035550123", sms_opted_in_at: "2026-08-01T00:00:00.000Z",
        sms_transactional_enabled: true, sms_reminders_enabled: true, opted_out_all_sms: false
      }], communication_events: []
    });
    try {
      await smsDeliveryService.queueSms({
        userId: USER_ID, messageType: "appointment_reminder", to: "+13035550123", body: "Reminder", idempotencyKey: "reminder:appointment-3"
      });
      const failureProvider: SmsProvider = { async send() { throw new Error("provider unavailable"); } };
      const initialAttempt = new Date("2026-08-13T12:00:00.000Z");
      supabase.state.sms_messages[0]!.next_attempt_at = initialAttempt.toISOString();
      const first = await smsDeliveryService.processQueuedSms({ provider: failureProvider, maxAttempts: 2, now: initialAttempt });
      assert.equal(supabase.state.sms_messages[0]?.next_attempt_at, "2026-08-13T12:01:00.000Z");
      const second = await smsDeliveryService.processQueuedSms({
        provider: failureProvider, maxAttempts: 2, now: new Date("2026-08-13T12:01:00.000Z")
      });
      const third = await smsDeliveryService.processQueuedSms({
        provider: failureProvider, maxAttempts: 2, now: new Date("2026-08-13T12:10:00.000Z")
      });
      assert.equal(first.failed, 1);
      assert.equal(second.failed, 1);
      assert.equal(third.processed, 0);
      assert.equal(supabase.state.sms_messages[0]?.attempt_count, 2);
      assert.equal(supabase.state.sms_messages[0]?.status, "failed");
    } finally {
      supabase.restore();
    }
  });

  it("does not let a second worker claim a live lease", async () => {
    const supabase = installMockSupabase({
      client_communication_preferences: [{
        id: "preference-1", user_id: USER_ID, phone_normalized: "+13035550123", sms_opted_in_at: "2026-08-01T00:00:00.000Z",
        sms_transactional_enabled: true, sms_reminders_enabled: true, opted_out_all_sms: false
      }], communication_events: []
    });
    let releaseProvider: (() => void) | undefined;
    const provider: SmsProvider = {
      async send() {
        await new Promise<void>((resolve) => { releaseProvider = resolve; });
        return { status: "sent", provider: "test-sms", providerMessageId: "SM-lease" };
      }
    };
    try {
      await smsDeliveryService.queueSms({
        userId: USER_ID, messageType: "appointment_reminder", to: "+13035550123", body: "Reminder", idempotencyKey: "reminder:lease"
      });
      const firstWorker = smsDeliveryService.processQueuedSms({ provider, now: new Date() });
      await new Promise((resolve) => setImmediate(resolve));
      const secondWorker = await smsDeliveryService.processQueuedSms({ provider, now: new Date() });
      assert.deepEqual(secondWorker, { processed: 0, sent: 0, skipped: 0, failed: 0 });
      assert.ok(releaseProvider);
      releaseProvider?.();
      assert.equal((await firstWorker).sent, 1);
      assert.equal(supabase.state.sms_messages[0]?.lease_token, null);
    } finally {
      supabase.restore();
    }
  });

  it("permanently skips SMS for inactive accounts", async () => {
    const supabase = installMockSupabase({
      users: [{ id: USER_ID, account_status: "inactive", sms_delivery_enabled: true }],
      client_communication_preferences: [{
        id: "preference-1", user_id: USER_ID, phone_normalized: "+13035550123", sms_opted_in_at: "2026-08-01T00:00:00.000Z",
        sms_transactional_enabled: true, sms_reminders_enabled: true, opted_out_all_sms: false
      }], communication_events: []
    });
    try {
      await smsDeliveryService.queueSms({
        userId: USER_ID, messageType: "appointment_reminder", to: "+13035550123", body: "Reminder", idempotencyKey: "reminder:inactive"
      });
      const result = await smsDeliveryService.processQueuedSms({ provider: { async send() { throw new Error("must not send"); } } });
      assert.deepEqual(result, { processed: 1, sent: 0, skipped: 1, failed: 0 });
      assert.equal(supabase.state.sms_messages[0]?.status, "skipped");
      assert.equal(supabase.state.sms_messages[0]?.error_code, "account_inactive");
    } finally {
      supabase.restore();
    }
  });

  it("recovers an expired lease and honors the per-account kill switch", async () => {
    const supabase = installMockSupabase({
      users: [{ id: USER_ID, account_status: "active", sms_delivery_enabled: false }],
      client_communication_preferences: [{
        id: "preference-1", user_id: USER_ID, phone_normalized: "+13035550123", sms_opted_in_at: "2026-08-01T00:00:00.000Z",
        sms_transactional_enabled: true, sms_reminders_enabled: true, opted_out_all_sms: false
      }], communication_events: []
    });
    try {
      await smsDeliveryService.queueSms({
        userId: USER_ID, messageType: "appointment_reminder", to: "+13035550123", body: "Reminder", idempotencyKey: "reminder:account-kill"
      });
      const firstResult = await smsDeliveryService.processQueuedSms({ provider: { async send() { throw new Error("must not send"); } } });
      assert.equal(firstResult.skipped, 1);
      assert.equal(supabase.state.sms_messages[0]?.error_code, "account_sms_delivery_disabled");

      supabase.state.users[0]!.sms_delivery_enabled = true;
      supabase.state.sms_messages[0] = {
        ...supabase.state.sms_messages[0], status: "sending", lease_token: "00000000-0000-0000-0000-000000000001",
        lease_expires_at: "2026-08-13T11:59:00.000Z", next_attempt_at: "2026-08-13T11:00:00.000Z", attempt_count: 1
      };
      const recovered = await smsDeliveryService.processQueuedSms({
        now: new Date("2026-08-13T12:00:00.000Z"), provider: { async send() { return { status: "sent", provider: "test-sms" }; } }
      });
      assert.equal(recovered.sent, 1);
      assert.equal(supabase.state.sms_messages[0]?.lease_token, null);
      assert.equal(supabase.state.sms_messages[0]?.status, "sent");
    } finally {
      supabase.restore();
    }
  });

  it("marks an ambiguous provider timeout unknown instead of retrying it", async () => {
    const supabase = installMockSupabase({
      client_communication_preferences: [{
        id: "preference-1", user_id: USER_ID, phone_normalized: "+13035550123", sms_opted_in_at: "2026-08-01T00:00:00.000Z",
        sms_transactional_enabled: true, sms_reminders_enabled: true, opted_out_all_sms: false
      }], communication_events: []
    });
    try {
      await smsDeliveryService.queueSms({
        userId: USER_ID, messageType: "appointment_reminder", to: "+13035550123", body: "Reminder", idempotencyKey: "reminder:timeout"
      });
      supabase.state.sms_messages[0]!.next_attempt_at = "2026-08-13T12:00:00.000Z";
      const result = await smsDeliveryService.processQueuedSms({
        provider: { async send() { return new Promise(() => undefined); } },
        providerTimeoutMs: 5,
        leaseRenewalMs: 1_000,
        now: new Date("2026-08-13T12:00:00.000Z")
      });
      assert.equal(result.failed, 1);
      assert.equal(supabase.state.sms_messages[0]?.status, "unknown");
      assert.equal(supabase.state.sms_messages[0]?.next_attempt_at, null);
      assert.equal(supabase.state.sms_messages[0]?.error_code, "provider_timeout_ambiguous");
    } finally {
      supabase.restore();
    }
  });

  it("processes an eligible newer message even when older retries are delayed", async () => {
    const now = new Date("2026-08-13T12:00:00.000Z");
    const delayed = Array.from({ length: 8 }, (_, index) => ({
      id: `delayed-${index}`, user_id: USER_ID, message_type: "appointment_reminder", recipient_phone: "+13035550123",
      recipient_phone_normalized: "+13035550123", body: "Delayed", idempotency_key: `delayed-${index}`, status: "failed",
      attempt_count: 1, next_attempt_at: "2026-08-13T13:00:00.000Z", created_at: `2026-08-13T10:0${index}:00.000Z`
    }));
    const supabase = installMockSupabase({
      sms_messages: [...delayed, {
        id: "eligible", user_id: USER_ID, message_type: "appointment_reminder", recipient_phone: "+13035550123",
        recipient_phone_normalized: "+13035550123", body: "Ready", idempotency_key: "ready", status: "queued",
        attempt_count: 0, next_attempt_at: now.toISOString(), created_at: "2026-08-13T11:00:00.000Z"
      }],
      client_communication_preferences: [{ id: "preference-1", user_id: USER_ID, phone_normalized: "+13035550123", sms_opted_in_at: "2026-08-01T00:00:00.000Z", sms_transactional_enabled: true, sms_reminders_enabled: true, opted_out_all_sms: false }],
      communication_events: []
    });
    try {
      const result = await smsDeliveryService.processQueuedSms({
        limit: 1, now, provider: { async send() { return { status: "sent", provider: "test-sms" }; } }
      });
      assert.equal(result.sent, 1);
      assert.equal(supabase.state.sms_messages.find((message) => message.id === "eligible")?.status, "sent");
      assert.ok(supabase.state.sms_messages.filter((message) => String(message.id).startsWith("delayed-")).every((message) => message.status === "failed"));
    } finally {
      supabase.restore();
    }
  });

  it("preflights incomplete Twilio configuration before claiming queued messages", async () => {
    const supabase = installMockSupabase({
      sms_messages: [{ id: "queued", user_id: USER_ID, message_type: "appointment_reminder", recipient_phone: "+13035550123", status: "queued", attempt_count: 0, next_attempt_at: new Date().toISOString() }]
    });
    const previous = { provider: env.SMS_PROVIDER, accountSid: env.TWILIO_ACCOUNT_SID, apiKeySid: env.TWILIO_API_KEY_SID, apiKeySecret: env.TWILIO_API_KEY_SECRET, messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID };
    try {
      env.SMS_PROVIDER = "twilio";
      env.TWILIO_ACCOUNT_SID = undefined;
      env.TWILIO_API_KEY_SID = undefined;
      env.TWILIO_API_KEY_SECRET = undefined;
      env.TWILIO_MESSAGING_SERVICE_SID = undefined;
      await assert.rejects(() => smsDeliveryService.processQueuedSms(), /not fully configured/);
      assert.equal(supabase.state.sms_messages[0]?.status, "queued");
      assert.equal(supabase.state.sms_messages[0]?.attempt_count, 0);
    } finally {
      env.SMS_PROVIDER = previous.provider;
      env.TWILIO_ACCOUNT_SID = previous.accountSid;
      env.TWILIO_API_KEY_SID = previous.apiKeySid;
      env.TWILIO_API_KEY_SECRET = previous.apiKeySecret;
      env.TWILIO_MESSAGING_SERVICE_SID = previous.messagingServiceSid;
      supabase.restore();
    }
  });

  it("reports unknown delivery outcomes separately from retryable failures", async () => {
    const supabase = installMockSupabase({
      sms_messages: [
        { id: "queued", status: "queued", created_at: "2026-08-13T11:00:00.000Z" },
        { id: "failed", status: "failed" },
        { id: "unknown", status: "unknown" }
      ]
    });
    try {
      assert.deepEqual(await smsDeliveryService.getSmsQueueMetrics(new Date("2026-08-13T12:00:00.000Z")), {
        pendingCount: 1,
        failedCount: 1,
        unknownCount: 1,
        lagSeconds: 3600,
        oldestQueuedAt: "2026-08-13T11:00:00.000Z"
      });
    } finally {
      supabase.restore();
    }
  });
});
