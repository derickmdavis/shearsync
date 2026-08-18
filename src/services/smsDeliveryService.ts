import { randomUUID } from "crypto";
import { env } from "../config/env";
import { ApiError } from "../lib/errors";
import { logger } from "../lib/logger";
import { normalizePhone, type MessageType } from "../lib/communications";
import { supabaseAdmin } from "../lib/supabase";
import type { Row, RowList } from "./db";
import { handleSupabaseError } from "./db";
import { communicationEventsService } from "./communicationEvents";
import { communicationPreferencesService } from "./communicationPreferences";
import { accountAccessService } from "./accountAccessService";
import { assertTwilioSmsProviderConfigured, createTwilioSmsProvider, SmsProviderError } from "./twilioSmsProvider";

const defaultProcessLimit = 25;
const defaultMaxAttempts = 4;
const defaultLeaseMinutes = 5;
const defaultProviderTimeoutMs = 120_000;
const defaultLeaseRenewalMs = 60_000;

export interface SmsMessage {
  to: string;
  body: string;
  /** Queue-level deduplication key; Twilio does not receive this value. */
  idempotencyKey: string;
}

export interface SmsProviderResult {
  status: "sent" | "skipped";
  provider: string;
  providerMessageId?: string;
  error?: string;
}

export interface SmsProvider {
  send(message: SmsMessage): Promise<SmsProviderResult>;
}

export interface QueueSmsOptions {
  userId: string;
  clientId?: string | null;
  appointmentId?: string | null;
  messageType: MessageType;
  to: string;
  body: string;
  idempotencyKey: string;
  metadata?: Row;
}

export interface ProcessSmsOptions {
  limit?: number;
  provider?: SmsProvider;
  allowNoopProvider?: boolean;
  now?: Date;
  maxAttempts?: number;
  leaseMinutes?: number;
  providerTimeoutMs?: number;
  leaseRenewalMs?: number;
}

export interface SmsProcessingResult {
  processed: number;
  sent: number;
  skipped: number;
  failed: number;
}

export interface SmsQueueMetrics {
  pendingCount: number;
  failedCount: number;
  unknownCount: number;
  lagSeconds: number | null;
  oldestQueuedAt: string | null;
}

export const noopSmsProvider: SmsProvider = {
  async send(): Promise<SmsProviderResult> {
    return { status: "skipped", provider: "noop", error: "No SMS provider configured" };
  }
};

const getString = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const getMetadataString = (message: Row, key: string): string => {
  const metadata = message.metadata;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? getString((metadata as Row)[key])
    : "";
};
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
const errorCode = (error: unknown): string => error instanceof SmsProviderError ? error.code : "provider_error";

class SmsProviderTimeoutError extends SmsProviderError {
  constructor() { super("provider_timeout_ambiguous", "SMS provider request timed out with an unknown delivery outcome."); }
}

const withProviderTimeout = async <T>(operation: Promise<T>, timeoutMs: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new SmsProviderTimeoutError()), timeoutMs); })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const getProvider = (options: ProcessSmsOptions): SmsProvider => {
  if (options.provider) return options.provider;
  if (options.allowNoopProvider) {
    if (env.NODE_ENV === "production") {
      throw new ApiError(403, "The noop SMS provider is unavailable in production");
    }
    return noopSmsProvider;
  }
  if (env.SMS_PROVIDER === "twilio") {
    assertTwilioSmsProviderConfigured();
    return createTwilioSmsProvider();
  }
  throw new ApiError(503, "SMS provider is not configured");
};

const isUniqueViolation = (error: { code?: string } | null): boolean => error?.code === "23505";

type SmsUsageReservation = "allowed" | "limit_reached" | "not_claimed" | "not_available";

const reserveSmsUsage = async (messageId: string, leaseToken: string): Promise<SmsUsageReservation> => {
  const { data, error } = await supabaseAdmin.rpc("reserve_sms_monthly_usage", {
    p_message_id: messageId,
    p_lease_token: leaseToken
  });
  handleSupabaseError(error, "Unable to reserve SMS monthly usage");
  return data === "allowed" || data === "limit_reached" || data === "not_claimed" || data === "not_available"
    ? data
    : "not_available";
};

const releaseSmsUsage = async (messageId: string, leaseToken: string): Promise<void> => {
  const { error } = await supabaseAdmin.rpc("release_sms_monthly_usage", {
    p_message_id: messageId,
    p_lease_token: leaseToken
  });
  handleSupabaseError(error, "Unable to release SMS monthly usage");
};

