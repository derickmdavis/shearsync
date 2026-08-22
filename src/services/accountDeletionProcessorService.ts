import { createHmac, randomUUID } from "crypto";
import { env } from "../config/env";
import { ApiError } from "../lib/errors";
import { supabaseAdmin } from "../lib/supabase";
import { appointmentImageStorageService } from "./appointmentImageStorageService";
import { accountDeletionService } from "./accountDeletionService";
import { handleSupabaseError, type Row, type RowList } from "./db";
import { paymentMethodQrStorageService } from "./paymentMethodQrStorageService";

const LEASE_MINUTES = 15;
const RETRY_DELAY_MINUTES = 30;
const RETAINED_EVENT_PAGE_SIZE = 500;
const RETAINED_EVENT_UPSERT_BATCH_SIZE = 250;

export interface AccountDeletionProcessingResult {
  processed: number;
  completed: number;
  failed: number;
  skipped: number;
}

type ProcessorOptions = {
  limit?: number;
  now?: Date;
  enabled?: boolean;
  auditHashSecret?: string;
};

const getString = (row: Row | null | undefined, key: string): string | null =>
  typeof row?.[key] === "string" && String(row[key]).trim() ? String(row[key]).trim() : null;

const pick = (row: Row, keys: string[]): Row => Object.fromEntries(
  keys.flatMap((key) => row[key] === undefined || row[key] === null ? [] : [[key, row[key]]])
);

const toErrorCode = (error: unknown): string => {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code.slice(0, 100);
  }
  return error instanceof ApiError ? "api_error" : "account_deletion_failed";
};

const isAuthUserMissing = (error: { status?: number; message?: string } | null): boolean =>
  error?.status === 404 || /user.*not.*found|not found/i.test(error?.message ?? "");

const accountHash = (userId: string, secret: string): string =>
  createHmac("sha256", secret).update(userId).digest("hex");

const updateRows = async (table: string, userId: string, payload: Row, columns: string[] = ["user_id"]): Promise<void> => {
  let query = supabaseAdmin.from(table).update(payload);
  if (columns.length === 1) {
    query = query.eq(columns[0], userId);
  } else {
    query = query.or(columns.map((column) => `${column}.eq.${userId}`).join(","));
  }
  const { error } = await query;
  handleSupabaseError(error, `Unable to anonymize ${table}`);
};

type RetainedEventSource = {
  table: string;
  category: string;
  columns: string;
  map: (row: Row) => { eventType: string; occurredAt: string; metadata: Row };
};

