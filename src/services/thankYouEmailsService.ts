import QRCode from "qrcode";
import { ApiError, requireFound } from "../lib/errors";
import { logger } from "../lib/logger";
import { normalizeEmail } from "../lib/communications";
import { formatDateInTimeZone } from "../lib/timezone";
import { supabaseAdmin } from "../lib/supabase";
import type { Row, RowList } from "./db";
import { handleSupabaseError } from "./db";
import { businessTimeZoneService } from "./businessTimeZoneService";
import { appointmentEmailTemplatesService } from "./appointmentEmailTemplatesService";
import { entitlementsService } from "./entitlementsService";
import { referralLinksService } from "./referralLinksService";
import { thankYouEmailSettingsService } from "./thankYouEmailSettingsService";
import { usersService } from "./usersService";

type ThankYouEmailStatus =
  | "pending_approval"
  | "queued"
  | "sending"
  | "sent"
  | "cancelled"
  | "skipped"
  | "failed"
  | "superseded";

interface ListThankYouEmailsFilters {
  status?: ThankYouEmailStatus;
  limit: number;
  cursor?: string;
}

interface QueueManualThankYouEmailOptions {
  appointmentId: string;
  approvalRequired?: boolean;
}

interface ProcessQueuedThankYouEmailOptions {
  requestId?: string;
}

interface QueueDueOptions {
  userLimit?: number;
  perUserLimit?: number;
}

interface InsertThankYouEmailResult {
  row: Row;
  created: boolean;
}

interface CursorPayload {
  send_after: string;
  id: string;
}

const duplicateBlockingStatuses: ThankYouEmailStatus[] = ["pending_approval", "queued", "sending", "failed", "sent"];
const cancellableStatuses: ThankYouEmailStatus[] = ["pending_approval", "queued", "sending", "failed"];
const deliveryUpdatableStatuses: ThankYouEmailStatus[] = ["queued", "sending", "failed"];
const skippableEmailStatuses = ["queued", "failed", "sending"];
const defaultQueueUserLimit = 100;
const defaultQueuePerUserLimit = 50;

const isUniqueViolation = (error: { code?: string } | null): boolean => error?.code === "23505";

const getString = (row: Row | null | undefined, key: string): string | null =>
  typeof row?.[key] === "string" && String(row[key]).trim().length > 0 ? String(row[key]).trim() : null;

const addHoursToInstant = (instant: string, hours: number): string =>
  new Date(new Date(instant).getTime() + hours * 60 * 60_000).toISOString();

const getClientDisplayName = (client: Row | null | undefined): string => {
  const preferredName = getString(client, "preferred_name");
  const firstName = getString(client, "first_name");
  const lastName = getString(client, "last_name");
  return [firstName, lastName].filter(Boolean).join(" ").trim() || preferredName || firstName || "Client";
};

const getBusinessDisplayName = (user: Row | null): string => {
  const businessName = getString(user, "business_name");
  const fullName = getString(user, "full_name");
  const email = normalizeEmail(user?.email);
  return businessName ?? fullName ?? email ?? "Your stylist";
};

const encodeCursor = (row: Row): string =>
  Buffer.from(JSON.stringify({
    send_after: String(row.send_after ?? ""),
    id: String(row.id ?? "")
  } satisfies CursorPayload), "utf8").toString("base64url");

const decodeCursor = (cursor: string): CursorPayload => {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as CursorPayload;
    if (typeof parsed.send_after !== "string" || typeof parsed.id !== "string") {
      throw new Error("Invalid cursor shape");
    }

    return parsed;
  } catch {
    throw new ApiError(400, "Invalid thank you email cursor");
  }
};

const toApiThankYouEmail = (row: Row): Row => ({
  id: row.id,
  user_id: row.user_id,
  client_id: row.client_id,
  appointment_id: row.appointment_id,
  referral_link_id: row.referral_link_id ?? null,
  email_event_id: row.email_event_id ?? null,
  recipient_email: row.recipient_email,
  status: row.status,
  approval_required: row.approval_required,
  send_after: row.send_after,
  referral_code_snapshot: row.referral_code_snapshot ?? null,
  referral_url_snapshot: row.referral_url_snapshot ?? null,
  qr_code_url_snapshot: row.qr_code_url_snapshot ?? null,
  subject_snapshot: row.subject_snapshot ?? null,
  custom_message_block_snapshot: row.custom_message_block_snapshot ?? null,
  template_data: row.template_data ?? {},
  approved_at: row.approved_at ?? null,
  cancelled_at: row.cancelled_at ?? null,
  cancelled_reason: row.cancelled_reason ?? null,
  sent_at: row.sent_at ?? null,
  error: row.error ?? null,
  created_at: row.created_at,
  updated_at: row.updated_at
});