const retryDelayMinutes = (attemptCount: number): number | null => {
  if (attemptCount <= 1) return 1;
  if (attemptCount === 2) return 5;
  if (attemptCount === 3) return 20;
  return null;
};

const canAttempt = (message: Row, now: Date, maxAttempts: number): boolean => {
  const attempts = Number(message.attempt_count ?? 0);
  if (attempts >= maxAttempts) return false;
  const nextAttemptAt = new Date(String(message.next_attempt_at ?? "")).getTime();
  if (!Number.isFinite(nextAttemptAt) || nextAttemptAt > now.getTime()) return false;
  if (message.status === "queued" || message.status === "failed") return true;
  if (message.status !== "sending") return false;
  const leaseExpiry = new Date(String(message.lease_expires_at ?? "")).getTime();
  return !Number.isFinite(leaseExpiry) || leaseExpiry <= now.getTime();
};

const updateClaimedMessage = async (id: string, leaseToken: string, updates: Row): Promise<Row | null> => {
  const { data, error } = await supabaseAdmin.from("sms_messages").update({
    ...updates, lease_token: null, lease_expires_at: null
  }).eq("id", id).eq("status", "sending").eq("lease_token", leaseToken).select("*").maybeSingle();
  handleSupabaseError(error, "Unable to update SMS message");
  return data as Row | null;
};

const renewLease = async (id: string, leaseToken: string, now: Date, leaseMinutes: number): Promise<boolean> => {
  const { data, error } = await supabaseAdmin.from("sms_messages").update({
    lease_expires_at: new Date(now.getTime() + leaseMinutes * 60_000).toISOString()
  }).eq("id", id).eq("status", "sending").eq("lease_token", leaseToken).select("id").maybeSingle();
  handleSupabaseError(error, "Unable to renew SMS message lease");
  return Boolean(data);
};

const claimMessage = async (message: Row, now: Date, leaseMinutes: number): Promise<{ message: Row; leaseToken: string } | null> => {
  const leaseToken = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + leaseMinutes * 60_000).toISOString();
  const { data, error } = await supabaseAdmin
    .from("sms_messages")
    .update({
      status: "sending",
      attempt_count: Number(message.attempt_count ?? 0) + 1,
      last_attempt_at: now.toISOString(),
      sending_started_at: now.toISOString(),
      lease_token: leaseToken,
      lease_expires_at: leaseExpiresAt,
      error_code: null,
      error_message: null
    })
    .eq("id", String(message.id ?? ""))
    .lte("next_attempt_at", now.toISOString())
    .or(`status.eq.queued,status.eq.failed,and(status.eq.sending,lease_expires_at.lt.${now.toISOString()})`)
    .select("*")
    .maybeSingle();
  handleSupabaseError(error, "Unable to claim SMS message");
  return data ? { message: data as Row, leaseToken } : null;
};

const getRetryableMessages = async (limit: number, now: Date, maxAttempts: number): Promise<RowList> => {
  // Query eligibility in Postgres before applying the small worker limit. This prevents
  // delayed retries at the front of the queue from starving eligible newer messages.
  const [ready, expiredLeases] = await Promise.all([
    supabaseAdmin.from("sms_messages").select("*")
      .in("status", ["queued", "failed"])
      .lt("attempt_count", maxAttempts)
      .lte("next_attempt_at", now.toISOString())
      .order("created_at", { ascending: true })
      .limit(limit),
    supabaseAdmin.from("sms_messages").select("*")
      .eq("status", "sending")
      .lt("attempt_count", maxAttempts)
      .lte("next_attempt_at", now.toISOString())
      .lte("lease_expires_at", now.toISOString())
      .order("created_at", { ascending: true })
      .limit(limit)
  ]);
  handleSupabaseError(ready.error, "Unable to load retryable SMS messages");
  handleSupabaseError(expiredLeases.error, "Unable to load expired SMS leases");
  return ([...(ready.data ?? []), ...(expiredLeases.data ?? [])] as RowList)
    .filter((message) => canAttempt(message, now, maxAttempts))
    .sort((left, right) => String(left.created_at ?? "").localeCompare(String(right.created_at ?? "")))
    .slice(0, limit);
};

