import { getAppEnvironment } from "../config/env";
import { sanitizeMetadata } from "../lib/safeMetadata";
import { supabaseAdmin } from "../lib/supabase";
import { handleSupabaseError, type Row, type RowList } from "./db";

export const NOTIFICATION_TYPES = [
  "booking_confirmation",
  "booking_request_received",
  "booking_approved",
  "booking_rejected",
  "appointment_reminder",
  "thank_you_email",
  "review_request",
  "rebook_nudge",
  "birthday_reminder",
  "waitlist_match",
  "account_email"
] as const;

export type NotificationType = typeof NOTIFICATION_TYPES[number];
export type NotificationChannel = "email" | "sms";
export type NotificationStatus = "queued" | "sent" | "failed" | "skipped";

export interface NotificationEventInput {
  accountUserId?: string | null;
  actorUserId?: string | null;
  clientId?: string | null;
  appointmentId?: string | null;
  notificationType: NotificationType;
  channel: NotificationChannel;
  status: NotificationStatus;
  provider?: string | null;
  providerMessageId?: string | null;
  providerErrorCode?: string | null;
  providerErrorMessage?: string | null;
  metadata?: unknown;
}

export interface NotificationRange {
  start: Date | string;
  end?: Date | string;
}

export interface NotificationQueueStatus {
  email: NotificationChannelStatus;
  sms: NotificationChannelStatus;
}

export interface NotificationChannelStatus {
  queued: number;
  sent: number;
  failed: number;
  skipped: number;
}

const PROVIDER_ERROR_MESSAGE_MAX_LENGTH = 500;

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

const toIso = (value: Date | string): string => value instanceof Date ? value.toISOString() : value;

const applyRange = <T extends { gte(column: string, value: unknown): T; lte(column: string, value: unknown): T }>(
  query: T,
  range: NotificationRange
): T => {
  let nextQuery = query.gte("created_at", toIso(range.start));
  if (range.end) {
    nextQuery = nextQuery.lte("created_at", toIso(range.end));
  }

  return nextQuery;
};

const countNotifications = async (
  range: NotificationRange,
  filters: { channel?: NotificationChannel; status?: NotificationStatus; accountUserId?: string }
): Promise<number> => {
  let query = supabaseAdmin
    .from("notification_events")
    .select("id", { count: "exact", head: true })
    .eq("environment", getAppEnvironment());

  query = applyRange(query, range);

  if (filters.channel) {
    query = query.eq("channel", filters.channel);
  }

  if (filters.status) {
    query = query.eq("status", filters.status);
  }

  if (filters.accountUserId) {
    query = query.eq("account_user_id", filters.accountUserId);
  }

  const { count, error } = await query;
  handleSupabaseError(error, "Unable to load notification event count");
  return count ?? 0;
};

const recordNotificationEvent = async (input: NotificationEventInput): Promise<Row> => {
  const { data, error } = await supabaseAdmin
    .from("notification_events")
    .insert({
      environment: getAppEnvironment(),
      account_user_id: normalizeNullableString(input.accountUserId),
      actor_user_id: normalizeNullableString(input.actorUserId),
      client_id: normalizeNullableString(input.clientId),
      appointment_id: normalizeNullableString(input.appointmentId),
      notification_type: input.notificationType,
      channel: input.channel,
      status: input.status,
      provider: normalizeNullableString(input.provider),
      provider_message_id: normalizeNullableString(input.providerMessageId),
      provider_error_code: normalizeNullableString(input.providerErrorCode),
      provider_error_message: normalizeNullableString(input.providerErrorMessage, PROVIDER_ERROR_MESSAGE_MAX_LENGTH),
      metadata: sanitizeMetadata(input.metadata ?? {})
    })
    .select("*")
    .single();

  handleSupabaseError(error, "Unable to record notification event");
  return data as Row;
};

export const notificationEventsService = {
  recordNotificationQueued(input: Omit<NotificationEventInput, "status">): Promise<Row> {
    return recordNotificationEvent({ ...input, status: "queued" });
  },

  recordNotificationSent(input: Omit<NotificationEventInput, "status">): Promise<Row> {
    return recordNotificationEvent({ ...input, status: "sent" });
  },

  recordNotificationFailed(input: Omit<NotificationEventInput, "status">): Promise<Row> {
    return recordNotificationEvent({ ...input, status: "failed" });
  },

  recordNotificationSkipped(input: Omit<NotificationEventInput, "status">): Promise<Row> {
    return recordNotificationEvent({ ...input, status: "skipped" });
  },

  async getQueueStatus(range: NotificationRange): Promise<NotificationQueueStatus> {
    const [emailQueued, emailSent, emailFailed, emailSkipped, smsQueued, smsSent, smsFailed, smsSkipped] =
      await Promise.all([
        countNotifications(range, { channel: "email", status: "queued" }),
        countNotifications(range, { channel: "email", status: "sent" }),
        countNotifications(range, { channel: "email", status: "failed" }),
        countNotifications(range, { channel: "email", status: "skipped" }),
        countNotifications(range, { channel: "sms", status: "queued" }),
        countNotifications(range, { channel: "sms", status: "sent" }),
        countNotifications(range, { channel: "sms", status: "failed" }),
        countNotifications(range, { channel: "sms", status: "skipped" })
      ]);

    return {
      email: {
        queued: emailQueued,
        sent: emailSent,
        failed: emailFailed,
        skipped: emailSkipped
      },
      sms: {
        queued: smsQueued,
        sent: smsSent,
        failed: smsFailed,
        skipped: smsSkipped
      }
    };
  },

  async getNotificationFailuresForAccount(accountUserId: string, range: NotificationRange): Promise<RowList> {
    let query = supabaseAdmin
      .from("notification_events")
      .select("*")
      .eq("environment", getAppEnvironment())
      .eq("account_user_id", accountUserId)
      .eq("status", "failed")
      .order("created_at", { ascending: false })
      .limit(50);

    query = applyRange(query, range);

    const { data, error } = await query;
    handleSupabaseError(error, "Unable to load notification failures");
    return (data ?? []) as RowList;
  },

  async getAutomationsSentCount(accountUserId: string, range: NotificationRange): Promise<number> {
    const automationTypes: NotificationType[] = [
      "appointment_reminder",
      "thank_you_email",
      "review_request",
      "rebook_nudge",
      "birthday_reminder",
      "waitlist_match"
    ];

    let query = supabaseAdmin
      .from("notification_events")
      .select("id", { count: "exact", head: true })
      .eq("environment", getAppEnvironment())
      .eq("account_user_id", accountUserId)
      .eq("status", "sent")
      .in("notification_type", automationTypes);

    query = applyRange(query, range);

    const { count, error } = await query;
    handleSupabaseError(error, "Unable to load automations sent count");
    return count ?? 0;
  }
};