const isThankYouAutomationEnabled = async (userId: string): Promise<boolean> => {
  if (!(await entitlementsService.isFeatureAllowed(userId, "thankYouEmails"))) {
    return false;
  }

  const { data, error } = await supabaseAdmin
    .from("automation_settings")
    .select("enabled")
    .eq("user_id", userId)
    .eq("key", "thank_you_emails")
    .maybeSingle();

  handleSupabaseError(error, "Unable to load thank you email automation setting");
  return data?.enabled === true;
};

const loadDuplicateForAppointment = async (userId: string, appointmentId: string): Promise<Row | null> => {
  const { data, error } = await supabaseAdmin
    .from("thank_you_emails")
    .select("*")
    .eq("user_id", userId)
    .eq("appointment_id", appointmentId)
    .in("status", duplicateBlockingStatuses)
    .order("created_at", { ascending: false })
    .limit(1);

  handleSupabaseError(error, "Unable to load existing thank you email");
  return ((data ?? []) as Row[])[0] ?? null;
};

const loadAppointment = async (userId: string, appointmentId: string): Promise<Row | null> => {
  const { data, error } = await supabaseAdmin
    .from("appointments")
    .select("id, user_id, client_id, appointment_date, service_name, status")
    .eq("user_id", userId)
    .eq("id", appointmentId)
    .maybeSingle();

  handleSupabaseError(error, "Unable to load thank you email appointment");
  return data as Row | null;
};

const loadClient = async (userId: string, clientId: string): Promise<Row | null> => {
  const { data, error } = await supabaseAdmin
    .from("clients")
    .select("id, first_name, last_name, preferred_name, email")
    .eq("user_id", userId)
    .eq("id", clientId)
    .maybeSingle();

  handleSupabaseError(error, "Unable to load thank you email client");
  return data as Row | null;
};

const generateQrCodeDataUrl = async (referralUrl: string): Promise<string> =>
  QRCode.toDataURL(referralUrl, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 240
  });

const createTemplateData = async ({
  userId,
  client,
  appointment,
  referralLink
}: {
  userId: string;
  client: Row;
  appointment: Row;
  referralLink: Row;
}): Promise<Row> => {
  const [user, timeZone, settings] = await Promise.all([
    usersService.getById(userId),
    businessTimeZoneService.getForUser(userId),
    thankYouEmailSettingsService.getRawForUser(userId)
  ]);
  const emailTemplate = await appointmentEmailTemplatesService.getSnapshotForUser(userId, "thank_you_email");
  const appointmentDate = getString(appointment, "appointment_date") ?? "";
  const appointmentDisplay = appointmentDate
    ? formatDateInTimeZone(new Date(appointmentDate), timeZone, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric"
    })
    : "";
  const referralUrl = getString(referralLink, "referral_url") ?? "";
  const referralCode = getString(referralLink, "referral_code") ?? "";
  const qrCodeUrl = referralUrl ? await generateQrCodeDataUrl(referralUrl) : null;

  return {
    recipient_name: getClientDisplayName(client),
    service_name: getString(appointment, "service_name") ?? "your appointment",
    appointment_date: appointmentDate,
    appointment_date_display: appointmentDisplay,
    appointment_time_display: appointmentDisplay,
    business_timezone: timeZone,
    business_name: getString(user, "business_name"),
    business_display_name: getBusinessDisplayName(user),
    business_phone: getString(user, "phone_number"),
    business_email: normalizeEmail(user?.email),
    referral_url: referralUrl,
    referral_code: referralCode,
    qr_code_url: qrCodeUrl,
    message_type: "marketing",
    email_template: {
      subject_template: emailTemplate?.subject_template ?? getString(settings, "subject_template"),
      custom_message_block: emailTemplate?.custom_message_block ?? getString(settings, "custom_message_block")
    }
  };
};

