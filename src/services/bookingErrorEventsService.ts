import { getAppEnvironment } from "../config/env";
import { sanitizeMetadata } from "../lib/safeMetadata";
import { supabaseAdmin } from "../lib/supabase";
import { handleSupabaseError, type Row, type RowList } from "./db";

export type BookingErrorSeverity = "info" | "warning" | "error" | "critical";

export const BOOKING_ERROR_STEPS = [
  "stylist_lookup",
  "availability_generation",
  "service_selection",
  "client_lookup",
  "booking_submission",
  "booking_approval",
  "booking_cancel",
  "booking_reschedule",
  "waitlist_submit",
  "reference_photo_upload"
] as const;

export const BOOKING_ERROR_CODES = [
  "slot_unavailable",
  "booking_validation_failed",
  "booking_conflict",
  "booking_insert_failed",
  "manage_link_invalid",
  "manage_link_expired",
  "reference_photo_upload_failed",
  "waitlist_create_failed"
] as const;

export type BookingErrorStep = typeof BOOKING_ERROR_STEPS[number];
export type BookingErrorCode = typeof BOOKING_ERROR_CODES[number];

export interface BookingErrorInput {
  accountUserId?: string | null;
  clientId?: string | null;
  appointmentId?: string | null;
  stylistSlug?: string | null;
  requestId?: string | null;
  sessionId?: string | null;
  anonymousId?: string | null;
  step: BookingErrorStep;
  errorCode: BookingErrorCode;
  severity: BookingErrorSeverity;
  errorMessage?: string | null;
  metadata?: unknown;
}

export interface BookingErrorRange {
  start: Date | string;
  end?: Date | string;
}

const ERROR_MESSAGE_MAX_LENGTH = 500;

const toIso = (value: Date | string): string => value instanceof Date ? value.toISOString() : value;

const normalizeNullableString = (value: string | null | undefined, maxLength = 200): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
};

const applyRange = <T extends { gte(column: string, value: unknown): T; lte(column: string, value: unknown): T }>(
  query: T,
  range: BookingErrorRange
): T => {
  let nextQuery = query.gte("created_at", toIso(range.start));
  if (range.end) {
    nextQuery = nextQuery.lte("created_at", toIso(range.end));
  }

  return nextQuery;
};

export const bookingErrorEventsService = {
  async recordBookingError(input: BookingErrorInput): Promise<Row | null> {
    try {
      const { data, error } = await supabaseAdmin
        .from("booking_error_events")
        .insert({
          environment: getAppEnvironment(),
          account_user_id: normalizeNullableString(input.accountUserId),
          client_id: normalizeNullableString(input.clientId),
          appointment_id: normalizeNullableString(input.appointmentId),
          stylist_slug: normalizeNullableString(input.stylistSlug),
          request_id: normalizeNullableString(input.requestId),
          session_id: normalizeNullableString(input.sessionId),
          anonymous_id: normalizeNullableString(input.anonymousId),
          step: input.step,
          error_code: input.errorCode,
          severity: input.severity,
          error_message: normalizeNullableString(input.errorMessage, ERROR_MESSAGE_MAX_LENGTH),
          metadata: sanitizeMetadata(input.metadata ?? {})
        })
        .select("*")
        .single();

      if (error) {
        throw error;
      }

      return data as Row;
    } catch (error) {
      if (process.env.NODE_ENV !== "test") {
        console.warn("[BOOKING_ERROR_EVENTS] record failed", {
          step: input.step,
          errorCode: input.errorCode,
          error: error instanceof Error ? error.message : String(error)
        });
      }

      return null;
    }
  },

  async countBookingErrors(range: BookingErrorRange): Promise<number> {
    let query = supabaseAdmin
      .from("booking_error_events")
      .select("id", { count: "exact", head: true })
      .eq("environment", getAppEnvironment());

    query = applyRange(query, range);

    const { count, error } = await query;
    handleSupabaseError(error, "Unable to load booking error count");
    return count ?? 0;
  },

  async getRecentBookingErrorsForAccount(accountUserId: string, range: BookingErrorRange): Promise<RowList> {
    let query = supabaseAdmin
      .from("booking_error_events")
      .select("*")
      .eq("environment", getAppEnvironment())
      .eq("account_user_id", accountUserId)
      .order("created_at", { ascending: false })
      .limit(50);

    query = applyRange(query, range);

    const { data, error } = await query;
    handleSupabaseError(error, "Unable to load booking errors");
    return (data ?? []) as RowList;
  }
};
