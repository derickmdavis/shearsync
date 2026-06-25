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
const { bookingErrorEventsService } =
  require("../services/bookingErrorEventsService") as typeof import("../services/bookingErrorEventsService");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT_ID = "22222222-2222-4222-8222-222222222222";
const APPOINTMENT_ID = "33333333-3333-4333-8333-333333333333";

describe("booking error events service", () => {
  it("records booking errors with environment, severity, and sanitized metadata", async () => {
    const db = installMockSupabase({ booking_error_events: [] });

    try {
      const event = await bookingErrorEventsService.recordBookingError({
        accountUserId: USER_ID,
        clientId: CLIENT_ID,
        appointmentId: APPOINTMENT_ID,
        stylistSlug: "maya-cuts",
        requestId: "request-1",
        sessionId: "session-1",
        anonymousId: "anonymous-1",
        step: "booking_submission",
        errorCode: "slot_unavailable",
        severity: "warning",
        errorMessage: "Selected slot is no longer available",
        metadata: {
          requested_datetime: "2026-06-24T10:00:00.000Z",
          guest_email: "client@example.com",
          manage_token: "secret-token",
          signed_url: "https://example.supabase.co/object/sign/file.png?token=secret"
        }
      });

      assert.ok(event);
      assert.equal(event.environment, "test");
      assert.equal(event.account_user_id, USER_ID);
      assert.equal(event.error_code, "slot_unavailable");
      assert.equal(event.severity, "warning");
      assert.deepEqual(event.metadata, {
        requested_datetime: "2026-06-24T10:00:00.000Z",
        guest_email: "[redacted]",
        manage_token: "[redacted]",
        signed_url: "[redacted]"
      });
    } finally {
      db.restore();
    }
  });

  it("counts recent booking errors for the active environment", async () => {
    const db = installMockSupabase({
      booking_error_events: [
        { id: "current", environment: "test", created_at: "2026-06-24T10:00:00.000Z" },
        { id: "old", environment: "test", created_at: "2026-06-20T10:00:00.000Z" },
        { id: "production", environment: "production", created_at: "2026-06-24T10:00:00.000Z" }
      ]
    });

    try {
      const count = await bookingErrorEventsService.countBookingErrors({
        start: "2026-06-24T00:00:00.000Z",
        end: "2026-06-25T00:00:00.000Z"
      });

      assert.equal(count, 1);
    } finally {
      db.restore();
    }
  });

  it("returns recent booking errors for an account", async () => {
    const db = installMockSupabase({
      booking_error_events: [
        {
          id: "match",
          environment: "test",
          account_user_id: USER_ID,
          created_at: "2026-06-24T10:00:00.000Z"
        },
        {
          id: "other-account",
          environment: "test",
          account_user_id: CLIENT_ID,
          created_at: "2026-06-24T10:00:00.000Z"
        }
      ]
    });

    try {
      const errors = await bookingErrorEventsService.getRecentBookingErrorsForAccount(USER_ID, {
        start: "2026-06-24T00:00:00.000Z",
        end: "2026-06-25T00:00:00.000Z"
      });

      assert.equal(errors.length, 1);
      assert.equal(errors[0]?.id, "match");
    } finally {
      db.restore();
    }
  });
});