const insertThankYouEmail = async ({
  userId,
  appointment,
  client,
  approvalRequired,
  sendDelayHours,
  now,
  requireDue
}: {
  userId: string;
  appointment: Row;
  client: Row;
  approvalRequired: boolean;
  sendDelayHours: number;
  now: Date;
  requireDue: boolean;
}): Promise<InsertThankYouEmailResult | null> => {
  const appointmentId = String(appointment.id ?? "");
  const clientId = String(client.id ?? "");
  const existing = await loadDuplicateForAppointment(userId, appointmentId);
  if (existing) {
    return {
      row: existing,
      created: false
    };
  }

  if (appointment.status !== "completed") {
    return null;
  }

  const recipientEmail = normalizeEmail(client.email);
  const appointmentDate = getString(appointment, "appointment_date");
  if (!recipientEmail || !appointmentDate) {
    return null;
  }

  const sendAfter = addHoursToInstant(appointmentDate, sendDelayHours);
  if (requireDue && sendAfter > now.toISOString()) {
    return null;
  }

  const referralLink = await referralLinksService.getOrCreateForClient(userId, clientId);
  const templateData = await createTemplateData({
    userId,
    client,
    appointment,
    referralLink
  });
  const emailTemplate = templateData.email_template as Row | undefined;

  const { data, error } = await supabaseAdmin
    .from("thank_you_emails")
    .insert({
      user_id: userId,
      client_id: clientId,
      appointment_id: appointmentId,
      referral_link_id: referralLink.id ?? null,
      recipient_email: recipientEmail,
      status: approvalRequired ? "pending_approval" : "queued",
      approval_required: approvalRequired,
      send_after: sendAfter,
      referral_code_snapshot: getString(referralLink, "referral_code"),
      referral_url_snapshot: getString(referralLink, "referral_url"),
      qr_code_url_snapshot: getString(templateData, "qr_code_url"),
      subject_snapshot: getString(emailTemplate, "subject_template"),
      custom_message_block_snapshot: getString(emailTemplate, "custom_message_block"),
      template_data: templateData
    })
    .select("*")
    .single();

  if (isUniqueViolation(error)) {
    const duplicate = await loadDuplicateForAppointment(userId, appointmentId);
    return duplicate
      ? {
        row: duplicate,
        created: false
      }
      : null;
  }

  handleSupabaseError(error, "Unable to create thank you email");
  return {
    row: data as Row,
    created: true
  };
};

const skipLinkedEmailEvent = async (thankYouEmail: Row, reason: string): Promise<void> => {
  const emailEventId = getString(thankYouEmail, "email_event_id");
  if (!emailEventId) {
    return;
  }

  const { error } = await supabaseAdmin
    .from("appointment_email_events")
    .update({
      status: "skipped",
      error: reason
    })
    .eq("id", emailEventId)
    .in("status", skippableEmailStatuses);

  handleSupabaseError(error, "Unable to skip linked thank you email");
};

const queueEmailForThankYou = async (thankYouEmail: Row): Promise<Row | null> => {
  const thankYouEmailId = String(thankYouEmail.id ?? "");
  const existingEventId = getString(thankYouEmail, "email_event_id");
  if (existingEventId) {
    return null;
  }

  const idempotencyKey = `thank_you_email:${thankYouEmailId}`;
  const { data: existing, error: existingError } = await supabaseAdmin
    .from("appointment_email_events")
    .select("*")
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();

  handleSupabaseError(existingError, "Unable to validate thank you email uniqueness");
  if (existing) {
    return existing as Row;
  }

  const templateData = (thankYouEmail.template_data ?? {}) as Row;
  const emailTemplate = {
    subject_template: getString(thankYouEmail, "subject_snapshot"),
    custom_message_block: getString(thankYouEmail, "custom_message_block_snapshot")
  };
  const { data, error } = await supabaseAdmin
    .from("appointment_email_events")
    .insert({
      user_id: thankYouEmail.user_id,
      client_id: thankYouEmail.client_id,
      appointment_id: thankYouEmail.appointment_id,
      thank_you_email_id: thankYouEmailId,
      email_type: "thank_you_email",
      recipient_email: thankYouEmail.recipient_email,
      status: "queued",
      idempotency_key: idempotencyKey,
      template_data: {
        ...templateData,
        message_type: "marketing",
        email_template: emailTemplate
      }
    })
    .select("*")
    .single();

  if (isUniqueViolation(error)) {
    const { data: duplicate, error: duplicateError } = await supabaseAdmin
      .from("appointment_email_events")
      .select("*")
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();

    handleSupabaseError(duplicateError, "Unable to load existing thank you email event");
    return duplicate as Row | null;
  }

  handleSupabaseError(error, "Unable to queue thank you email event");
  return data as Row;
};