const logSkipped = async (message: Row, leaseToken: string, reason: string, normalized: string | null, now: Date): Promise<boolean> => {
  const finalized = await updateClaimedMessage(String(message.id), leaseToken, {
    status: "skipped", skipped_at: now.toISOString(), next_attempt_at: null, error_code: reason, error_message: reason
  });
  if (!finalized) return false;
  const status = reason === "missing_sms_consent"
    ? "skipped_missing_consent"
    : reason === "appointment_changed"
      ? "skipped_appointment_changed"
      : reason === "appointment_cancelled"
        ? "skipped_appointment_cancelled"
        : "skipped_opted_out";
  await communicationEventsService.logCommunicationEvent({
    userId: String(message.user_id), clientId: typeof message.client_id === "string" ? message.client_id : null,
    channel: "sms", messageType: message.message_type as MessageType, toAddress: getString(message.recipient_phone),
    toNormalized: normalized, status,
    errorCode: reason, metadata: { sms_message_id: message.id ?? null }
  });
  return true;
};

/**
 * A reminder belongs to one appointment occurrence. Re-read it after claiming the
 * outbox row and immediately before provider submission so a cancellation or
 * reschedule cannot send stale copy.
 */
const getAppointmentReminderInvalidationReason = async (message: Row): Promise<string | null> => {
  if (message.message_type !== "appointment_reminder") return null;
  const appointmentId = getString(message.appointment_id);
  const occurrencePrefix = appointmentId ? `appointment-reminder:${appointmentId}:` : "";
  // Metadata is canonical. The key fallback protects rows queued by the first
  // reminder implementation, before appointment_start_at was persisted.
  const expectedStartAt = getMetadataString(message, "appointment_start_at")
    || (occurrencePrefix && getString(message.idempotency_key).startsWith(occurrencePrefix)
      ? getString(message.idempotency_key).slice(occurrencePrefix.length)
      : "");
  if (!appointmentId || !expectedStartAt) return null;
  const { data, error } = await supabaseAdmin.from("appointments")
    .select("status, appointment_date")
    .eq("id", appointmentId)
    .eq("user_id", getString(message.user_id))
    .maybeSingle();
  handleSupabaseError(error, "Unable to validate appointment reminder occurrence");
  if (!data || data.status !== "scheduled") return "appointment_cancelled";
  if (getString(data.appointment_date) !== expectedStartAt) return "appointment_changed";
  return null;
};

const isAccountSmsDeliveryEnabled = async (userId: string): Promise<boolean> => {
  const { data, error } = await supabaseAdmin.from("users").select("sms_delivery_enabled").eq("id", userId).maybeSingle();
  handleSupabaseError(error, "Unable to load SMS delivery setting");
  if (!data && process.env.NODE_ENV === "test") return true;
  return data?.sms_delivery_enabled === true;
};

