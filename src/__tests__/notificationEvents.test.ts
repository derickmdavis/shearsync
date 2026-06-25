import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.NODE_ENV = "test";
process.env.APP_ENV = "test";
process.env.AUTH_MODE = process.env.AUTH_MODE ?? "production";
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key";

const { installMockSupabase } =
  require("./helpers/mockSupabase") as typeof import("./helpers/mockSupabase");
const { notificationEventsService } =
  require("../services/notificationEventsService") as typeof import("../services/notificationEventsService");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT_ID = "22222222-2222-4222-8222-222222222222";
const APPOINTMENT_ID = "33333333-3333-4333-8333-333333333333";

describe("notification events service", () => {
  it("records notification events with environment and sanitized metadata", async () => {
    const db = installMockSupabase({ notification_events: [] });

    try {
      const event = await notificationEventsService.recordNotificationFailed({
        accountUserId: USER_ID,
        clientId: CLIENT_ID,
        appointmentId: APPOINTMENT_ID,
        notificationType: "appointment_reminder",
        channel: "email",
        provider: "resend",
        providerMessageId: "msg_123",
        providerErrorCode: "rate_limited",
        providerErrorMessage: "x".repeat(700),
        metadata: {
          appointment_email_event_id: "email-event-1",
          recipient_email: "client@example.com",
          provider: "resend"
        }
      });

      assert.equal(event.environment, "test");
      assert.equal(event.status, "failed");
      assert.equal(event.provider_error_message, "x".repeat(500));
      assert.deepEqual(event.metadata, {
        appointment_email_event_id: "email-event-1",
        recipient_email: "[redacted]",
        provider: "resend"
      });
    } finally {
      db.restore();
    }
  });

  it("returns queue status by channel and status for the active environment", async () => {
    const db = installMockSupabase({
      notification_events: [
        { environment: "test", channel: "email", status: "queued", created_at: "2026-06-24T10:00:00.000Z" },
        { environment: "test", channel: "email", status: "sent", created_at: "2026-06-24T10:01:00.000Z" },
        { environment: "test", channel: "email", status: "failed", created_at: "2026-06-24T10:02:00.000Z" },
        { environment: "test", channel: "sms", status: "skipped", created_at: "2026-06-24T10:03:00.000Z" },
        { environment: "production", channel: "email", status: "failed", created_at: "2026-06-24T10:04:00.000Z" },
        { environment: "test", channel: "email", status: "failed", created_at: "2026-06-20T10:00:00.000Z" }
      ]
    });

    try {
      const status = await notificationEventsService.getQueueStatus({
        start: "2026-06-24T00:00:00.000Z",
        end: "2026-06-25T00:00:00.000Z"
      });

      assert.deepEqual(status, {
        email: {
          queued: 1,
          sent: 1,
          failed: 1,
          skipped: 0
        },
        sms: {
          queued: 0,
          sent: 0,
          failed: 0,
          skipped: 1
        }
      });
    } finally {
      db.restore();
    }
  });

  it("returns failures and automation sent counts for an account", async () => {
    const db = installMockSupabase({
      notification_events: [
        {
          id: "failed-1",
          environment: "test",
          account_user_id: USER_ID,
          notification_type: "appointment_reminder",
          channel: "email",
          status: "failed",
          created_at: "2026-06-24T10:00:00.000Z"
        },
        {
          id: "sent-1",
          environment: "test",
          account_user_id: USER_ID,
          notification_type: "birthday_reminder",
          channel: "email",
          status: "sent",
          created_at: "2026-06-24T11:00:00.000Z"
        },
        {
          id: "sent-confirmation",
          environment: "test",
          account_user_id: USER_ID,
          notification_type: "booking_confirmation",
          channel: "email",
          status: "sent",
          created_at: "2026-06-24T12:00:00.000Z"
        }
      ]
    });

    try {
      const range = {
        start: "2026-06-24T00:00:00.000Z",
        end: "2026-06-25T00:00:00.000Z"
      };
      const failures = await notificationEventsService.getNotificationFailuresForAccount(USER_ID, range);
      const automationsSent = await notificationEventsService.getAutomationsSentCount(USER_ID, range);

      assert.equal(failures.length, 1);
      assert.equal(failures[0]?.id, "failed-1");
      assert.equal(automationsSent, 1);
    } finally {
      db.restore();
    }
  });
});