const retainedEventSources: RetainedEventSource[] = [
  { table: "appointments", category: "booking", columns: "id, status, booking_source, appointment_date, service_name, duration_minutes, price, created_at", map: (row) => ({ eventType: String(row.status ?? "unknown"), occurredAt: String(row.appointment_date ?? row.created_at), metadata: pick(row, ["booking_source", "service_name", "duration_minutes", "price"]) }) },
  { table: "activity_events", category: "booking_activity", columns: "id, activity_type, occurred_at, created_at", map: (row) => ({ eventType: String(row.activity_type ?? "unknown"), occurredAt: String(row.occurred_at ?? row.created_at), metadata: {} }) },
  { table: "appointment_email_events", category: "email", columns: "id, email_type, status, provider, provider_message_id, attempt_count, sent_at, created_at", map: (row) => ({ eventType: String(row.email_type ?? "unknown"), occurredAt: String(row.sent_at ?? row.created_at), metadata: pick(row, ["status", "provider", "provider_message_id", "attempt_count"]) }) },
  { table: "sms_messages", category: "sms", columns: "id, message_type, status, provider, provider_message_id, attempt_count, sent_at, delivered_at, created_at", map: (row) => ({ eventType: String(row.message_type ?? "unknown"), occurredAt: String(row.sent_at ?? row.delivered_at ?? row.created_at), metadata: pick(row, ["status", "provider", "provider_message_id", "attempt_count"]) }) },
  { table: "communication_events", category: "communication", columns: "id, channel, message_type, status, provider, provider_message_id, error_code, created_at", map: (row) => ({ eventType: String(row.message_type ?? row.channel ?? "unknown"), occurredAt: String(row.created_at), metadata: pick(row, ["channel", "status", "provider", "provider_message_id", "error_code"]) }) },
  { table: "communication_consent_events", category: "communication_consent", columns: "id, channel, event_type, source, message_type, created_at", map: (row) => ({ eventType: String(row.event_type ?? "unknown"), occurredAt: String(row.created_at), metadata: pick(row, ["channel", "source", "message_type"]) }) },
  { table: "referral_events", category: "referral", columns: "id, event_type, source, created_at", map: (row) => ({ eventType: String(row.event_type ?? "unknown"), occurredAt: String(row.created_at), metadata: pick(row, ["source"]) }) },
  { table: "campaign_recipients", category: "campaign_delivery", columns: "id, eligibility_status, exclusion_reason, status, provider, attempt_count, sent_at, delivered_at, failed_at, cancelled_at, created_at", map: (row) => ({ eventType: String(row.status ?? "unknown"), occurredAt: String(row.sent_at ?? row.delivered_at ?? row.failed_at ?? row.cancelled_at ?? row.created_at), metadata: pick(row, ["eligibility_status", "exclusion_reason", "provider", "attempt_count"]) }) },
  { table: "campaign_delivery_events", category: "campaign_event", columns: "id, provider, event_type, occurred_at, is_automated, privacy_limited, created_at", map: (row) => ({ eventType: String(row.event_type ?? "unknown"), occurredAt: String(row.occurred_at ?? row.created_at), metadata: pick(row, ["provider", "is_automated", "privacy_limited"]) }) },
  { table: "plan_usage_events", category: "usage", columns: "id, event_type, quantity, created_at", map: (row) => ({ eventType: String(row.event_type ?? "unknown"), occurredAt: String(row.created_at), metadata: pick(row, ["quantity"]) }) }
];

