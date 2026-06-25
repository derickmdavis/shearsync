import { getAppEnvironment } from "../config/env";
import { ApiError } from "../lib/errors";
import { sanitizeMetadata, type SafeMetadata } from "../lib/safeMetadata";
import { supabaseAdmin } from "../lib/supabase";
import { handleSupabaseError, type Row } from "./db";

export const PRODUCT_EVENT_TYPES = [
  "user_opened_app",
  "account_created",
  "profile_updated",
  "booking_page_enabled",
  "booking_page_disabled",
  "service_created",
  "service_updated",
  "service_deleted",
  "business_hours_updated",
  "booking_settings_updated",
  "notification_settings_updated",
  "payment_shortcut_created",
  "payment_shortcut_updated",
  "payment_shortcut_disabled",
  "appointment_created",
  "appointment_completed",
  "appointment_cancelled",
  "appointment_rescheduled",
  "appointment_no_show",
  "booking_page_viewed",
  "public_booking_started",
  "public_booking_service_selected",
  "public_booking_date_selected",
  "public_booking_time_selected",
  "public_booking_client_info_started",
  "public_booking_submitted",
  "public_booking_submission_failed",
  "booking_approved",
  "booking_rejected",
  "client_created",
  "client_updated",
  "client_photo_added",
  "client_note_added",
  "automation_enabled",
  "automation_disabled",
  "automation_sent",
  "automation_failed",
  "automation_skipped",
  "payment_qr_shown",
  "payment_link_opened",
  "referral_link_created",
  "referral_qr_created",
  "referral_link_clicked",
  "referral_booking_started",
  "referral_booking_submitted",
  "referral_booking_completed",
  "waitlist_entry_created",
  "waitlist_match_found",
  "waitlist_notification_sent",
  "waitlist_opening_filled"
] as const;

export type ProductEventType = typeof PRODUCT_EVENT_TYPES[number];
export type ProductEventSource = "backend" | "frontend" | "public_booking" | "job" | "admin";

export interface RecordProductEventInput {
  accountUserId?: string | null;
  actorUserId?: string | null;
  clientId?: string | null;
  appointmentId?: string | null;
  eventType: string;
  eventSource?: ProductEventSource;
  stylistSlug?: string | null;
  anonymousId?: string | null;
  sessionId?: string | null;
  dedupeKey?: string | null;
  metadata?: unknown;
}

export interface RecordProductEventResult {
  inserted: boolean;
  deduped: boolean;
  event: Row | null;
}

const PRODUCT_EVENT_TYPE_SET = new Set<string>(PRODUCT_EVENT_TYPES);
const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]{1,79}$/;
const DEDUPE_KEY_MAX_LENGTH = 200;

const isUniqueViolation = (error: { code?: string } | null): boolean => error?.code === "23505";

const normalizeEventType = (eventType: string): ProductEventType => {
  const normalized = eventType.trim().toLowerCase().replace(/[\s-]+/g, "_");

  if (!EVENT_TYPE_PATTERN.test(normalized) || !PRODUCT_EVENT_TYPE_SET.has(normalized)) {
    throw new ApiError(400, "Invalid product event type", { eventType });
  }

  return normalized as ProductEventType;
};

const normalizeNullableString = (value: string | null | undefined): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const normalizeDedupeKey = (value: string | null | undefined): string | null => {
  const dedupeKey = normalizeNullableString(value);
  if (!dedupeKey) {
    return null;
  }

  if (dedupeKey.length > DEDUPE_KEY_MAX_LENGTH) {
    throw new ApiError(400, "Product event dedupe key is too long");
  }

  return dedupeKey;
};

const findExistingDedupeEvent = async (
  environment: string,
  eventType: ProductEventType,
  dedupeKey: string
): Promise<Row | null> => {
  const { data, error } = await supabaseAdmin
    .from("product_events")
    .select("id, environment, event_type, dedupe_key, created_at")
    .eq("environment", environment)
    .eq("event_type", eventType)
    .eq("dedupe_key", dedupeKey)
    .maybeSingle();

  handleSupabaseError(error, "Unable to validate product event uniqueness");
  return data as Row | null;
};

export const productEventsService = {
  async recordProductEvent(input: RecordProductEventInput): Promise<RecordProductEventResult> {
    const eventType = normalizeEventType(input.eventType);
    const eventSource = input.eventSource ?? "backend";
    const environment = getAppEnvironment();
    const dedupeKey = normalizeDedupeKey(input.dedupeKey);
    const metadata: SafeMetadata = sanitizeMetadata(input.metadata ?? {});

    if (dedupeKey) {
      const existing = await findExistingDedupeEvent(environment, eventType, dedupeKey);
      if (existing) {
        return {
          inserted: false,
          deduped: true,
          event: existing
        };
      }
    }

    const { data, error } = await supabaseAdmin
      .from("product_events")
      .insert({
        environment,
        account_user_id: normalizeNullableString(input.accountUserId),
        actor_user_id: normalizeNullableString(input.actorUserId),
        client_id: normalizeNullableString(input.clientId),
        appointment_id: normalizeNullableString(input.appointmentId),
        event_type: eventType,
        event_source: eventSource,
        stylist_slug: normalizeNullableString(input.stylistSlug),
        anonymous_id: normalizeNullableString(input.anonymousId),
        session_id: normalizeNullableString(input.sessionId),
        dedupe_key: dedupeKey,
        metadata
      })
      .select("*")
      .single();

    if (isUniqueViolation(error) && dedupeKey) {
      const existing = await findExistingDedupeEvent(environment, eventType, dedupeKey);
      return {
        inserted: false,
        deduped: true,
        event: existing
      };
    }

    handleSupabaseError(error, "Unable to record product event");

    return {
      inserted: true,
      deduped: false,
      event: data as Row
    };
  }
};