export const smsDeliveryService = {
  noopSmsProvider,

  async isAccountSmsDeliveryEnabled(userId: string): Promise<boolean> {
    return isAccountSmsDeliveryEnabled(userId);
  },

  async queueSms(options: QueueSmsOptions): Promise<Row> {
    const phone = normalizePhone(options.to);
    const body = options.body.trim();
    const idempotencyKey = options.idempotencyKey.trim();
    if (!options.userId || !phone || !body || body.length > 1600 || !idempotencyKey || idempotencyKey.length > 200) {
      throw new ApiError(400, "SMS message has invalid recipient, body, or idempotency key");
    }
    const payload = {
      user_id: options.userId, client_id: options.clientId ?? null, appointment_id: options.appointmentId ?? null,
      message_type: options.messageType, recipient_phone: options.to.trim(), recipient_phone_normalized: phone,
      body, status: "queued", next_attempt_at: new Date().toISOString(), idempotency_key: idempotencyKey, metadata: options.metadata ?? {}
    };
    const existing = await supabaseAdmin.from("sms_messages").select("*")
      .eq("user_id", options.userId).eq("idempotency_key", idempotencyKey).maybeSingle();
    handleSupabaseError(existing.error, "Unable to load existing SMS message");
    if (existing.data) return existing.data as Row;
    const { data, error } = await supabaseAdmin.from("sms_messages").insert(payload).select("*").maybeSingle();
    if (isUniqueViolation(error)) {
      const existing = await supabaseAdmin.from("sms_messages").select("*")
        .eq("user_id", options.userId).eq("idempotency_key", idempotencyKey).maybeSingle();
      handleSupabaseError(existing.error, "Unable to load existing SMS message");
      if (existing.data) return existing.data as Row;
    }
    handleSupabaseError(error, "Unable to queue SMS message");
    return data as Row;
  },

  async getSmsQueueMetrics(now = new Date()): Promise<SmsQueueMetrics> {
    const [pending, failed, unknown, oldest] = await Promise.all([
      supabaseAdmin.from("sms_messages").select("id", { count: "exact", head: true }).in("status", ["queued", "sending"]),
      supabaseAdmin.from("sms_messages").select("id", { count: "exact", head: true }).eq("status", "failed"),
      supabaseAdmin.from("sms_messages").select("id", { count: "exact", head: true }).eq("status", "unknown"),
      supabaseAdmin.from("sms_messages").select("created_at").eq("status", "queued").order("created_at", { ascending: true }).limit(1).maybeSingle()
    ]);
    handleSupabaseError(pending.error, "Unable to count pending SMS messages");
    handleSupabaseError(failed.error, "Unable to count failed SMS messages");
    handleSupabaseError(unknown.error, "Unable to count unknown SMS messages");
    handleSupabaseError(oldest.error, "Unable to load SMS queue lag");
    const oldestQueuedAt = typeof oldest.data?.created_at === "string" ? oldest.data.created_at : null;
    const timestamp = oldestQueuedAt ? new Date(oldestQueuedAt).getTime() : NaN;
    return { pendingCount: pending.count ?? 0, failedCount: failed.count ?? 0, unknownCount: unknown.count ?? 0,
      lagSeconds: Number.isFinite(timestamp) ? Math.max(0, Math.floor((now.getTime() - timestamp) / 1000)) : null, oldestQueuedAt };
  },

  async processQueuedSms(options: ProcessSmsOptions = {}): Promise<SmsProcessingResult> {
    if (!env.SMS_DELIVERY_ENABLED) {
      return { processed: 0, sent: 0, skipped: 0, failed: 0 };
    }
    const provider = getProvider(options);
    const now = options.now ?? new Date();
    const maxAttempts = Math.max(1, options.maxAttempts ?? defaultMaxAttempts);
    const leaseMinutes = Math.max(1, options.leaseMinutes ?? defaultLeaseMinutes);
    const providerTimeoutMs = Math.max(1, Math.min(options.providerTimeoutMs ?? defaultProviderTimeoutMs, leaseMinutes * 60_000 - 1_000));
    const leaseRenewalMs = Math.max(1, Math.min(options.leaseRenewalMs ?? defaultLeaseRenewalMs, Math.floor(leaseMinutes * 60_000 / 2)));
    const messages = await getRetryableMessages(Math.max(1, options.limit ?? defaultProcessLimit), now, maxAttempts);
    const result: SmsProcessingResult = { processed: 0, sent: 0, skipped: 0, failed: 0 };
    for (const message of messages) {
      const claim = await claimMessage(message, now, leaseMinutes);
      const claimed = claim?.message;
      if (!claimed) continue;
      result.processed += 1;
      const userId = getString(claimed.user_id);
      const clientId = typeof claimed.client_id === "string" ? claimed.client_id : null;
      const recipient = getString(claimed.recipient_phone);
      const normalized = normalizePhone(recipient);
      let usageReserved = false;
      try {
        if (!userId || !(await accountAccessService.isAccountActive(userId))) {
          if (await logSkipped(claimed, claim.leaseToken, "account_inactive", normalized, now)) result.skipped += 1;
          continue;
        }
        if (!(await this.isAccountSmsDeliveryEnabled(userId))) {
          if (await logSkipped(claimed, claim.leaseToken, "account_sms_delivery_disabled", normalized, now)) result.skipped += 1;
          continue;
        }
        const eligibility = await communicationPreferencesService.canSendCommunication({
          userId, clientId, channel: "sms", to: recipient, messageType: claimed.message_type as MessageType
        });
        if (!eligibility.canSend) {
          if (await logSkipped(claimed, claim.leaseToken, eligibility.reason ?? "communication_preference_blocked", eligibility.toNormalized ?? normalized, now)) result.skipped += 1;
          continue;
        }
        const appointmentInvalidationReason = await getAppointmentReminderInvalidationReason(claimed);
        if (appointmentInvalidationReason) {
          if (await logSkipped(claimed, claim.leaseToken, appointmentInvalidationReason, eligibility.toNormalized ?? normalized, now)) result.skipped += 1;
          continue;
        }
        const usageReservation = await reserveSmsUsage(String(claimed.id), claim.leaseToken);
        if (usageReservation === "not_claimed") continue;
        if (usageReservation !== "allowed") {
          const reason = usageReservation === "limit_reached" ? "sms_monthly_limit_reached" : "sms_usage_unavailable";
          if (await logSkipped(claimed, claim.leaseToken, reason, eligibility.toNormalized ?? normalized, now)) result.skipped += 1;
          continue;
        }
        usageReserved = true;
        let leaseLost = false;
        const leaseHeartbeat = setInterval(() => {
          void renewLease(String(claimed.id), claim.leaseToken, new Date(), leaseMinutes)
            .then((renewed) => { leaseLost ||= !renewed; })
            .catch(() => { leaseLost = true; });
        }, leaseRenewalMs);
        let providerResult: SmsProviderResult;
        try {
          providerResult = await withProviderTimeout(provider.send({
            to: eligibility.toNormalized ?? normalized ?? recipient,
            body: getString(claimed.body), idempotencyKey: getString(claimed.idempotency_key)
          }), providerTimeoutMs);
        } finally {
          clearInterval(leaseHeartbeat);
        }
        if (leaseLost) continue;
        if (providerResult.status === "sent") {
          const finalized = await updateClaimedMessage(String(claimed.id), claim.leaseToken, { status: "sent", provider: providerResult.provider,
            provider_message_id: providerResult.providerMessageId ?? null, sent_at: now.toISOString(), next_attempt_at: null });
          if (!finalized) continue;
          usageReserved = false;
          await communicationEventsService.logCommunicationEvent({ userId, clientId, channel: "sms", messageType: claimed.message_type as MessageType,
            toAddress: recipient, toNormalized: eligibility.toNormalized ?? normalized, provider: providerResult.provider,
            providerMessageId: providerResult.providerMessageId ?? null, status: "sent", metadata: { sms_message_id: claimed.id ?? null } });
          result.sent += 1;
        } else {
          await releaseSmsUsage(String(claimed.id), claim.leaseToken);
          usageReserved = false;
          const finalized = await updateClaimedMessage(String(claimed.id), claim.leaseToken, { status: "skipped", provider: providerResult.provider,
            provider_message_id: providerResult.providerMessageId ?? null, skipped_at: now.toISOString(),
            next_attempt_at: null, error_code: "provider_skipped", error_message: providerResult.error ?? "Provider skipped SMS delivery" });
          if (!finalized) continue;
          result.skipped += 1;
        }
      } catch (error) {
        const messageText = errorMessage(error).slice(0, 2000);
        const ambiguousTimeout = error instanceof SmsProviderTimeoutError;
        if (!ambiguousTimeout && usageReserved) {
          try {
            await releaseSmsUsage(String(claimed.id), claim.leaseToken);
          } catch {
            // Retain the reservation when release cannot be confirmed. This is safer than
            // allowing the monthly cap to be exceeded while the database is unavailable.
          }
        }
        const delayMinutes = retryDelayMinutes(Number(claimed.attempt_count ?? 0));
        const finalized = await updateClaimedMessage(String(claimed.id), claim.leaseToken, {
          status: ambiguousTimeout ? "unknown" : "failed", failed_at: ambiguousTimeout ? null : now.toISOString(),
          unknown_at: ambiguousTimeout ? now.toISOString() : null,
          next_attempt_at: ambiguousTimeout || delayMinutes === null ? null : new Date(now.getTime() + delayMinutes * 60_000).toISOString(),
          error_code: ambiguousTimeout ? errorCode(error) : delayMinutes === null ? `${errorCode(error)}_final` : errorCode(error), error_message: messageText
        });
        if (!finalized) continue;
        if (ambiguousTimeout) {
          logger.error("sms_delivery_outcome_unknown", {
            smsMessageId: claimed.id ?? null,
            accountUserId: userId || null,
            errorCode: errorCode(error)
          });
        }
        await communicationEventsService.logCommunicationEvent({ userId, clientId, channel: "sms", messageType: claimed.message_type as MessageType,
          toAddress: recipient, toNormalized: normalized, status: "failed", errorCode: ambiguousTimeout ? errorCode(error) : delayMinutes === null ? `${errorCode(error)}_final` : errorCode(error), errorMessage: messageText,
          metadata: { sms_message_id: claimed.id ?? null } });
        result.failed += 1;
      }
    }
    return result;
  }
};