const claimQueuedThankYouEmailForDelivery = async (thankYouEmail: Row, now: Date): Promise<Row | null> => {
  const thankYouEmailId = String(thankYouEmail.id ?? "");
  if (!thankYouEmailId) {
    return null;
  }

  const { data, error } = await supabaseAdmin
    .from("thank_you_emails")
    .update({
      status: "sending",
      error: null
    })
    .eq("id", thankYouEmailId)
    .eq("status", "queued")
    .lt("send_after", now.toISOString())
    .select("*")
    .maybeSingle();

  handleSupabaseError(error, "Unable to claim thank you email for delivery");
  return data as Row | null;
};

const markThankYouEmailQueueFailure = async (thankYouEmailId: string, error: unknown): Promise<void> => {
  const message = error instanceof Error ? error.message : "Unable to queue thank you email event";
  const { error: updateError } = await supabaseAdmin
    .from("thank_you_emails")
    .update({
      status: "failed",
      error: message
    })
    .eq("id", thankYouEmailId)
    .eq("status", "sending");

  handleSupabaseError(updateError, "Unable to mark thank you email queue failure");
};

export const thankYouEmailsService = {
  async listForUser(userId: string, filters: ListThankYouEmailsFilters) {
    await entitlementsService.assertFeatureAllowed(userId, "thankYouEmails");

    const cursor = filters.cursor ? decodeCursor(filters.cursor) : null;
    let query = supabaseAdmin
      .from("thank_you_emails")
      .select("*")
      .eq("user_id", userId);

    if (filters.status) {
      query = query.eq("status", filters.status);
    }

    if (cursor) {
      query = query.or(`send_after.lt.${cursor.send_after},and(send_after.eq.${cursor.send_after},id.lt.${cursor.id})`);
    }

    const { data, error } = await query
      .order("send_after", { ascending: false })
      .order("id", { ascending: false })
      .limit(filters.limit + 1);

    handleSupabaseError(error, "Unable to load thank you emails");
    const fetchedRows = (data ?? []) as Row[];
    const rows = fetchedRows.slice(0, filters.limit);
    const nextCursor = fetchedRows.length > filters.limit && rows.length > 0
      ? encodeCursor(rows[rows.length - 1] as Row)
      : null;

    return {
      data: rows.map(toApiThankYouEmail),
      next_cursor: nextCursor
    };
  },

  async getCountsForUser(userId: string): Promise<{ pending_approval: number; queued: number }> {
    if (!(await entitlementsService.isFeatureAllowed(userId, "thankYouEmails"))) {
      return {
        pending_approval: 0,
        queued: 0
      };
    }

    const [pendingResult, queuedResult] = await Promise.all([
      supabaseAdmin
        .from("thank_you_emails")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("status", "pending_approval"),
      supabaseAdmin
        .from("thank_you_emails")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .in("status", ["queued", "failed"])
    ]);

    handleSupabaseError(pendingResult.error, "Unable to load pending thank you email count");
    handleSupabaseError(queuedResult.error, "Unable to load queued thank you email count");

    return {
      pending_approval: pendingResult.count ?? 0,
      queued: Array.isArray(queuedResult.data) ? queuedResult.data.length : queuedResult.count ?? 0
    };
  },

  async queueManualForUser(userId: string, options: QueueManualThankYouEmailOptions): Promise<Row> {
    await entitlementsService.assertFeatureAllowed(userId, "thankYouEmails");

    const appointment = requireFound(await loadAppointment(userId, options.appointmentId), "Appointment not found");

    if (appointment.status !== "completed") {
      throw new ApiError(400, "Appointment is not eligible for a thank you email");
    }

    const clientId = getString(appointment, "client_id");
    if (!clientId) {
      throw new ApiError(400, "Appointment is missing a client");
    }

    const client = requireFound(await loadClient(userId, clientId), "Client not found");

    const settings = await thankYouEmailSettingsService.getRawForUser(userId);
    const sendDelayHours = Number(settings?.send_delay_hours ?? thankYouEmailSettingsService.defaultSendDelayHours);
    const approvalRequired = options.approvalRequired ?? settings?.approval_required !== false;
    const thankYouEmailResult = await insertThankYouEmail({
      userId,
      appointment,
      client,
      approvalRequired,
      sendDelayHours,
      now: new Date(),
      requireDue: false
    });

    if (!thankYouEmailResult) {
      throw new ApiError(400, "Unable to queue thank you email");
    }

    return toApiThankYouEmail(thankYouEmailResult.row);
  },

  async approveForUser(userId: string, thankYouEmailId: string): Promise<Row> {
    await entitlementsService.assertFeatureAllowed(userId, "thankYouEmails");

    const { data, error } = await supabaseAdmin
      .from("thank_you_emails")
      .update({
        status: "queued",
        approved_at: new Date().toISOString(),
        approved_by: userId,
        error: null
      })
      .eq("user_id", userId)
      .eq("id", thankYouEmailId)
      .eq("status", "pending_approval")
      .select("*")
      .maybeSingle();

    handleSupabaseError(error, "Unable to approve thank you email");
    return toApiThankYouEmail(requireFound(data, "Pending thank you email not found"));
  },

  async cancelForUser(userId: string, thankYouEmailId: string, reason?: string | null): Promise<Row> {
    await entitlementsService.assertFeatureAllowed(userId, "thankYouEmails");

    const { data, error } = await supabaseAdmin
      .from("thank_you_emails")
      .update({
        status: "cancelled",
        cancelled_at: new Date().toISOString(),
        cancelled_reason: reason?.trim() || null
      })
      .eq("user_id", userId)
      .eq("id", thankYouEmailId)
      .in("status", cancellableStatuses)
      .select("*")
      .maybeSingle();

    handleSupabaseError(error, "Unable to cancel thank you email");
    const thankYouEmail = requireFound(data, "Active thank you email not found");
    await skipLinkedEmailEvent(thankYouEmail, "Thank you email cancelled");
    return toApiThankYouEmail(thankYouEmail);
  },

  async queueDueForUser(userId: string, now = new Date(), limit = 50): Promise<{ queued: number; skipped: number }> {
    if (!(await isThankYouAutomationEnabled(userId))) {
      return { queued: 0, skipped: 0 };
    }

    const settings = await thankYouEmailSettingsService.getRawForUser(userId);
    const sendDelayHours = Number(settings?.send_delay_hours ?? thankYouEmailSettingsService.defaultSendDelayHours);
    const approvalRequired = settings?.approval_required !== false;
    const { data: appointments, error } = await supabaseAdmin
      .from("appointments")
      .select("id, user_id, client_id, appointment_date, service_name, status")
      .eq("user_id", userId)
      .eq("status", "completed")
      .lte("appointment_date", now.toISOString())
      .order("appointment_date", { ascending: false })
      .limit(limit * 3);

    handleSupabaseError(error, "Unable to load completed appointments for thank you emails");

    let queued = 0;
    let skipped = 0;
    for (const appointment of (appointments ?? []) as Row[]) {
      if (queued >= limit) {
        break;
      }

      const clientId = getString(appointment, "client_id");
      if (!clientId) {
        skipped += 1;
        continue;
      }

      const client = await loadClient(userId, clientId);
      if (!client || !normalizeEmail(client.email)) {
        skipped += 1;
        continue;
      }

      const thankYouEmailResult = await insertThankYouEmail({
        userId,
        appointment,
        client,
        approvalRequired,
        sendDelayHours,
        now,
        requireDue: true
      });

      if (thankYouEmailResult?.created) {
        queued += 1;
      } else {
        skipped += 1;
      }
    }

    return { queued, skipped };
  },

  async queueDue(
    now = new Date(),
    options: QueueDueOptions = {}
  ): Promise<{ processed_users: number; queued: number; skipped: number }> {
    const userLimit = options.userLimit ?? defaultQueueUserLimit;
    const perUserLimit = options.perUserLimit ?? defaultQueuePerUserLimit;
    const { data, error } = await supabaseAdmin
      .from("users")
      .select("id")
      .limit(userLimit);

    handleSupabaseError(error, "Unable to load users for thank you email queue");

    let queued = 0;
    let skipped = 0;
    for (const user of (data ?? []) as Row[]) {
      const userId = String(user.id ?? "");
      if (!userId) {
        continue;
      }

      const result = await this.queueDueForUser(userId, now, perUserLimit);
      queued += result.queued;
      skipped += result.skipped;
    }

    return {
      processed_users: ((data ?? []) as Row[]).length,
      queued,
      skipped
    };
  },

  async processQueuedThankYouEmails(
    now = new Date(),
    limit = 50,
    options: ProcessQueuedThankYouEmailOptions = {}
  ): Promise<{ processed: number; queued_emails: number }> {
    const { data, error } = await supabaseAdmin
      .from("thank_you_emails")
      .select("*")
      .eq("status", "queued")
      .lt("send_after", now.toISOString())
      .order("send_after", { ascending: true })
      .limit(limit);

    handleSupabaseError(error, "Unable to load queued thank you emails");
    const candidates = (data ?? []) as Row[];
    const oldestDueAt = getString(candidates.find((thankYouEmail) => getString(thankYouEmail, "send_after")), "send_after");
    const lagSeconds = oldestDueAt
      ? Math.max(0, Math.floor((now.getTime() - new Date(oldestDueAt).getTime()) / 1000))
      : null;
    logger.info("thank_you_email_processing_started", {
      requestId: options.requestId,
      candidateCount: candidates.length,
      oldestDueAt,
      lagSeconds
    });

    let processed = 0;
    let queuedEmails = 0;

    for (const thankYouEmail of candidates) {
      const userId = String(thankYouEmail.user_id ?? "");
      if (!userId || !(await entitlementsService.isFeatureAllowed(userId, "thankYouEmails"))) {
        continue;
      }

      const claimedThankYouEmail = await claimQueuedThankYouEmailForDelivery(thankYouEmail, now);
      if (!claimedThankYouEmail) {
        continue;
      }

      processed += 1;
      const thankYouEmailId = String(claimedThankYouEmail.id ?? "");
      try {
        const emailEvent = await queueEmailForThankYou(claimedThankYouEmail);
        if (!emailEvent) {
          continue;
        }

        queuedEmails += 1;
        const { error: updateError } = await supabaseAdmin
          .from("thank_you_emails")
          .update({
            email_event_id: emailEvent.id,
            error: null
          })
          .eq("id", thankYouEmailId)
          .eq("status", "sending");

        handleSupabaseError(updateError, "Unable to link queued thank you email event");
      } catch (queueError) {
        await markThankYouEmailQueueFailure(thankYouEmailId, queueError);
        logger.error("thank_you_email_queue_failed", {
          requestId: options.requestId,
          thankYouEmailId,
          userId,
          errorMessage: queueError instanceof Error ? queueError.message : String(queueError)
        });
      }
    }

    logger.info("thank_you_email_processing_completed", {
      requestId: options.requestId,
      processed,
      queuedEmails
    });

    return {
      processed,
      queued_emails: queuedEmails
    };
  },

  async markForEmailEvent(emailEvent: Row, status: "sent" | "failed" | "skipped", error?: string | null): Promise<void> {
    const thankYouEmailId = getString(emailEvent, "thank_you_email_id");
    if (!thankYouEmailId) {
      return;
    }

    const { error: updateError } = await supabaseAdmin
      .from("thank_you_emails")
      .update({
        status,
        sent_at: status === "sent" ? new Date().toISOString() : null,
        error: error ?? null
      })
      .eq("id", thankYouEmailId)
      .in("status", deliveryUpdatableStatuses);

    handleSupabaseError(updateError, "Unable to update thank you email delivery status");
  }
};
