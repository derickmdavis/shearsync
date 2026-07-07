import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = process.env.AUTH_MODE ?? "production";
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key";
process.env.WEB_APP_URL = "https://dripdesk.example";

const { installMockSupabase } = require("./helpers/mockSupabase") as typeof import("./helpers/mockSupabase");
const { appointmentsService } =
  require("../services/appointmentsService") as typeof import("../services/appointmentsService");
const { referralLinksService } =
  require("../services/referralLinksService") as typeof import("../services/referralLinksService");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";
const REFERRER_CLIENT_ID = "33333333-3333-4333-8333-333333333333";
const REFERRED_CLIENT_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_CLIENT_ID = "55555555-5555-4555-8555-555555555555";
const REFERRAL_LINK_ID = "66666666-6666-4666-8666-666666666666";

const baseState = () => ({
  users: [
    {
      id: USER_ID,
      email: "stylist@example.com"
    },
    {
      id: OTHER_USER_ID,
      email: "other@example.com"
    }
  ],
  stylists: [
    {
      id: "77777777-7777-4777-8777-777777777777",
      user_id: USER_ID,
      slug: "maya",
      display_name: "Maya",
      booking_enabled: true
    }
  ],
  clients: [
    {
      id: REFERRER_CLIENT_ID,
      user_id: USER_ID,
      first_name: "Katie",
      last_name: "Morgan",
      phone: "(555) 123-0000",
      phone_normalized: "+15551230000",
      email: "katie@example.com",
      deleted_at: null
    },
    {
      id: REFERRED_CLIENT_ID,
      user_id: USER_ID,
      first_name: "Ari",
      last_name: "Lee",
      phone: "(555) 555-0000",
      phone_normalized: "+15555550000",
      email: "ari@example.com",
      deleted_at: null
    },
    {
      id: OTHER_CLIENT_ID,
      user_id: OTHER_USER_ID,
      first_name: "Other",
      last_name: "Client",
      deleted_at: null
    }
  ],
  client_referral_links: [
    {
      id: REFERRAL_LINK_ID,
      user_id: USER_ID,
      client_id: REFERRER_CLIENT_ID,
      referral_code: "rf_existing01",
      referral_url: "https://dripdesk.example/r/rf_existing01",
      status: "active",
      created_at: "2026-06-20T18:00:00.000Z",
      updated_at: "2026-06-20T18:00:00.000Z"
    }
  ],
  referral_events: [],
  appointments: [
    {
      id: "88888888-8888-4888-8888-888888888888",
      user_id: USER_ID,
      client_id: REFERRED_CLIENT_ID,
      service_name: "Cut",
      appointment_date: "2026-06-21T18:00:00.000Z",
      duration_minutes: 60,
      price: 95,
      status: "scheduled",
      referred_by_client_id: REFERRER_CLIENT_ID,
      referral_link_id: REFERRAL_LINK_ID,
      referral_code_used: "rf_existing01",
      acquisition_source: "client_referral_link",
      referral_attributed_at: "2026-06-20T18:30:00.000Z"
    },
    {
      id: "99999999-9999-4999-8999-999999999999",
      user_id: USER_ID,
      client_id: REFERRER_CLIENT_ID,
      service_name: "Color",
      appointment_date: "2026-06-22T18:00:00.000Z",
      duration_minutes: 90,
      price: 125,
      status: "scheduled",
      referred_by_client_id: REFERRER_CLIENT_ID,
      referral_link_id: REFERRAL_LINK_ID,
      referral_attributed_at: "2026-06-20T19:30:00.000Z"
    }
  ]
});