export const accountDeletionProcessorService = {
  async processDue(options: ProcessorOptions = {}): Promise<AccountDeletionProcessingResult> {
    const now = options.now ?? new Date();
    const enabled = options.enabled ?? env.ACCOUNT_DELETION_PROCESSING_ENABLED;
    if (!enabled) {
      throw new ApiError(503, "Account deletion processing is disabled");
    }

    const limit = Math.min(100, Math.max(1, options.limit ?? 10));
    const nowIso = now.toISOString();
    const { data, error } = await supabaseAdmin
      .from("account_deletion_requests")
      .select("*")
      .or([
        `and(status.eq.pending,scheduled_deletion_at.lte.${nowIso})`,
        `and(status.eq.failed_retryable,next_attempt_at.lte.${nowIso})`,
        `and(status.eq.processing,lease_expires_at.lte.${nowIso})`
      ].join(","))
      .order("scheduled_deletion_at", { ascending: true })
      .limit(limit);
    handleSupabaseError(error, "Unable to load due account deletion requests");

    const result: AccountDeletionProcessingResult = { processed: 0, completed: 0, failed: 0, skipped: 0 };
    for (const request of (data ?? []) as RowList) {
      const claimed = await this.claim(request, now);
      if (!claimed) {
        result.skipped += 1;
        continue;
      }

      result.processed += 1;
      try {
        await this.processClaimed(claimed, now, options.auditHashSecret);
        result.completed += 1;
      } catch (error) {
        await this.markRetryableFailure(claimed, error, now);
        result.failed += 1;
      }
    }

    return result;
  },

  async claim(request: Row, now: Date): Promise<Row | null> {
    const requestId = getString(request, "id");
    if (!requestId) return null;
    const status = getString(request, "status");
    const leaseExpiresAt = new Date(String(request.lease_expires_at ?? "")).getTime();
    if (status === "processing" && Number.isFinite(leaseExpiresAt) && leaseExpiresAt > now.getTime()) {
      return null;
    }

    const leaseToken = randomUUID();
    let query = supabaseAdmin
      .from("account_deletion_requests")
      .update({
        status: "processing",
        current_step: "claimed",
        processing_started_at: request.processing_started_at ?? now.toISOString(),
        attempt_count: Number(request.attempt_count ?? 0) + 1,
        lease_token: leaseToken,
        lease_expires_at: new Date(now.getTime() + LEASE_MINUTES * 60_000).toISOString(),
        next_attempt_at: null,
        failure_reason: null,
        last_error_code: null,
        last_error_at: null
      })
      .eq("id", requestId);
    if (status === "processing") {
      query = query.eq("status", "processing").lte("lease_expires_at", now.toISOString());
    } else if (status === "failed_retryable") {
      query = query.eq("status", "failed_retryable").lte("next_attempt_at", now.toISOString());
    } else {
      query = query.eq("status", "pending");
    }
    const { data, error } = await query.select("*").maybeSingle();
    handleSupabaseError(error, "Unable to claim account deletion request");
    return data as Row | null;
  },

  async processClaimed(request: Row, now: Date, suppliedAuditHashSecret?: string): Promise<void> {
    const requestId = getString(request, "id");
    if (!requestId) throw new Error("Account deletion request is missing an ID");
    const userId = getString(request, "user_id");

    // If Auth deletion succeeded but the final status write failed, the cascade
    // has already cleared user_id. Retrying simply finalizes the durable job.
    if (!userId) {
      await this.complete(requestId, getString(request, "deleted_account_hash"), now, {});
      return;
    }

    const auditHashSecret = suppliedAuditHashSecret ?? env.ACCOUNT_DELETION_AUDIT_HASH_SECRET;
    if (!auditHashSecret) {
      throw new ApiError(500, "Account deletion audit hash secret is not configured");
    }
    const deletedAccountHash = accountHash(userId, auditHashSecret);

    await this.setStep(requestId, "access_disabled");
    await accountDeletionService.disableAccountAccess(userId, now.toISOString(), "processing");
    await accountDeletionService.disablePublicBooking(userId);
    await accountDeletionService.cancelPendingAutomation(userId);

    await this.setStep(requestId, "storage_cleanup");
    const storage = await this.deleteStorage(userId);
    if (storage.failedPaths.length > 0) {
      throw new Error(`Storage cleanup failed for ${storage.failedPaths.length} object(s)`);
    }

    await this.setStep(requestId, "audit_anonymization");
    await this.anonymizeOperationalRecords(userId, deletedAccountHash, now);
    const retainedEventCount = await this.archiveRetainedEvents(userId, requestId, deletedAccountHash);
    await this.writeAuditEvent(requestId, userId, deletedAccountHash, "data_cleanup_completed", {
      storage_deleted: storage.deletedPaths.length,
      retained_events: retainedEventCount
    });

    await this.setStep(requestId, "auth_deletion");
    const { error: authError } = await supabaseAdmin.auth.admin.deleteUser(userId);
    if (authError && !isAuthUserMissing(authError)) {
      throw new Error(`Supabase Auth deletion failed: ${authError.message}`);
    }

    await this.complete(requestId, deletedAccountHash, now, {
      storage_deleted: storage.deletedPaths.length,
      retained_events: retainedEventCount,
      auth_user_already_missing: Boolean(authError)
    });
  },

  async deleteStorage(userId: string): Promise<{ deletedPaths: string[]; failedPaths: string[] }> {
    const [appointmentImages, formulaImages, paymentMethods] = await Promise.all([
      supabaseAdmin.from("appointment_images").select("storage_path, thumbnail_path").eq("user_id", userId),
      supabaseAdmin.from("client_formula_images").select("storage_path, thumbnail_path").eq("user_id", userId),
      supabaseAdmin.from("payment_methods").select("qr_image_path").eq("user_id", userId)
    ]);
    handleSupabaseError(appointmentImages.error, "Unable to load appointment image paths for account deletion");
    handleSupabaseError(formulaImages.error, "Unable to load formula image paths for account deletion");
    handleSupabaseError(paymentMethods.error, "Unable to load payment QR paths for account deletion");

    const deletedPaths: string[] = [];
    const failedPaths: string[] = [];
    const knownImageRows = [...(appointmentImages.data ?? []), ...(formulaImages.data ?? [])] as Row[];
    for (const image of knownImageRows) {
      const cleanup = await appointmentImageStorageService.deleteObjectsSafely({
        storagePath: getString(image, "storage_path") ?? undefined,
        thumbnailPath: getString(image, "thumbnail_path") ?? undefined
      }, "account deletion");
      deletedPaths.push(...cleanup.deletedPaths);
      failedPaths.push(...cleanup.failedPaths);
    }

    // Database rows are authoritative, but the prefix scan also catches
    // abandoned signed-upload objects that never received a database row.
    const [imagePrefix, paymentPrefix] = await Promise.all([
      appointmentImageStorageService.deleteUserPrefix(userId),
      paymentMethodQrStorageService.deleteUserPrefix(userId)
    ]);
    deletedPaths.push(...imagePrefix.deletedPaths, ...paymentPrefix.deletedPaths);
    failedPaths.push(...imagePrefix.failedPaths, ...paymentPrefix.failedPaths);

    // This verifies any nonstandard QR paths still belong to the account.
    for (const method of (paymentMethods.data ?? []) as Row[]) {
      const path = getString(method, "qr_image_path");
      if (path && !path.startsWith(`${userId}/`)) failedPaths.push(path);
    }

    return { deletedPaths, failedPaths };
  },

  async anonymizeOperationalRecords(userId: string, deletedAccountHash: string, now: Date): Promise<void> {
    const anonymizedAt = now.toISOString();
    await Promise.all([
      updateRows("api_request_logs", userId, {
        account_user_id: null, actor_user_id: null, deleted_account_hash: deletedAccountHash,
        anonymized_at: anonymizedAt, path: "/redacted", ip_hash: null, error_message: null,
        metadata: { account_deletion_anonymized: true }
      }, ["account_user_id", "actor_user_id"]),
      updateRows("booking_error_events", userId, {
        account_user_id: null, client_id: null, appointment_id: null, deleted_account_hash: deletedAccountHash,
        anonymized_at: anonymizedAt, anonymous_id: null, session_id: null, stylist_slug: null,
        error_message: null, metadata: { account_deletion_anonymized: true }
      }),
      updateRows("notification_events", userId, {
        account_user_id: null, actor_user_id: null, client_id: null, appointment_id: null,
        deleted_account_hash: deletedAccountHash, anonymized_at: anonymizedAt,
        provider_error_message: null, metadata: { account_deletion_anonymized: true }
      }, ["account_user_id", "actor_user_id"]),
      updateRows("product_events", userId, {
        account_user_id: null, actor_user_id: null, client_id: null, appointment_id: null,
        deleted_account_hash: deletedAccountHash, anonymized_at: anonymizedAt,
        anonymous_id: null, session_id: null, dedupe_key: null, stylist_slug: null,
        metadata: { account_deletion_anonymized: true }
      }, ["account_user_id", "actor_user_id"]),
      updateRows("admin_account_notes", userId, {
        account_user_id: null, user_id: null, deleted_account_hash: deletedAccountHash,
        anonymized_at: anonymizedAt, note: "[Deleted account support note]",
        metadata: { account_deletion_anonymized: true }
      }, ["account_user_id", "user_id"])
    ]);
    const auditUpdates = await Promise.all([
      supabaseAdmin
        .from("account_deletion_requests")
        .update({ deleted_account_hash: deletedAccountHash })
        .eq("user_id", userId),
      supabaseAdmin
        .from("account_deletion_audit_events")
        .update({ deleted_account_hash: deletedAccountHash })
        .eq("user_id", userId)
    ]);
    for (const result of auditUpdates) {
      handleSupabaseError(result.error, "Unable to anonymize account deletion records");
    }
  },

  async archiveRetainedEvents(userId: string, requestId: string, deletedAccountHash: string): Promise<number> {
    let retainedEventCount = 0;

    for (const source of retainedEventSources) {
      for (let start = 0; ; start += RETAINED_EVENT_PAGE_SIZE) {
        const { data, error } = await supabaseAdmin
          .from(source.table)
          .select(source.columns)
          .eq("user_id", userId)
          .order("id", { ascending: true })
          .range(start, start + RETAINED_EVENT_PAGE_SIZE - 1);
        handleSupabaseError(error, `Unable to archive ${source.table} for account deletion`);

        const rows = (data ?? []) as unknown as RowList;
        const events = rows.flatMap((row) => {
          const sourceId = getString(row, "id");
          if (!sourceId) return [];
          const event = source.map(row);
          return [{
            request_id: requestId,
            deleted_account_hash: deletedAccountHash,
            source_table: source.table,
            source_id: sourceId,
            event_category: source.category,
            event_type: event.eventType.slice(0, 120),
            occurred_at: event.occurredAt,
            metadata: event.metadata
          }];
        });

        for (let index = 0; index < events.length; index += RETAINED_EVENT_UPSERT_BATCH_SIZE) {
          const { error: upsertError } = await supabaseAdmin
            .from("account_deletion_retained_events")
            .upsert(events.slice(index, index + RETAINED_EVENT_UPSERT_BATCH_SIZE), {
              onConflict: "request_id,source_table,source_id"
            });
          handleSupabaseError(upsertError, "Unable to retain account deletion audit history");
        }
        retainedEventCount += events.length;

        if (rows.length < RETAINED_EVENT_PAGE_SIZE) break;
      }
    }

    return retainedEventCount;
  },

  async setStep(requestId: string, currentStep: string): Promise<void> {
    const { error } = await supabaseAdmin
      .from("account_deletion_requests")
      .update({ current_step: currentStep })
      .eq("id", requestId)
      .eq("status", "processing");
    handleSupabaseError(error, "Unable to update account deletion progress");
  },

  async complete(requestId: string, deletedAccountHash: string | null, now: Date, completionSummary: Row): Promise<void> {
    const { error } = await supabaseAdmin
      .from("account_deletion_requests")
      .update({
        status: "completed",
        current_step: "completed",
        completed_at: now.toISOString(),
        lease_token: null,
        lease_expires_at: null,
        next_attempt_at: null,
        failure_reason: null,
        ...(deletedAccountHash ? { deleted_account_hash: deletedAccountHash } : {}),
        completion_summary: completionSummary
      })
      .eq("id", requestId);
    handleSupabaseError(error, "Unable to finalize account deletion request");
  },

  async markRetryableFailure(request: Row, error: unknown, now: Date): Promise<void> {
    const requestId = getString(request, "id");
    if (!requestId) return;
    const { error: updateError } = await supabaseAdmin
      .from("account_deletion_requests")
      .update({
        status: "failed_retryable",
        current_step: "failed",
        failed_at: now.toISOString(),
        failure_reason: "Account deletion processing failed",
        last_error_code: toErrorCode(error),
        last_error_at: now.toISOString(),
        next_attempt_at: new Date(now.getTime() + RETRY_DELAY_MINUTES * 60_000).toISOString(),
        lease_token: null,
        lease_expires_at: null
      })
      .eq("id", requestId);
    handleSupabaseError(updateError, "Unable to record account deletion failure");
    const userId = getString(request, "user_id");
    if (userId) {
      const { error: userError } = await supabaseAdmin
        .from("users")
        .update({ deletion_status: "failed" })
        .eq("id", userId);
      handleSupabaseError(userError, "Unable to record account deletion failure status");
    }
  },

  async writeAuditEvent(
    requestId: string,
    userId: string,
    deletedAccountHash: string,
    eventType: string,
    metadata: Row
  ): Promise<void> {
    const { error } = await supabaseAdmin.from("account_deletion_audit_events").insert({
      request_id: requestId,
      user_id: userId,
      deleted_account_hash: deletedAccountHash,
      event_type: eventType,
      metadata
    });
    handleSupabaseError(error, "Unable to write account deletion audit event");
  }
};
