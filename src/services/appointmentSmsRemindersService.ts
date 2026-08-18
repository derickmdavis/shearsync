import { env } from "../config/env";
import { normalizePhone, type MessageType } from "../lib/communications";
import { logger } from "../lib/logger";
import { formatDateInTimeZone } from "../lib/timezone";
import { supabaseAdmin } from "../lib/supabase";
import { accountAccessService } from "./accountAccessService";
import { businessTimeZoneService } from "./businessTimeZoneService";
import { clientsService } from "./clientsService";
import { communicationPreferencesService } from "./communicationPreferences";
import { handleSupabaseError, type Row } from "./db";
import { smsDeliveryService } from "./smsDeliveryService";
import { smsTemplatesService } from "./smsTemplatesService";

export const SMS_APPOINTMENT_REMINDER_WINDOW_HOURS = 24;
export const SMS_APPOINTMENT_REMINDER_SCAN_MINUTES = 10;

export interface ProcessAppointmentSmsRemindersOptions {
  now?: Date;
  scanMinutes?: number;
  limit?: number;
}

export interface AppointmentSmsReminderProcessingResult {
  considered: number;
  queued: number;
  skipped: number;
  errors: number;
}

const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;
const errorText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 2_000);

const recordReminderFailure = async (appointment: Row, now: Date, error: unknown): Promise<void> => {
  const appointmentId = text(appointment.id);
  const userId = text(appointment.user_id);
  const appointmentStartAt = text(appointment.appointment_date);
  if (!appointmentId || !userId || !appointmentStartAt) {
    logger.error("sms_appointment_reminder_failure_unpersistable", {
      appointmentId: appointmentId ?? null,
      userId: userId ?? null,
      error: error instanceof Error ? error.name : "unknown_error"
    });
    return;
  }
  const { error: persistenceError } = await supabaseAdmin.from("appointment_sms_reminder_failures").insert({
    appointment_id: appointmentId,
    user_id: userId,
    appointment_start_at: appointmentStartAt,
    error_code: error instanceof Error ? error.name.slice(0, 120) : "unknown_error",
    error_message: errorText(error),
    occurred_at: now.toISOString()
  });
  handleSupabaseError(persistenceError, "Unable to record SMS appointment reminder failure");
};

const queueReminderForAppointment = async (appointment: Row): Promise<"queued" | "skipped"> => {
  const userId = text(appointment.user_id);
  const clientId = text(appointment.client_id);
  const appointmentId = text(appointment.id);
  const appointmentDate = text(appointment.appointment_date);
  if (!userId || !clientId || !appointmentId || !appointmentDate || appointment.status !== "scheduled") return "skipped";

  const [accountActive, smsEnabled, client, user, timeZone] = await Promise.all([
    accountAccessService.isAccountActive(userId),
    smsDeliveryService.isAccountSmsDeliveryEnabled(userId),
    clientsService.getById(userId, clientId),
    supabaseAdmin.from("users").select("business_name, full_name").eq("id", userId).maybeSingle(),
    businessTimeZoneService.getForUser(userId)
  ]);
  if (user.error) handleSupabaseError(user.error, "Unable to load appointment reminder business identity");
  if (!accountActive || !smsEnabled) return "skipped";
  const phone = text(client.phone);
  const firstName = text(client.first_name);
  const businessName = text(user.data?.business_name) ?? text(user.data?.full_name);
  if (!phone || !normalizePhone(phone) || !firstName || !businessName) return "skipped";

  const eligibility = await communicationPreferencesService.canSendCommunication({
    userId, clientId, channel: "sms", to: phone, messageType: "appointment_reminder" as MessageType
  });
  if (!eligibility.canSend) return "skipped";
  const rendered = await smsTemplatesService.renderAppointmentReminderForUser(userId, {
    businessName,
    clientFirstName: firstName,
    appointmentDateTime: formatDateInTimeZone(new Date(appointmentDate), timeZone, {
      weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
    }),
    serviceName: text(appointment.service_name)
  });
  if (!rendered.enabled || !rendered.body) return "skipped";

  await smsDeliveryService.queueSms({
    userId, clientId, appointmentId, messageType: "appointment_reminder", to: phone, body: rendered.body,
    // The appointment occurrence makes overlapping scheduler runs idempotent.
    idempotencyKey: `appointment-reminder:${appointmentId}:${appointmentDate}`,
    metadata: {
      template_type: "appointment_reminder",
      appointment_id: appointmentId,
      // Persist the occurrence independently of the idempotency key so the worker can
      // reject a queued reminder after a reschedule.
      appointment_start_at: appointmentDate,
      reminder_window_hours: SMS_APPOINTMENT_REMINDER_WINDOW_HOURS
    }
  });
  return "queued";
};