describe("referral links service", () => {
  it("returns an existing active referral link for a client", async () => {
    const supabase = installMockSupabase(baseState());

    try {
      const link = await referralLinksService.getOrCreateForClient(USER_ID, REFERRER_CLIENT_ID);

      assert.equal(link.id, REFERRAL_LINK_ID);
      assert.equal(link.referral_code, "rf_existing01");
      assert.equal(supabase.state.client_referral_links.length, 1);
    } finally {
      supabase.restore();
    }
  });

  it("creates a referral link for an owned client", async () => {
    const state = baseState();
    state.client_referral_links = [];
    const supabase = installMockSupabase(state);

    try {
      const link = await referralLinksService.getOrCreateForClient(USER_ID, REFERRER_CLIENT_ID);

      assert.equal(link.user_id, USER_ID);
      assert.equal(link.client_id, REFERRER_CLIENT_ID);
      assert.match(String(link.referral_code), /^rf_[0-9a-f]{12}$/);
      assert.equal(link.referral_url, `https://dripdesk.example/r/${link.referral_code}`);
      assert.equal(link.status, "active");
      assert.equal(link.source, "client_share");
      assert.equal(supabase.state.client_referral_links.length, 1);
    } finally {
      supabase.restore();
    }
  });

  it("stores the requested source when creating a referral link", async () => {
    const state = baseState();
    state.client_referral_links = [];
    const supabase = installMockSupabase(state);

    try {
      const link = await referralLinksService.getOrCreateForClient(USER_ID, REFERRER_CLIENT_ID, {
        source: "thank_you_email"
      });

      assert.equal(link.source, "thank_you_email");
      assert.equal(supabase.state.client_referral_links[0]?.source, "thank_you_email");
    } finally {
      supabase.restore();
    }
  });

  it("rejects referral links for another stylist's client", async () => {
    const supabase = installMockSupabase(baseState());

    try {
      await assert.rejects(
        () => referralLinksService.getOrCreateForClient(USER_ID, OTHER_CLIENT_ID),
        /Client does not belong to the authenticated user/
      );
    } finally {
      supabase.restore();
    }
  });

  it("resolves a public referral code and records an opened event", async () => {
    const supabase = installMockSupabase(baseState());

    try {
      const resolved = await referralLinksService.resolvePublicCode(
        "rf_existing01",
        new Date("2026-06-20T18:30:00.000Z")
      );

      assert.deepEqual(resolved, {
        referralLinkId: REFERRAL_LINK_ID,
        referralCode: "rf_existing01",
        referralUrl: "https://dripdesk.example/r/rf_existing01",
        stylistSlug: "maya",
        bookingUrl: "https://dripdesk.example/book/maya?ref=rf_existing01",
        expiresAt: "2026-07-20T18:30:00.000Z"
      });
      assert.equal(supabase.state.referral_events.length, 1);
      assert.equal(supabase.state.referral_events[0].event_type, "opened");
      assert.equal(supabase.state.referral_events[0].source, "unknown");
    } finally {
      supabase.restore();
    }
  });

  it("records public referral source when supplied by the frontend", async () => {
    const supabase = installMockSupabase(baseState());

    try {
      await referralLinksService.resolvePublicCode(
        "rf_existing01",
        new Date("2026-06-20T18:30:00.000Z"),
        { source: "thank_you_email" }
      );

      assert.equal(supabase.state.referral_events.length, 1);
      assert.equal(supabase.state.referral_events[0].event_type, "opened");
      assert.equal(supabase.state.referral_events[0].source, "thank_you_email");
      assert.equal(
        (supabase.state.referral_events[0].metadata as Record<string, unknown>).source,
        "thank_you_email"
      );
    } finally {
      supabase.restore();
    }
  });

  it("does not resolve disabled referral links", async () => {
    const state = baseState();
    state.client_referral_links[0].status = "disabled";
    const supabase = installMockSupabase(state);

    try {
      await assert.rejects(
        () => referralLinksService.resolvePublicCode("rf_existing01"),
        /Referral link not found/
      );
      assert.equal(supabase.state.referral_events.length, 0);
    } finally {
      supabase.restore();
    }
  });

  it("resolves valid booking attribution for a non-self referral", async () => {
    const supabase = installMockSupabase(baseState());

    try {
      const result = await referralLinksService.resolveAttributionForBooking({
        stylistId: USER_ID,
        referralCode: "rf_existing01",
        matchedClientId: REFERRED_CLIENT_ID,
        guestPhone: "+15555550000",
        guestEmail: "ari@example.com",
        now: new Date("2026-06-20T18:30:00.000Z")
      });

      assert.deepEqual(result, {
        attribution: {
          referralLinkId: REFERRAL_LINK_ID,
          referredByClientId: REFERRER_CLIENT_ID,
          referralCodeUsed: "rf_existing01",
          referralAttributedAt: "2026-06-20T18:30:00.000Z",
          acquisitionSource: "client_referral_link"
        }
      });
    } finally {
      supabase.restore();
    }
  });

  it("blocks self-referrals by matched client, phone, or email", async () => {
    const supabase = installMockSupabase(baseState());

    try {
      const byClient = await referralLinksService.resolveAttributionForBooking({
        stylistId: USER_ID,
        referralCode: "rf_existing01",
        matchedClientId: REFERRER_CLIENT_ID
      });
      const byPhone = await referralLinksService.resolveAttributionForBooking({
        stylistId: USER_ID,
        referralCode: "rf_existing01",
        guestPhone: "(555) 123-0000"
      });
      const byEmail = await referralLinksService.resolveAttributionForBooking({
        stylistId: USER_ID,
        referralCode: "rf_existing01",
        guestEmail: "KATIE@example.com"
      });

      assert.equal(byClient.blockedReason, "self_referral");
      assert.equal(byPhone.blockedReason, "self_referral");
      assert.equal(byEmail.blockedReason, "self_referral");
      assert.equal(supabase.state.referral_events.length, 3);
      assert.deepEqual(supabase.state.referral_events.map((event) => event.event_type), [
        "self_referral_blocked",
        "self_referral_blocked",
        "self_referral_blocked"
      ]);
    } finally {
      supabase.restore();
    }
  });

  it("returns lightweight referral stats for a client", async () => {
    const supabase = installMockSupabase(baseState());

    try {
      const stats = await referralLinksService.getClientReferralStats(USER_ID, REFERRER_CLIENT_ID);

      assert.equal(stats.clientId, REFERRER_CLIENT_ID);
      assert.equal(stats.referralCode, "rf_existing01");
      assert.equal(stats.referralUrl, "https://dripdesk.example/r/rf_existing01");
      assert.equal(stats.totalAttributedBookings, 2);
      assert.equal(stats.newClientConversions, 1);
      assert.equal(stats.existingClientUses, 1);
      assert.equal(stats.recentAppointments.length, 2);
    } finally {
      supabase.restore();
    }
  });

  it("records a referral completion event when an attributed appointment is completed", async () => {
    const supabase = installMockSupabase({
      ...baseState(),
      product_events: [],
      rebook_nudges: [],
      appointment_email_events: [],
      activity_events: [],
      services: []
    });

    try {
      const appointment = await appointmentsService.update(
        USER_ID,
        "88888888-8888-4888-8888-888888888888",
        { status: "completed" }
      );

      assert.equal(appointment.status, "completed");
      assert.equal(supabase.state.referral_events.length, 1);
      assert.equal(supabase.state.referral_events[0].event_type, "appointment_completed");
      assert.equal(supabase.state.referral_events[0].referral_link_id, REFERRAL_LINK_ID);
      assert.equal(supabase.state.referral_events[0].referred_by_client_id, REFERRER_CLIENT_ID);
      assert.equal(supabase.state.referral_events[0].referred_client_id, REFERRED_CLIENT_ID);
      assert.equal(supabase.state.referral_events[0].appointment_id, "88888888-8888-4888-8888-888888888888");
    } finally {
      supabase.restore();
    }
  });
});
