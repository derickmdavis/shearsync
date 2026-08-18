import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = process.env.AUTH_MODE ?? "production";
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key";

const { installMockSupabase } = require("./helpers/mockSupabase") as typeof import("./helpers/mockSupabase");
const { appointmentsService } = require("../services/appointmentsService") as typeof import("../services/appointmentsService");
const { clientsService } = require("../services/clientsService") as typeof import("../services/clientsService");
const { activityEventsService } = require("../services/activityEventsService") as typeof import("../services/activityEventsService");
const { accountAccessService } = require("../services/accountAccessService") as typeof import("../services/accountAccessService");
const { communicationPreferencesService } = require("../services/communicationPreferences") as typeof import("../services/communicationPreferences");
const { smsDeliveryService } = require("../services/smsDeliveryService") as typeof import("../services/smsDeliveryService");
const { businessTimeZoneService } = require("../services/businessTimeZoneService") as typeof import("../services/businessTimeZoneService");
const { appointmentSmsConfirmationsService } = require("../services/appointmentSmsConfirmationsService") as typeof import("../services/appointmentSmsConfirmationsService");
const { appointmentEmailEventsService } = require("../services/appointmentEmailEventsService") as typeof import("../services/appointmentEmailEventsService");
const { env } = require("../config/env") as typeof import("../config/env");

const USER_ID = "11111111-1111-1111-1111-111111111111";
const CLIENT_ID = "22222222-2222-2222-2222-222222222222";
const appointmentPayload = (status: "scheduled" | "pending" = "scheduled", appointmentDate = "2020-05-12T16:00:00.000Z") => ({
  client_id: CLIENT_ID, appointment_date: appointmentDate, duration_minutes: 60,
  service_name: "Haircut", status
});

const setup = (options: { phone?: string | null; eligible?: boolean } = {}) => {
  const supabase = installMockSupabase({
    users: [{ id: USER_ID, business_name: "Jordan Studio", full_name: "Jordan", sms_delivery_enabled: true }],
    appointments: [], sms_messages: [], product_events: []
  });
  const client = { id: CLIENT_ID, user_id: USER_ID, first_name: "Maya", phone: options.phone === undefined ? "+15555550123" : options.phone };
  const restorers = [
    mock.method(clientsService, "assertOwned", async () => undefined),
    mock.method(clientsService, "getById", async () => client),
    mock.method(activityEventsService, "recordBookingCreated", async () => undefined),
    mock.method(accountAccessService, "isAccountActive", async () => true),
    mock.method(smsDeliveryService, "isAccountSmsDeliveryEnabled", async () => true),
    mock.method(communicationPreferencesService, "canSendCommunication", async () => ({ canSend: options.eligible !== false, toNormalized: "+15555550123" })),
    mock.method(businessTimeZoneService, "getForUser", async () => "America/Denver")
  ];
  return { supabase, restore: () => { restorers.forEach((restore) => restore.mock.restore()); supabase.restore(); } };
};

