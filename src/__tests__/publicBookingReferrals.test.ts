import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addDays, getCurrentLocalDate, zonedDateTimeToUtc } from "../lib/timezone";

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = process.env.AUTH_MODE ?? "production";
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key";
process.env.SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET ?? "test-public-booking-secret";

const { installMockSupabase } = require("./helpers/mockSupabase") as typeof import("./helpers/mockSupabase");
const { publicBookingsService } =
  require("../services/publicBookingsService") as typeof import("../services/publicBookingsService");
const { createPublicBookingSchema } =
  require("../validators/publicBookingValidators") as typeof import("../validators/publicBookingValidators");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const SERVICE_ID = "22222222-2222-4222-8222-222222222222";
const REFERRER_CLIENT_ID = "33333333-3333-4333-8333-333333333333";
const EXISTING_CLIENT_ID = "44444444-4444-4444-8444-444444444444";
const REFERRAL_LINK_ID = "55555555-5555-4555-8555-555555555555";
const REFERRAL_CODE = "rf_existing01";

const nextRequestedDateTime = (daysAhead: number): string => {
  const dateText = addDays(getCurrentLocalDate("UTC"), daysAhead);
  return zonedDateTimeToUtc(dateText, "UTC", 9, 0, 0, 0).toISOString();
};

const bookingRules = () => ({
  id: "rules-1",
  user_id: USER_ID,
  lead_time_hours: 0,
  same_day_booking_allowed: true,
  same_day_booking_cutoff: "23:59:00",
  max_booking_window_days: 90,
  cancellation_window_hours: 24,
  late_cancellation_fee_enabled: false,
  late_cancellation_fee_type: "flat",
  late_cancellation_fee_value: 0,
  allow_cancellation_after_cutoff: false,
  reschedule_window_hours: 24,
  max_reschedules: null,
  same_day_rescheduling_allowed: false,
  preserve_appointment_history: true,
  new_client_approval_required: false,
  new_client_booking_window_days: 90,
  restrict_services_for_new_clients: false,
  restricted_service_ids: []
});

const baseState = (requestedDateTime: string) => ({
  users: [
    {
      id: USER_ID,
      email: "maya@example.com",
      business_name: "Maya Johnson Hair",
      timezone: "UTC"
    }
  ],
  stylists: [
    {
      id: "stylist-1",
      user_id: USER_ID,
      slug: "maya-johnson",
      display_name: "Maya Johnson",
      booking_enabled: true
    }
  ],
  booking_rules: [bookingRules()],
  services: [
    {
      id: SERVICE_ID,
      user_id: USER_ID,
      name: "Silk Press",
      duration_minutes: 60,
      price: 95,
      is_active: true,
      is_default: false,
      sort_order: 1
    }
  ],
  availability: [
    {
      id: "availability-1",
      user_id: USER_ID,
      day_of_week: new Date(requestedDateTime).getUTCDay(),
      start_time: "09:00:00",
      end_time: "12:00:00",
      client_audience: "all",
      is_active: true
    }
  ],
  clients: [
    {
      id: REFERRER_CLIENT_ID,
      user_id: USER_ID,
      first_name: "Katie",
      last_name: "Morgan",
      email: "katie@example.com",
      phone: "(555) 123-0000",
      phone_normalized: "+15551230000",
      deleted_at: null
    }
  ],
  client_referral_links: [
    {
      id: REFERRAL_LINK_ID,
      user_id: USER_ID,
      client_id: REFERRER_CLIENT_ID,
      referral_code: REFERRAL_CODE,
      referral_url: `https://dripdesk.example/r/${REFERRAL_CODE}`,
      status: "active",
      created_at: "2026-06-20T18:00:00.000Z",
      updated_at: "2026-06-20T18:00:00.000Z"
    }
  ],
  appointments: [],
  referral_events: [],
  activity_events: [],
  automation_settings: [],
  appointment_email_events: [],
  rebook_nudges: [],
  stylist_off_days: []
});

const bookingPayload = (requestedDateTime: string, overrides: Record<string, unknown> = {}) =>
  createPublicBookingSchema.parse({
    stylist_slug: "maya-johnson",
    service_id: SERVICE_ID,
    requested_datetime: requestedDateTime,
    guest_first_name: "Ari",
    guest_last_name: "Lee",
    guest_email: "ari@example.com",
    guest_phone: "(555) 555-0000",
    referral_code: REFERRAL_CODE,
    ...overrides
  });

