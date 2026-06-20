import { createHash } from "crypto";
import { supabaseAdmin } from "../lib/supabase";
import type { Row } from "./db";
import { handleSupabaseError } from "./db";

const ACTIVE_DELETION_STATUSES = ["pending", "processing", "failed_retryable"];
const DEFAULT_DELETION_DELAY_DAYS = 7;

type DeletionRequestPayload = {
  reason?: string;
  clientRequestId?: string;
};

type RequestContext = {
  ipAddress?: string | null;
  userAgent?: string | null;
  authSource?: string | null;
};

export type AccountDeletionStatus = {
  status: "none" | "pending" | "processing" | "failed_retryable" | "completed" | "cancelled";
  requestId: string | null;
  requestedAt: string | null;
  scheduledDeletionAt: string | null;
  completedAt: string | null;
  publicBookingDisabled?: boolean;
  message?: string;
};

const hashOptionalValue = (value?: string | null): string | null => {
  const trimmed = value?.trim();

  if (!trimmed) {
    return null;
  }

  return createHash("sha256").update(trimmed).digest("hex");
};

const addDays = (date: Date, days: number): Date => new Date(date.getTime() + days * 24 * 60 * 60 * 1000);

const normalizeDeletionRequest = (row: Row | null): AccountDeletionStatus => {
  if (!row) {
    return {
      status: "none",
      requestId: null,
      requestedAt: null,
      scheduledDeletionAt: null,
      completedAt: null
    };
  }

  return {
    status: row.status as AccountDeletionStatus["status"],
    requestId: (row.id as string | undefined) ?? null,
    requestedAt: (row.requested_at as string | undefined) ?? null,
    scheduledDeletionAt: (row.scheduled_deletion_at as string | undefined) ?? null,
    completedAt: (row.completed_at as string | undefined) ?? null
  };
};

export const accountDeletionService = {
  async getStatus(userId: string): Promise<AccountDeletionStatus> {
    const { data, error } = await supabaseAdmin
      .from("account_deletion_requests")
      .select("*")
      .eq("user_id", userId)
      .order("requested_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    handleSupabaseError(error, "Unable to load account deletion request");
    return normalizeDeletionRequest((data as Row | null) ?? null);
  },

  async requestDeletion(
    userId: string,
    payload: DeletionRequestPayload = {},
    context: RequestContext = {},
    now = new Date()
  ): Promise<AccountDeletionStatus> {
    const existing = await this.getActiveRequest(userId);

    if (existing) {
      await this.disablePublicBooking(userId);
      await this.logAuditEvent(existing.id as string, userId, "duplicate_request", {
        clientRequestId: payload.clientRequestId ?? null,
        authSource: context.authSource ?? null
      });

      return {
        ...normalizeDeletionRequest(existing),
        publicBookingDisabled: true,
        message: "Your account deletion request has already been received."
      };
    }

    const requestedAt = now.toISOString();
    const scheduledDeletionAt = addDays(now, DEFAULT_DELETION_DELAY_DAYS).toISOString();
    const { data, error } = await supabaseAdmin
      .from("account_deletion_requests")
      .insert({
        user_id: userId,
        status: "pending",
        reason: payload.reason ?? null,
        client_request_id: payload.clientRequestId ?? null,
        requested_at: requestedAt,
        scheduled_deletion_at: scheduledDeletionAt,
        created_ip_hash: hashOptionalValue(context.ipAddress),
        created_user_agent: context.userAgent ?? null
      })
      .select("*")
      .single();

    handleSupabaseError(error, "Unable to create account deletion request");
    const request = data as Row;

    await this.disablePublicBooking(userId);
    await this.cancelPendingAutomation(userId);
    await this.logAuditEvent(request.id as string, userId, "requested", {
      clientRequestId: payload.clientRequestId ?? null,
      authSource: context.authSource ?? null
    });

    return {
      ...normalizeDeletionRequest(request),
      publicBookingDisabled: true,
      message: "Your account deletion request has been received."
    };
  },

  async getActiveRequest(userId: string): Promise<Row | null> {
    const { data, error } = await supabaseAdmin
      .from("account_deletion_requests")
      .select("*")
      .eq("user_id", userId)
      .in("status", ACTIVE_DELETION_STATUSES)
      .order("requested_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    handleSupabaseError(error, "Unable to load account deletion request");
    return (data as Row | null) ?? null;
  },

  async disablePublicBooking(userId: string): Promise<void> {
    const { error } = await supabaseAdmin
      .from("stylists")
      .update({ booking_enabled: false })
      .eq("user_id", userId);

    handleSupabaseError(error, "Unable to disable public booking for account deletion");
  },

  async cancelPendingAutomation(userId: string): Promise<void> {
    const nowIso = new Date().toISOString();
    const updates = [
      supabaseAdmin
        .from("rebook_nudges")
        .update({ status: "cancelled", cancelled_at: nowIso, cancelled_reason: "account_deletion_requested" })
        .eq("user_id", userId)
        .in("status", ["pending_approval", "queued", "sending", "failed"]),
      supabaseAdmin
        .from("birthday_reminders")
        .update({ status: "cancelled", cancelled_at: nowIso, cancelled_reason: "account_deletion_requested" })
        .eq("user_id", userId)
        .in("status", ["queued", "sending", "failed"]),
      supabaseAdmin
        .from("appointment_email_events")
        .update({ status: "skipped", error: "account_deletion_requested" })
        .eq("user_id", userId)
        .in("status", ["queued", "sending", "failed"])
    ];

    const results = await Promise.all(updates);

    for (const result of results) {
      handleSupabaseError(result.error, "Unable to cancel pending account automation");
    }
  },

  async logAuditEvent(requestId: string, userId: string, eventType: string, metadata: Row = {}): Promise<void> {
    const { error } = await supabaseAdmin
      .from("account_deletion_audit_events")
      .insert({
        request_id: requestId,
        user_id: userId,
        event_type: eventType,
        metadata
      });

    handleSupabaseError(error, "Unable to write account deletion audit event");
  }
};