describe("appointment SMS confirmations", () => {
  it("keeps flag-off and pending appointments out of the SMS outbox", async () => {
    const previous = env.SMS_APPOINTMENT_CONFIRMATIONS_ENABLED;
    const setupResult = setup();
    try {
      env.SMS_APPOINTMENT_CONFIRMATIONS_ENABLED = false;
      await appointmentsService.create(USER_ID, appointmentPayload());
      env.SMS_APPOINTMENT_CONFIRMATIONS_ENABLED = true;
      await appointmentsService.create(USER_ID, appointmentPayload("pending", "2020-05-12T18:00:00.000Z"));
      assert.equal(setupResult.supabase.state.sms_messages.length, 0);
    } finally {
      env.SMS_APPOINTMENT_CONFIRMATIONS_ENABLED = previous;
      setupResult.restore();
    }
  });

  it("queues one consented scheduled confirmation with an appointment-stable idempotency key while SMS_PROVIDER is none", async () => {
    const previous = { enabled: env.SMS_APPOINTMENT_CONFIRMATIONS_ENABLED, provider: env.SMS_PROVIDER };
    const setupResult = setup();
    try {
      env.SMS_APPOINTMENT_CONFIRMATIONS_ENABLED = true;
      env.SMS_PROVIDER = "none";
      const appointment = await appointmentsService.create(USER_ID, appointmentPayload());
      assert.equal(setupResult.supabase.state.sms_messages.length, 1);
      const message = setupResult.supabase.state.sms_messages[0]!;
      assert.equal(message.status, "queued");
      assert.equal(message.provider, undefined);
      assert.equal(message.idempotency_key, `appointment-confirmation:${appointment.id}`);
      assert.match(String(message.body), /^Jordan Studio: Hi Maya,/);
      assert.match(String(message.body), /Reply STOP to opt out\./);
      assert.match(String(message.body), /^[\x20-\x7E]{1,160}$/);
    } finally {
      env.SMS_APPOINTMENT_CONFIRMATIONS_ENABLED = previous.enabled;
      env.SMS_PROVIDER = previous.provider;
      setupResult.restore();
    }
  });

  it("does not queue for missing phone, missing consent, or an opted-out client", async () => {
    const previous = env.SMS_APPOINTMENT_CONFIRMATIONS_ENABLED;
    try {
      env.SMS_APPOINTMENT_CONFIRMATIONS_ENABLED = true;
      for (const options of [{ phone: null }, { eligible: false }]) {
        const setupResult = setup(options);
        await appointmentsService.create(USER_ID, appointmentPayload());
        assert.equal(setupResult.supabase.state.sms_messages.length, 0);
        setupResult.restore();
      }
    } finally {
      env.SMS_APPOINTMENT_CONFIRMATIONS_ENABLED = previous;
    }
  });

  it("queues an SMS confirmation when a pending appointment is accepted", async () => {
    const previous = env.SMS_APPOINTMENT_CONFIRMATIONS_ENABLED;
    const setupResult = setup();
    const emailQueue = mock.method(appointmentEmailEventsService, "queueAppointmentEmail", async () => ({} as never));
    try {
      env.SMS_APPOINTMENT_CONFIRMATIONS_ENABLED = true;
      const pending = await appointmentsService.create(USER_ID, appointmentPayload("pending"));
      const accepted = await appointmentsService.applyPendingDecision(USER_ID, String(pending.id), "accept");
      assert.equal(accepted.status, "scheduled");
      assert.equal(setupResult.supabase.state.sms_messages.length, 1);
      assert.equal(setupResult.supabase.state.sms_messages[0]?.idempotency_key, `appointment-confirmation:${pending.id}`);
    } finally {
      env.SMS_APPOINTMENT_CONFIRMATIONS_ENABLED = previous;
      emailQueue.mock.restore();
      setupResult.restore();
    }
  });

  it("retries a durable confirmation job after a transient queue failure", async () => {
    const previous = env.SMS_APPOINTMENT_CONFIRMATIONS_ENABLED;
    const setupResult = setup();
    const appointment = {
      id: "33333333-3333-3333-3333-333333333333", user_id: USER_ID,
      ...appointmentPayload("scheduled")
    };
    setupResult.supabase.state.appointments.push(appointment);
    setupResult.supabase.state.appointment_sms_confirmation_jobs = [{
      id: "44444444-4444-4444-4444-444444444444", appointment_id: appointment.id, user_id: USER_ID,
      status: "pending", attempt_count: 0, next_attempt_at: "2020-05-01T00:00:00.000Z", created_at: "2020-05-01T00:00:00.000Z"
    }];
    const queueFailure = mock.method(smsDeliveryService, "queueSms", async () => { throw new Error("queue unavailable"); });
    let queueFailureActive = true;
    try {
      env.SMS_APPOINTMENT_CONFIRMATIONS_ENABLED = true;
      const first = await appointmentSmsConfirmationsService.processPendingConfirmations({ now: new Date("2020-05-01T00:00:00.000Z") });
      assert.deepEqual(first, { processed: 1, queued: 0, skipped: 0, errors: 1 });
      assert.equal(setupResult.supabase.state.appointment_sms_confirmation_jobs[0]?.status, "pending");
      assert.equal(setupResult.supabase.state.appointment_sms_confirmation_jobs[0]?.attempt_count, 1);
      assert.equal(setupResult.supabase.state.appointment_sms_confirmation_jobs[0]?.next_attempt_at, "2020-05-01T00:01:00.000Z");
      queueFailure.mock.restore();
      queueFailureActive = false;

      const second = await appointmentSmsConfirmationsService.processPendingConfirmations({ now: new Date("2020-05-01T00:05:00.000Z") });
      assert.deepEqual(second, { processed: 1, queued: 1, skipped: 0, errors: 0 });
      assert.equal(setupResult.supabase.state.appointment_sms_confirmation_jobs[0]?.status, "queued");
      assert.equal(setupResult.supabase.state.sms_messages.length, 1);
    } finally {
      env.SMS_APPOINTMENT_CONFIRMATIONS_ENABLED = previous;
      if (queueFailureActive) queueFailure.mock.restore();
      setupResult.restore();
    }
  });

  it("keeps the appointment when the non-blocking queue follow-up fails", async () => {
    const previous = env.SMS_APPOINTMENT_CONFIRMATIONS_ENABLED;
    const setupResult = setup();
    const queueFailure = mock.method(smsDeliveryService, "queueSms", async () => { throw new Error("queue unavailable"); });
    const error = mock.method(console, "error", () => undefined);
    try {
      env.SMS_APPOINTMENT_CONFIRMATIONS_ENABLED = true;
      const appointment = await appointmentsService.create(USER_ID, appointmentPayload());
      assert.ok(appointment.id);
      assert.equal(setupResult.supabase.state.appointments.length, 1);
      assert.equal(setupResult.supabase.state.sms_messages.length, 0);
      assert.equal(error.mock.callCount(), 1);
    } finally {
      env.SMS_APPOINTMENT_CONFIRMATIONS_ENABLED = previous;
      error.mock.restore();
      queueFailure.mock.restore();
      setupResult.restore();
    }
  });
});
