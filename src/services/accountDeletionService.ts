import { createHash } from "crypto";
import { ApiError } from "../lib/errors";
import { supabaseAdmin } from "../lib/supabase";
import type { Row } from "./db";
import { handleSupabaseError } from "./db";

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
    const requestedAt = now.toISOString();
    const scheduledDeletionAt = addDays(now, DEFAULT_DELETION_DELAY_DAYS).toISOString();
    const { data, error } = await supabaseAdmin
      .rpc("request_account_deletion", {
        p_user_id: userId,
        p_reason: payload.reason ?? null,
        p_client_request_id: payload.clientRequestId ?? null,
        p_created_ip_hash: hashOptionalValue(context.ipAddress),
        p_created_user_agent: context.userAgent ?? null,
        p_requested_at: requestedAt,
        p_scheduled_deletion_at: scheduledDeletionAt,
        p_auth_source: context.authSource ?? null
      });

    handleSupabaseError(error, "Unable to create account deletion request");
    const result = data as Row | null;
    if (result?.active_administrator === true) {
      throw new ApiError(
        409,
        "Active administrator accounts must be transferred or disabled before deletion.",
        { code: "active_administrator" },
        { exposeDetails: true }
      );
    }
    const request = result?.request as Row | undefined;
    if (!result || !request) throw new ApiError(500, "Unable to create account deletion request");
    const duplicate = result.duplicate === true;

    return {
      ...normalizeDeletionRequest(request),
      publicBookingDisabled: true,
      message: duplicate
        ? "Your account deletion request has already been received."
        : "Your account deletion request has been received."
    };
  },

  async disablePublicBooking(userId: string): Promise<void> {
    const { error } = await supabaseAdmin
      .from("stylists")
      .update({ booking_enabled: false })
      .eq("user_id", userId);

    handleSupabaseError(error, "Unable to disable public booking for account deletion");
  },

  async disableAccountAccess(
    userId: string,
    nowIso = new Date().toISOString(),
    deletionStatus: "pending" | "processing" = "pending"
  ): Promise<void> {
    const { error } = await supabaseAdmin
      .from("users")
      .update({
        account_status: "inactive",
        deactivated_at: nowIso,
        deletion_status: deletionStatus,
        deletion_requested_at: nowIso
      })
      .eq("id", userId);

    handleSupabaseError(error, "Unable to disable account access for account deletion");
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
        .in("status", ["queued", "sending", "failed"]),
      supabaseAdmin
        .from("sms_messages")
        .update({ status: "cancelled", error_code: "account_deletion_requested", error_message: "Account deletion requested" })
        .eq("user_id", userId)
        .in("status", ["queued", "sending", "failed"]),
      supabaseAdmin
        .from("appointment_sms_confirmation_jobs")
        .update({ status: "skipped", error_code: "account_deletion_requested", error_message: "Account deletion requested" })
        .eq("user_id", userId)
        .in("status", ["pending", "queued"]),
      supabaseAdmin
        .from("thank_you_emails")
        .update({ status: "cancelled", cancelled_at: nowIso, cancelled_reason: "account_deletion_requested" })
        .eq("user_id", userId)
        .in("status", ["pending_approval", "queued", "sending", "failed"]),
      supabaseAdmin
        .from("campaigns")
        .update({ status: "cancelled", cancelled_at: nowIso, cancelled_reason: "account_deletion_requested" })
        .eq("user_id", userId)
        .in("status", ["draft", "scheduled"]),
      supabaseAdmin
        .from("campaign_runs")
        .update({ status: "cancelled", cancelled_at: nowIso })
        .eq("user_id", userId)
        .in("status", ["draft", "scheduled", "queued"]),
      supabaseAdmin
        .from("campaign_recipients")
        .update({ status: "cancelled", cancelled_at: nowIso, error_code: "account_deletion_requested" })
        .eq("user_id", userId)
        .in("status", ["pending", "queued", "failed"])
    ];

    const results = await Promise.all(updates);

    for (const result of results) {
      handleSupabaseError(result.error, "Unable to cancel pending account automation");
    }
  }
};
