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
const { productEventsService } =
  require("../services/productEventsService") as typeof import("../services/productEventsService");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT_ID = "22222222-2222-4222-8222-222222222222";
const APPOINTMENT_ID = "33333333-3333-4333-8333-333333333333";

describe("product events service", () => {
  it("records a sanitized backend product event with environment", async () => {
    const db = installMockSupabase({ product_events: [] });

    try {
      const result = await productEventsService.recordProductEvent({
        accountUserId: USER_ID,
        actorUserId: USER_ID,
        clientId: CLIENT_ID,
        appointmentId: APPOINTMENT_ID,
        eventType: "Payment Shortcut Created",
        dedupeKey: `payment_shortcut_created:${APPOINTMENT_ID}`,
        metadata: {
          provider: "venmo",
          has_payment_url: true,
          payment_url: "https://venmo.com/example",
          qr_image_path: `${USER_ID}/file.png`
        }
      });

      assert.equal(result.inserted, true);
      assert.equal(result.deduped, false);
      assert.equal(db.state.product_events.length, 1);
      assert.equal(db.state.product_events[0]?.environment, "test");
      assert.equal(db.state.product_events[0]?.event_type, "payment_shortcut_created");
      assert.equal(db.state.product_events[0]?.event_source, "backend");
      assert.deepEqual(db.state.product_events[0]?.metadata, {
        provider: "venmo",
        has_payment_url: true,
        payment_url: "[redacted]",
        qr_image_path: "[redacted]"
      });
    } finally {
      db.restore();
    }
  });

  it("dedupes one-time events by environment, event type, and dedupe key", async () => {
    const db = installMockSupabase({
      product_events: [
        {
          id: "existing-event",
          environment: "test",
          event_type: "account_created",
          event_source: "backend",
          dedupe_key: `account_created:${USER_ID}`,
          metadata: {},
          created_at: "2026-06-24T00:00:00.000Z"
        }
      ]
    });

    try {
      const result = await productEventsService.recordProductEvent({
        accountUserId: USER_ID,
        eventType: "account_created",
        dedupeKey: `account_created:${USER_ID}`,
        metadata: {
          status: "created"
        }
      });

      assert.equal(result.inserted, false);
      assert.equal(result.deduped, true);
      assert.equal(result.event?.id, "existing-event");
      assert.equal(db.state.product_events.length, 1);
    } finally {
      db.restore();
    }
  });

  it("rejects unknown product event types", async () => {
    const db = installMockSupabase({ product_events: [] });

    try {
      await assert.rejects(
        () => productEventsService.recordProductEvent({
          eventType: "appointment_marked_paid"
        }),
        /Invalid product event type/
      );
      assert.equal(db.state.product_events.length, 0);
    } finally {
      db.restore();
    }
  });
});