describe("public booking referral attribution", () => {
  it("stores referral attribution on a new referred client and appointment", async () => {
    const requestedDateTime = nextRequestedDateTime(7);
    const supabase = installMockSupabase(baseState(requestedDateTime));

    try {
      const confirmation = await publicBookingsService.create(bookingPayload(requestedDateTime));

      assert.equal(confirmation.status, "scheduled");
      assert.equal(supabase.state.clients.length, 2);
      const newClient = supabase.state.clients.find((client) => client.id !== REFERRER_CLIENT_ID);
      assert.ok(newClient);
      assert.equal(newClient.source, "referral");
      assert.equal(newClient.original_referral_link_id, REFERRAL_LINK_ID);
      assert.equal(newClient.original_referred_by_client_id, REFERRER_CLIENT_ID);
      assert.equal(newClient.original_referral_code, REFERRAL_CODE);
      assert.equal(newClient.original_acquisition_source, "client_referral_link");
      assert.equal(typeof newClient.original_referral_attributed_at, "string");

      assert.equal(supabase.state.appointments.length, 1);
      assert.equal(supabase.state.appointments[0]?.client_id, newClient.id);
      assert.equal(supabase.state.appointments[0]?.referral_link_id, REFERRAL_LINK_ID);
      assert.equal(supabase.state.appointments[0]?.referred_by_client_id, REFERRER_CLIENT_ID);
      assert.equal(supabase.state.appointments[0]?.referral_code_used, REFERRAL_CODE);
      assert.equal(supabase.state.appointments[0]?.acquisition_source, "client_referral_link");
      assert.equal(typeof supabase.state.appointments[0]?.referral_attributed_at, "string");

      assert.equal(supabase.state.referral_events.length, 1);
      assert.equal(supabase.state.referral_events[0]?.event_type, "booking_attributed");
      assert.equal(supabase.state.referral_events[0]?.appointment_id, supabase.state.appointments[0]?.id);
    } finally {
      supabase.restore();
    }
  });

  it("matches existing public booking clients by email before creating a new client", async () => {
    const requestedDateTime = nextRequestedDateTime(8);
    const state = baseState(requestedDateTime);
    state.clients.push({
      id: EXISTING_CLIENT_ID,
      user_id: USER_ID,
      first_name: "Ari",
      last_name: "Lee",
      email: "ari@example.com",
      phone: "(555) 000-9999",
      phone_normalized: "+15550009999",
      deleted_at: null
    });
    const supabase = installMockSupabase(state);

    try {
      await publicBookingsService.create(bookingPayload(requestedDateTime, {
        guest_phone: "(555) 888-0000"
      }));

      assert.equal(supabase.state.clients.length, 2);
      assert.equal(supabase.state.appointments.length, 1);
      assert.equal(supabase.state.appointments[0]?.client_id, EXISTING_CLIENT_ID);
      assert.equal(supabase.state.appointments[0]?.referral_link_id, REFERRAL_LINK_ID);
      assert.equal(supabase.state.referral_events[0]?.event_type, "booking_attributed");
    } finally {
      supabase.restore();
    }
  });

  it("allows booking but omits attribution for self-referrals", async () => {
    const requestedDateTime = nextRequestedDateTime(9);
    const supabase = installMockSupabase(baseState(requestedDateTime));

    try {
      await publicBookingsService.create(bookingPayload(requestedDateTime, {
        guest_first_name: "Katie",
        guest_last_name: "Morgan",
        guest_email: "katie@example.com",
        guest_phone: "(555) 123-0000"
      }));

      assert.equal(supabase.state.clients.length, 1);
      assert.equal(supabase.state.appointments.length, 1);
      assert.equal(supabase.state.appointments[0]?.client_id, REFERRER_CLIENT_ID);
      assert.equal(supabase.state.appointments[0]?.referral_link_id, undefined);
      assert.equal(supabase.state.appointments[0]?.referred_by_client_id, undefined);
      assert.equal(supabase.state.appointments[0]?.referral_code_used, undefined);
      assert.equal(supabase.state.referral_events.length, 1);
      assert.equal(supabase.state.referral_events[0]?.event_type, "self_referral_blocked");
      assert.equal(supabase.state.referral_events[0]?.appointment_id, null);
    } finally {
      supabase.restore();
    }
  });
});
