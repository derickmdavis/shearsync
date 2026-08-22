import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = process.env.AUTH_MODE ?? "production";
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key";

const { supabaseAdmin } = require("../lib/supabase") as typeof import("../lib/supabase");
const { installMockSupabase } = require("./helpers/mockSupabase") as typeof import("./helpers/mockSupabase");
const { accountDeletionProcessorService } =
  require("../services/accountDeletionProcessorService") as typeof import("../services/accountDeletionProcessorService");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";

const installStorageMock = () => mock.method(supabaseAdmin.storage, "from", () => ({
  list: async () => ({ data: [], error: null }),
  remove: async () => ({ data: [], error: null })
}));

describe("account deletion processor", () => {
  it("finalizes a due request, preserves anonymized audits, and does not touch another account", async () => {
    const db = installMockSupabase({
      users: [
        { id: USER_ID, email: "delete@example.com", account_status: "active" },
        { id: OTHER_USER_ID, email: "keep@example.com", account_status: "active" }
      ],
      stylists: [
        { id: "44444444-4444-4444-8444-444444444444", user_id: USER_ID, booking_enabled: true },
        { id: "55555555-5555-4555-8555-555555555555", user_id: OTHER_USER_ID, booking_enabled: true }
      ],
      account_deletion_requests: [{
        id: REQUEST_ID,
        user_id: USER_ID,
        status: "pending",
        scheduled_deletion_at: "2026-08-01T00:00:00.000Z"
      }],
      account_deletion_audit_events: [],
      account_deletion_retained_events: [],
      appointments: [{ id: "appointment", user_id: USER_ID, status: "completed", booking_source: "public", appointment_date: "2026-07-01T15:00:00.000Z", service_name: "Cut", duration_minutes: 60, price: 75 }],
      communication_events: [{ id: "communication", user_id: USER_ID, channel: "sms", message_type: "appointment_reminder", status: "sent", provider: "twilio", to_address: "+15555555555" }],
      referral_events: [{ id: "referral", user_id: USER_ID, event_type: "appointment_booked", source: "booking_page" }],
      api_request_logs: [{ id: "a", account_user_id: USER_ID, actor_user_id: USER_ID, path: "/api/clients/x", metadata: { client_name: "Jane" } }],
      booking_error_events: [{ id: "b", account_user_id: USER_ID, client_id: "client", appointment_id: "appointment", metadata: {} }],
      notification_events: [{ id: "c", account_user_id: USER_ID, client_id: "client", appointment_id: "appointment", metadata: {} }],
      product_events: [{ id: "d", account_user_id: USER_ID, client_id: "client", appointment_id: "appointment", metadata: {} }],
      admin_account_notes: [{ id: "e", account_user_id: USER_ID, user_id: USER_ID, note: "Contains PII", metadata: {} }],
      appointment_images: [], client_formula_images: [], payment_methods: [],
      rebook_nudges: [], birthday_reminders: [], appointment_email_events: [], sms_messages: [],
      appointment_sms_confirmation_jobs: [], thank_you_emails: [], campaigns: [], campaign_runs: [], campaign_recipients: []
    });
    const storageMock = installStorageMock();
    const deletedUsers: string[] = [];
    const deleteUserMock = mock.method(supabaseAdmin.auth.admin, "deleteUser", async (id: string) => {
      deletedUsers.push(id);
      return { data: { user: null }, error: null };
    });

    try {
      const result = await accountDeletionProcessorService.processDue({
        now: new Date("2026-08-08T00:00:00.000Z"),
        enabled: true,
        auditHashSecret: "test-account-deletion-audit-secret-0123456789"
      });

      assert.deepEqual(result, { processed: 1, completed: 1, failed: 0, skipped: 0 });
      assert.deepEqual(deletedUsers, [USER_ID]);
      assert.equal(db.state.account_deletion_requests[0].status, "completed");
      assert.equal(db.state.users.find((user) => user.id === USER_ID)?.account_status, "inactive");
      assert.equal(db.state.stylists.find((stylist) => stylist.user_id === USER_ID)?.booking_enabled, false);
      assert.equal(db.state.stylists.find((stylist) => stylist.user_id === OTHER_USER_ID)?.booking_enabled, true);
      assert.equal(db.state.api_request_logs[0].account_user_id, null);
      assert.equal(db.state.api_request_logs[0].path, "/redacted");
      assert.equal(db.state.notification_events[0].client_id, null);
      assert.equal(db.state.admin_account_notes[0].note, "[Deleted account support note]");
      assert.equal(typeof db.state.product_events[0].deleted_account_hash, "string");
      assert.equal(db.state.account_deletion_retained_events.length, 3);
      assert.deepEqual(db.state.account_deletion_retained_events[0].metadata, {
        booking_source: "public", service_name: "Cut", duration_minutes: 60, price: 75
      });
      assert.equal("to_address" in (db.state.account_deletion_retained_events[1].metadata as Record<string, unknown>), false);
    } finally {
      deleteUserMock.mock.restore();
      storageMock.mock.restore();
      db.restore();
    }
  });

  it("does not delete Auth when account-owned Storage cleanup fails", async () => {
    const db = installMockSupabase({
      users: [{ id: USER_ID, email: "delete@example.com", account_status: "active" }],
      stylists: [],
      account_deletion_requests: [{ id: REQUEST_ID, user_id: USER_ID, status: "pending", scheduled_deletion_at: "2026-08-01T00:00:00.000Z" }],
      appointment_images: [{ id: "image", user_id: USER_ID, storage_path: `users/${USER_ID}/image.jpg`, thumbnail_path: null }],
      client_formula_images: [], payment_methods: [], account_deletion_audit_events: [], account_deletion_retained_events: []
    });
    const storageMock = mock.method(supabaseAdmin.storage, "from", () => ({
      list: async () => ({ data: [], error: null }),
      remove: async () => ({ data: null, error: { message: "Storage unavailable", statusCode: 500 } })
    }));
    const deleteUserMock = mock.method(supabaseAdmin.auth.admin, "deleteUser", async () => ({ data: { user: null }, error: null }));

    try {
      const result = await accountDeletionProcessorService.processDue({
        now: new Date("2026-08-08T00:00:00.000Z"),
        enabled: true,
        auditHashSecret: "test-account-deletion-audit-secret-0123456789"
      });

      assert.deepEqual(result, { processed: 1, completed: 0, failed: 1, skipped: 0 });
      assert.equal(deleteUserMock.mock.callCount(), 0);
      assert.equal(db.state.account_deletion_requests[0].status, "failed_retryable");
    } finally {
      deleteUserMock.mock.restore();
      storageMock.mock.restore();
      db.restore();
    }
  });

  it("paginates retained audit records beyond one PostgREST response page", async () => {
    const queryLog: Array<{ table: string; operation: "range"; start: number; end: number }> = [];
    const db = installMockSupabase({
      account_deletion_retained_events: [],
      appointments: Array.from({ length: 501 }, (_, index) => ({
        id: `appointment-${String(index).padStart(3, "0")}`,
        user_id: USER_ID,
        status: "completed",
        booking_source: "public",
        appointment_date: "2026-07-01T15:00:00.000Z",
        service_name: "Cut",
        duration_minutes: 60,
        price: 75,
        created_at: "2026-07-01T15:00:00.000Z"
      }))
    }, { queryLog });

    try {
      const retained = await accountDeletionProcessorService.archiveRetainedEvents(
        USER_ID,
        REQUEST_ID,
        "audit-hash"
      );

      assert.equal(retained, 501);
      assert.equal(db.state.account_deletion_retained_events.length, 501);
      assert.deepEqual(
        queryLog.filter((entry) => entry.table === "appointments"),
        [
          { table: "appointments", operation: "range", start: 0, end: 499 },
          { table: "appointments", operation: "range", start: 500, end: 999 }
        ]
      );
    } finally {
      db.restore();
    }
  });
});