/** Identifies appointments due in the fixed 24-hour reminder window and queues SMS only. */
export const appointmentSmsRemindersService = {
  async processDueReminders(options: ProcessAppointmentSmsRemindersOptions = {}): Promise<AppointmentSmsReminderProcessingResult> {
    const result: AppointmentSmsReminderProcessingResult = { considered: 0, queued: 0, skipped: 0, errors: 0 };
    if (!env.SMS_APPOINTMENT_REMINDERS_ENABLED) return result;
    const now = options.now ?? new Date();
    const scanMinutes = Math.max(1, options.scanMinutes ?? SMS_APPOINTMENT_REMINDER_SCAN_MINUTES);
    const target = new Date(now.getTime() + SMS_APPOINTMENT_REMINDER_WINDOW_HOURS * 60 * 60 * 1000);
    // Center a bounded overlap around the target so delayed scheduler runs do not miss reminders.
    const start = new Date(target.getTime() - Math.floor(scanMinutes / 2) * 60 * 1000);
    const end = new Date(start.getTime() + scanMinutes * 60 * 1000);
    // `limit` is deliberately a page size, not a total-work limit. A stable keyset
    // cursor drains the full static window without offset gaps as appointments change.
    const pageSize = Math.max(1, options.limit ?? 100);
    let cursor: { appointmentDate: string; appointmentId: string } | null = null;

    while (true) {
      let query = supabaseAdmin.from("appointments").select("*")
        .eq("status", "scheduled").not("client_id", "is", null)
        .gte("appointment_date", start.toISOString()).lt("appointment_date", end.toISOString())
        .order("appointment_date", { ascending: true }).order("id", { ascending: true })
        .limit(pageSize);
      if (cursor) {
        query = query.or(
          `appointment_date.gt.${cursor.appointmentDate},and(appointment_date.eq.${cursor.appointmentDate},id.gt.${cursor.appointmentId})`
        );
      }
      const { data, error } = await query;
      handleSupabaseError(error, "Unable to load SMS appointment reminders");
      const appointments = (data ?? []) as Row[];
      if (appointments.length === 0) break;

      for (const appointment of appointments) {
        result.considered += 1;
        try {
          if (await queueReminderForAppointment(appointment) === "queued") result.queued += 1;
          else result.skipped += 1;
        } catch (error) {
          result.errors += 1;
          try {
            await recordReminderFailure(appointment, now, error);
          } catch (persistenceError) {
            logger.error("sms_appointment_reminder_failure_persist_failed", {
              appointmentId: text(appointment.id),
              userId: text(appointment.user_id),
              error: persistenceError instanceof Error ? persistenceError.name : "unknown_error"
            });
          }
        }
      }

      const last = appointments[appointments.length - 1];
      const appointmentDate = last ? text(last.appointment_date) : null;
      const appointmentId = last ? text(last.id) : null;
      if (!appointmentDate || !appointmentId || appointments.length < pageSize) break;
      cursor = { appointmentDate, appointmentId };
    }
    return result;
  }
};
