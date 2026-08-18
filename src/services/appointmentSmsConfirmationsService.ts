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

const defaultProcessLimit = 25;

export interface AppointmentSmsConfirmationProcessingResult {
  processed: number;
  queued: number;
  skipped: number;
  errors: number;
}

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const errorText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 2_000);

const retryDelayMinutes = (attemptCount: number): number => {
  if (attemptCount <= 1) return 1;
  if (attemptCount === 2) return 5;
  if (attemptCount === 3) return 20;
  return 60;
};

/**
 * Creates the provider-neutral outbox record for one scheduled appointment.
 * Its stable idempotency key makes an immediate attempt and the durable job
 * reconciler safe to run concurrently.
 */
export const queueAppointmentConfirmationSms = async (
  userId: string,
  appointment: Row
): Promise<"queued" | "skipped"> => {
  if (!env.SMS_APPOINTMENT_CONFIRMATIONS_ENABLED || appointment.status !== "scheduled") return "skipped";
  const appointmentId = text(appointment.id);
  const clientId = text(appointment.client_id);
  const appointmentDate = text(appointment.appointment_date);
  if (!appointmentId || !clientId || !appointmentDate) return "skipped";

  const [accountActive, accountSmsEnabled, client, user, timeZone] = await Promise.all([
    accountAccessService.isAccountActive(userId),
    smsDeliveryService.isAccountSmsDeliveryEnabled(userId),
    clientsService.getById(userId, clientId),
    supabaseAdmin.from("users").select("business_name, full_name").eq("id", userId).maybeSingle(),
    businessTimeZoneService.getForUser(userId)
  ]);
  handleSupabaseError(user.error, "Unable to load appointment SMS business identity");
  if (!accountActive || !accountSmsEnabled) return "skipped";
  const phone = text(client.phone);
  const firstName = text(client.first_name);
  const businessName = text(user.data?.business_name) ?? text(user.data?.full_name);
  if (!phone || !firstName || !businessName || !normalizePhone(phone)) return "skipped";

  const eligibility = await communicationPreferencesService.canSendCommunication({
    userId, clientId, channel: "sms", to: phone, messageType: "appointment_confirmation" as MessageType
  });
  if (!eligibility.canSend) return "skipped";
  const body = smsTemplatesService.renderAppointmentConfirmation({
    businessName,
    clientFirstName: firstName,
    appointmentDateTime: formatDateInTimeZone(new Date(appointmentDate), timeZone, {
      weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
    }),
    serviceName: text(appointment.service_name)
  });
  await smsDeliveryService.queueSms({
    userId, clientId, appointmentId, messageType: "appointment_confirmation", to: phone, body,
    idempotencyKey: `appointment-confirmation:${appointmentId}`,
    metadata: {
      template_type: "appointment_confirmation",
      appointment_id: appointmentId,
      management_link_included: false
    }
  });
  return "queued";
};

const finalizeJob = async (
  job: Row,
  status: "queued" | "skipped",
  now: Date
): Promise<void> => {
  const jobId = text(job.id);
  if (!jobId) return;
  const { error } = await supabaseAdmin
    .from("appointment_sms_confirmation_jobs")
    .update({
      status,
      attempt_count: Number(job.attempt_count ?? 0) + 1,
      last_attempt_at: now.toISOString(),
      next_attempt_at: null,
      completed_at: now.toISOString(),
      error_code: null,
      error_message: null
    })
    .eq("id", jobId)
    .eq("status", "pending");
  handleSupabaseError(error, "Unable to finalize appointment SMS confirmation job");
};

const recordJobFailure = async (job: Row, now: Date, error: unknown): Promise<void> => {
  const jobId = text(job.id);
  if (!jobId) return;
  const attemptCount = Number(job.attempt_count ?? 0) + 1;
  const { error: updateError } = await supabaseAdmin
    .from("appointment_sms_confirmation_jobs")
    .update({
      attempt_count: attemptCount,
      last_attempt_at: now.toISOString(),
      next_attempt_at: new Date(now.getTime() + retryDelayMinutes(attemptCount) * 60_000).toISOString(),
      error_code: "confirmation_queue_failed",
      error_message: errorText(error)
    })
    .eq("id", jobId)
    .eq("status", "pending");
  handleSupabaseError(updateError, "Unable to record appointment SMS confirmation job failure");
};

/** Drains the trigger-created job outbox. Failed work remains pending for the next trusted worker run. */
export const appointmentSmsConfirmationsService = {
  async processPendingConfirmations(
    options: { limit?: number; now?: Date } = {}
  ): Promise<AppointmentSmsConfirmationProcessingResult> {
    const result: AppointmentSmsConfirmationProcessingResult = { processed: 0, queued: 0, skipped: 0, errors: 0 };
    if (!env.SMS_APPOINTMENT_CONFIRMATIONS_ENABLED) return result;

    const now = options.now ?? new Date();
    const { data, error } = await supabaseAdmin
      .from("appointment_sms_confirmation_jobs")
      .select("*")
      .eq("status", "pending")
      .lte("next_attempt_at", now.toISOString())
      .order("created_at", { ascending: true })
      .limit(Math.max(1, options.limit ?? defaultProcessLimit));
    handleSupabaseError(error, "Unable to load appointment SMS confirmation jobs");

    for (const job of (data ?? []) as Row[]) {
      const jobId = text(job.id);
      const appointmentId = text(job.appointment_id);
      const userId = text(job.user_id);
      if (!jobId || !appointmentId || !userId) {
        result.errors += 1;
        continue;
      }

      result.processed += 1;
      try {
        const { data: appointment, error: appointmentError } = await supabaseAdmin
          .from("appointments")
          .select("*")
          .eq("id", appointmentId)
          .eq("user_id", userId)
          .maybeSingle();
        handleSupabaseError(appointmentError, "Unable to load appointment SMS confirmation job appointment");

        const outcome = appointment
          ? await queueAppointmentConfirmationSms(userId, appointment as Row)
          : "skipped";
        await finalizeJob(job, outcome, now);
        result[outcome] += 1;
      } catch (error) {
        try {
          await recordJobFailure(job, now, error);
        } catch {
          // Preserve the original failure result; the job remains pending either way.
        }
        result.errors += 1;
      }
    }

    return result;
  }
};
