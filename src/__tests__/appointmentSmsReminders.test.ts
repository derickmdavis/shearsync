import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = process.env.AUTH_MODE ?? "production";
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key";

const { installMockSupabase } = require("./helpers/mockSupabase") as typeof import("./helpers/mockSupabase");
const { appointmentSmsRemindersService } = require("../services/appointmentSmsRemindersService") as typeof import("../services/appointmentSmsRemindersService");
const { clientsService } = require("../services/clientsService") as typeof import("../services/clientsService");
const { accountAccessService } = require("../services/accountAccessService") as typeof import("../services/accountAccessService");
const { communicationPreferencesService } = require("../services/communicationPreferences") as typeof import("../services/communicationPreferences");
const { smsDeliveryService } = require("../services/smsDeliveryService") as typeof import("../services/smsDeliveryService");
const { businessTimeZoneService } = require("../services/businessTimeZoneService") as typeof import("../services/businessTimeZoneService");
const { env } = require("../config/env") as typeof import("../config/env");

const USER_ID = "11111111-1111-1111-1111-111111111111";
const CLIENT_ID = "22222222-2222-2222-2222-222222222222";
const baseNow = new Date("2030-01-01T12:00:00.000Z");
const isoOffset = (minutes: number) => new Date(baseNow.getTime() + minutes * 60_000).toISOString();

describe("appointment SMS reminders", () => {
  it("uses a bounded centered 24-hour window and dedupes overlapping scheduler runs by appointment occurrence", async () => {
    const previous = env.SMS_APPOINTMENT_REMINDERS_ENABLED;
    const due = { id: "appointment-1", user_id: USER_ID, client_id: CLIENT_ID, status: "scheduled", appointment_date: isoOffset(24 * 60), service_name: "Haircut" };
    const supabase = installMockSupabase({
      users: [{ id: USER_ID, business_name: "Jordan Studio", full_name: "Jordan", sms_delivery_enabled: true }],
      appointments: [due,
        { ...due, id: "too-early", appointment_date: isoOffset(24 * 60 - 6) },
        { ...due, id: "too-late", appointment_date: isoOffset(24 * 60 + 6) },
        { ...due, id: "cancelled", status: "cancelled" },
        { ...due, id: "past", appointment_date: isoOffset(-60) }
      ],
      sms_messages: [], sms_template_settings: []
    });
    const restorers = [
      mock.method(accountAccessService, "isAccountActive", async () => true),
      mock.method(smsDeliveryService, "isAccountSmsDeliveryEnabled", async () => true),
      mock.method(clientsService, "getById", async () => ({ id: CLIENT_ID, user_id: USER_ID, first_name: "Maya", phone: "+15555550123" })),
      mock.method(communicationPreferencesService, "canSendCommunication", async () => ({ canSend: true, toNormalized: "+15555550123" })),
      mock.method(businessTimeZoneService, "getForUser", async () => "America/Denver")
    ];
    try {
      env.SMS_APPOINTMENT_REMINDERS_ENABLED = true;
      const first = await appointmentSmsRemindersService.processDueReminders({ now: baseNow });
      const second = await appointmentSmsRemindersService.processDueReminders({ now: baseNow });
      assert.deepEqual(first, { considered: 1, queued: 1, skipped: 0, errors: 0 });
      assert.deepEqual(second, { considered: 1, queued: 1, skipped: 0, errors: 0 });
      assert.equal(supabase.state.sms_messages.length, 1);
      assert.equal(supabase.state.sms_messages[0]?.idempotency_key, `appointment-reminder:appointment-1:${due.appointment_date}`);
      assert.equal((supabase.state.sms_messages[0]?.metadata as { appointment_start_at?: string }).appointment_start_at, due.appointment_date);
    } finally {
      env.SMS_APPOINTMENT_REMINDERS_ENABLED = previous;
      restorers.forEach((restore) => restore.mock.restore());
      supabase.restore();
    }
  });

  it("uses the changed UTC appointment start as a new reminder occurrence", async () => {
    const previous = env.SMS_APPOINTMENT_REMINDERS_ENABLED;
    const appointment = { id: "appointment-1", user_id: USER_ID, client_id: CLIENT_ID, status: "scheduled", appointment_date: isoOffset(24 * 60), service_name: "Haircut" };
    const supabase = installMockSupabase({ users: [{ id: USER_ID, business_name: "Jordan Studio", sms_delivery_enabled: true }], appointments: [appointment], sms_messages: [], sms_template_settings: [] });
    const restorers = [mock.method(accountAccessService, "isAccountActive", async () => true), mock.method(smsDeliveryService, "isAccountSmsDeliveryEnabled", async () => true), mock.method(clientsService, "getById", async () => ({ id: CLIENT_ID, first_name: "Maya", phone: "+15555550123" })), mock.method(communicationPreferencesService, "canSendCommunication", async () => ({ canSend: true, toNormalized: "+15555550123" })), mock.method(businessTimeZoneService, "getForUser", async () => "America/Denver")];
    try {
      env.SMS_APPOINTMENT_REMINDERS_ENABLED = true;
      await appointmentSmsRemindersService.processDueReminders({ now: baseNow });
      supabase.state.appointments[0].appointment_date = isoOffset(24 * 60 + 10);
      await appointmentSmsRemindersService.processDueReminders({ now: new Date(baseNow.getTime() + 10 * 60_000) });
      assert.equal(supabase.state.sms_messages.length, 2);
      assert.notEqual(supabase.state.sms_messages[0]?.idempotency_key, supabase.state.sms_messages[1]?.idempotency_key);
    } finally { env.SMS_APPOINTMENT_REMINDERS_ENABLED = previous; restorers.forEach((restore) => restore.mock.restore()); supabase.restore(); }
  });

  it("does not queue reminders for missing phones, absent consent, or opted-out clients", async () => {
    const previous = env.SMS_APPOINTMENT_REMINDERS_ENABLED;
    const appointments = ["no-phone", "no-consent", "opted-out"].map((client_id) => ({
      id: `appointment-${client_id}`, user_id: USER_ID, client_id, status: "scheduled",
      appointment_date: isoOffset(24 * 60), service_name: "Haircut"
    }));
    const supabase = installMockSupabase({
      users: [{ id: USER_ID, business_name: "Jordan Studio", sms_delivery_enabled: true }],
      appointments, sms_messages: [], sms_template_settings: []
    });
    const restorers = [
      mock.method(accountAccessService, "isAccountActive", async () => true),
      mock.method(smsDeliveryService, "isAccountSmsDeliveryEnabled", async () => true),
      mock.method(clientsService, "getById", async (_userId: string, clientId: string) => ({
        id: clientId, first_name: "Maya", phone: clientId === "no-phone" ? null : "+15555550123"
      })),
      mock.method(communicationPreferencesService, "canSendCommunication", async ({ clientId }: { clientId?: string | null }) => ({
        canSend: false,
        reason: clientId === "no-consent" ? "missing_sms_consent" : "opted_out_all_sms"
      })),
      mock.method(businessTimeZoneService, "getForUser", async () => "America/Denver")
    ];
    try {
      env.SMS_APPOINTMENT_REMINDERS_ENABLED = true;
      assert.deepEqual(await appointmentSmsRemindersService.processDueReminders({ now: baseNow }), {
        considered: 3, queued: 0, skipped: 3, errors: 0
      });
      assert.equal(supabase.state.sms_messages.length, 0);
    } finally {
      env.SMS_APPOINTMENT_REMINDERS_ENABLED = previous;
      restorers.forEach((restore) => restore.mock.restore());
      supabase.restore();
    }
  });
});
