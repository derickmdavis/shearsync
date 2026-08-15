import { env } from "../config/env";
import { normalizePhone, type MessageType } from "../lib/communications";
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
    const { data, error } = await supabaseAdmin.from("appointments").select("*")
      .eq("status", "scheduled").not("client_id", "is", null)
      .gte("appointment_date", start.toISOString()).lt("appointment_date", end.toISOString())
      .order("appointment_date", { ascending: true }).limit(Math.max(1, options.limit ?? 100));
    handleSupabaseError(error, "Unable to load SMS appointment reminders");
    for (const appointment of (data ?? []) as Row[]) {
      result.considered += 1;
      try {
        if (await queueReminderForAppointment(appointment) === "queued") result.queued += 1;
        else result.skipped += 1;
      } catch {
        result.errors += 1;
      }
    }
    return result;
  }
};
