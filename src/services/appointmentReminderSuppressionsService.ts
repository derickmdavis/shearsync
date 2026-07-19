import { ApiError } from "../lib/errors";
import { supabaseAdmin } from "../lib/supabase";
import type { Row } from "./db";
import { handleSupabaseError } from "./db";

const normalizeReason = (reason?: string | null): string | null => {
  const normalized = reason?.trim();
  return normalized ? normalized.slice(0, 500) : null;
};

const getErrorMessage = (error: unknown): string => {
  if (!error || typeof error !== "object") {
    return "";
  }

  const candidate = error as { message?: unknown; details?: unknown };
  return [candidate.message, candidate.details]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
};

export const appointmentReminderSuppressionsService = {
  async isSuppressed(userId: string, appointmentId: string, appointmentStartAt: string): Promise<boolean> {
    const { data, error } = await supabaseAdmin
      .from("appointment_reminder_suppressions")
      .select("id")
      .eq("user_id", userId)
      .eq("appointment_id", appointmentId)
      .eq("appointment_start_at", appointmentStartAt)
      .maybeSingle();

    handleSupabaseError(error, "Unable to validate appointment reminder suppression");
    return Boolean(data);
  },

  async listForOccurrences(
    userId: string,
    occurrences: Array<{ appointmentId: string; appointmentStartAt: string }>
  ): Promise<Set<string>> {
    const appointmentIds = [...new Set(occurrences.map((occurrence) => occurrence.appointmentId))];
    if (appointmentIds.length === 0) {
      return new Set();
    }

    const rows: Row[] = [];
    for (let index = 0; index < appointmentIds.length; index += 200) {
      const { data, error } = await supabaseAdmin
        .from("appointment_reminder_suppressions")
        .select("appointment_id, appointment_start_at")
        .eq("user_id", userId)
        .in("appointment_id", appointmentIds.slice(index, index + 200));

      handleSupabaseError(error, "Unable to load appointment reminder suppressions");
      rows.push(...((data ?? []) as Row[]));
    }

    return new Set(rows.map((row) =>
      `${String(row.appointment_id ?? "")}:${String(row.appointment_start_at ?? "")}`
    ));
  },

  async cancelOccurrence(
    userId: string,
    appointmentId: string,
    appointmentStartAt: string,
    reason?: string | null
  ): Promise<Row> {
    const { data, error } = await supabaseAdmin.rpc("cancel_appointment_reminder_occurrence", {
      p_user_id: userId,
      p_appointment_id: appointmentId,
      p_appointment_start_at: appointmentStartAt,
      p_reason: normalizeReason(reason)
    });

    if (error) {
      const message = getErrorMessage(error);
      if (message.includes("appointment_reminder_already_sending") || message.includes("appointment_reminder_already_sent")) {
        throw new ApiError(409, "Appointment reminder can no longer be cancelled");
      }

      if (message.includes("appointment_reminder_occurrence_not_found")) {
        throw new ApiError(404, "Scheduled appointment reminder not found");
      }

      handleSupabaseError(error, "Unable to cancel appointment reminder");
    }

    return (data ?? {}) as Row;
  }
};
