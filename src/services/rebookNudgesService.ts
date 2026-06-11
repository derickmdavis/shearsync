import { env } from "../config/env";
import { ApiError, requireFound } from "../lib/errors";
import { normalizeEmail } from "../lib/communications";
import { formatDateInTimeZone } from "../lib/timezone";
import { supabaseAdmin } from "../lib/supabase";
import type { Row, RowList } from "./db";
import { handleSupabaseError } from "./db";
import { businessTimeZoneService } from "./businessTimeZoneService";
import { rebookNudgeSettingsService } from "./rebookNudgeSettingsService";
import { usersService } from "./usersService";

type RebookNudgeStatus =
  | "pending_approval"
  | "queued"
  | "sending"
  | "sent"
  | "cancelled"
  | "skipped"
  | "failed"
  | "superseded";

interface ListRebookNudgesFilters {
  status?: RebookNudgeStatus;
  limit: number;
  cursor?: string;
}

interface QueueManualRebookNudgeOptions {
  clientId: string;
  rebookIntervalDays?: number;
  approvalRequired?: boolean;
}

interface CursorPayload {
  send_after: string;
  id: string;
}

const activeStatuses: RebookNudgeStatus[] = ["pending_approval", "queued", "sending", "failed"];
const skippableEmailStatuses = ["queued", "failed", "sending"];

const isUniqueViolation = (error: { code?: string } | null): boolean => error?.code === "23505";

const getString = (row: Row | null | undefined, key: string): string | null =>
  typeof row?.[key] === "string" && String(row[key]).trim().length > 0 ? String(row[key]).trim() : null;

const addDaysToInstant = (instant: string, days: number): string =>
  new Date(new Date(instant).getTime() + days * 24 * 60 * 60_000).toISOString();

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

const getRebookUrl = async (userId: string, clientId: string): Promise<string | null> => {
  const baseUrl = env.WEB_APP_URL ?? env.CLIENT_APP_URL;
  if (!baseUrl) {
    return null;
  }

  const { data, error } = await supabaseAdmin
    .from("stylists")
    .select("slug")
    .eq("user_id", userId)
    .maybeSingle();

  handleSupabaseError(error, "Unable to load rebook nudge booking link");
  const slug = getString(data as Row | null, "slug");

  if (slug) {
    return `${baseUrl.replace(/\/+$/, "")}/book/${encodeURIComponent(slug)}`;
  }

  return `${baseUrl.replace(/\/+$/, "")}/clients/${encodeURIComponent(clientId)}`;
};

const createTemplateData = async ({
  userId,
  client,
  lastAppointment,
  intervalDays
}: {
  userId: string;
  client: Row;
  lastAppointment: Row;
  intervalDays: number;
}): Promise<Row> => {
  const [user, timeZone, settings] = await Promise.all([
    usersService.getById(userId),
    businessTimeZoneService.getForUser(userId),
    rebookNudgeSettingsService.getRawForUser(userId)
  ]);
  const clientName = getClientDisplayName(client);
  const businessDisplayName = getBusinessDisplayName(user);
  const lastAppointmentDate = getString(lastAppointment, "appointment_date") ?? "";
  const lastAppointmentDisplay = lastAppointmentDate
    ? formatDateInTimeZone(new Date(lastAppointmentDate), timeZone, {
      month: "long",
      day: "numeric",
      year: "numeric"
    })
    : "";
  const rebookUrl = await getRebookUrl(userId, String(client.id ?? ""));

  return {
    recipient_name: clientName,
    service_name: getString(lastAppointment, "service_name") ?? "your service",
    last_service_name: getString(lastAppointment, "service_name"),
    last_appointment_time: lastAppointmentDate,
    last_appointment_display: lastAppointmentDisplay,
    rebook_interval_days: intervalDays,
    business_timezone: timeZone,
    business_name: getString(user, "business_name"),
    business_display_name: businessDisplayName,
    business_phone: getString(user, "phone_number"),
    business_email: normalizeEmail(user?.email),
    rebook_url: rebookUrl,
    message_type: "rebooking_prompt",
    email_template: {
      subject_template: getString(settings, "subject_template"),
      custom_message_block: getString(settings, "custom_message_block")
    }
  };
};

const toApiNudge = (row: Row): Row => ({
  id: row.id,
  user_id: row.user_id,
  client_id: row.client_id,
  last_appointment_id: row.last_appointment_id ?? null,
  email_event_id: row.email_event_id ?? null,
  recipient_email: row.recipient_email,
  status: row.status,
  approval_required: row.approval_required,
  send_after: row.send_after,
  rebook_interval_days: row.rebook_interval_days,
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
    throw new ApiError(400, "Invalid rebook nudge cursor");
  }
};

const loadActiveNudge = async (userId: string, clientId: string, lastAppointmentId: string): Promise<Row | null> => {
  const { data, error } = await supabaseAdmin
    .from("rebook_nudges")
    .select("*")
    .eq("user_id", userId)
    .eq("client_id", clientId)
    .eq("last_appointment_id", lastAppointmentId)
    .in("status", activeStatuses)
    .order("created_at", { ascending: false })
    .limit(1);

  handleSupabaseError(error, "Unable to load existing rebook nudge");
  return ((data ?? []) as Row[])[0] ?? null;
};

const getLatestPastAppointment = async (userId: string, clientId: string, now: Date): Promise<Row | null> => {
  const { data, error } = await supabaseAdmin
    .from("appointments")
    .select("id, client_id, appointment_date, service_name, status")
    .eq("user_id", userId)
    .eq("client_id", clientId)
    .neq("status", "cancelled")
    .order("appointment_date", { ascending: false });

  handleSupabaseError(error, "Unable to load client appointments for rebook nudge");
  const appointments = (data ?? []) as Row[];
  const nowIso = now.toISOString();

  if (appointments.some((appointment) => getString(appointment, "appointment_date") && String(appointment.appointment_date) > nowIso)) {
    return null;
  }

  return appointments.find((appointment) => {
    const appointmentDate = getString(appointment, "appointment_date");
    return appointmentDate !== null && appointmentDate <= nowIso;
  }) ?? null;
};

const isRebookAutomationEnabled = async (userId: string): Promise<boolean> => {
  const { data, error } = await supabaseAdmin
    .from("automation_settings")
    .select("enabled")
    .eq("user_id", userId)
    .eq("key", "rebook_nudges")
    .maybeSingle();

  handleSupabaseError(error, "Unable to load rebook nudge automation setting");
  return data?.enabled !== false;
};

const insertNudge = async ({
  userId,
  client,
  lastAppointment,
  intervalDays,
  approvalRequired,
  now,
  requireDue
}: {
  userId: string;
  client: Row;
  lastAppointment: Row;
  intervalDays: number;
  approvalRequired: boolean;
  now: Date;
  requireDue: boolean;
}): Promise<Row | null> => {
  const clientId = String(client.id ?? "");
  const lastAppointmentId = String(lastAppointment.id ?? "");
  const existing = await loadActiveNudge(userId, clientId, lastAppointmentId);
  if (existing) {
    return existing;
  }

  const recipientEmail = normalizeEmail(client.email);
  const lastAppointmentDate = getString(lastAppointment, "appointment_date");
  if (!recipientEmail || !lastAppointmentDate) {
    return null;
  }

  const sendAfter = addDaysToInstant(lastAppointmentDate, intervalDays);
  if (requireDue && sendAfter > now.toISOString()) {
    return null;
  }

  const templateData = await createTemplateData({
    userId,
    client,
    lastAppointment,
    intervalDays
  });
  const emailTemplate = templateData.email_template as Row | undefined;
  const { data, error } = await supabaseAdmin
    .from("rebook_nudges")
    .insert({
      user_id: userId,
      client_id: clientId,
      last_appointment_id: lastAppointmentId,
      recipient_email: recipientEmail,
      status: approvalRequired ? "pending_approval" : "queued",
      approval_required: approvalRequired,
      send_after: sendAfter,
      rebook_interval_days: intervalDays,
      subject_snapshot: getString(emailTemplate, "subject_template"),
      custom_message_block_snapshot: getString(emailTemplate, "custom_message_block"),
      template_data: templateData
    })
    .select("*")
    .single();

  if (isUniqueViolation(error)) {
    return loadActiveNudge(userId, clientId, lastAppointmentId);
  }

  handleSupabaseError(error, "Unable to create rebook nudge");
  return data as Row;
};

const skipLinkedEmailEvent = async (nudge: Row, reason: string): Promise<void> => {
  const emailEventId = getString(nudge, "email_event_id");
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

  handleSupabaseError(error, "Unable to skip linked rebook email");
};

const queueEmailForNudge = async (nudge: Row): Promise<Row | null> => {
  const nudgeId = String(nudge.id ?? "");
  const existingEventId = getString(nudge, "email_event_id");
  if (existingEventId) {
    return null;
  }

  const idempotencyKey = `rebooking_prompt:${nudgeId}`;
  const { data: existing, error: existingError } = await supabaseAdmin
    .from("appointment_email_events")
    .select("*")
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();

  handleSupabaseError(existingError, "Unable to validate rebook email uniqueness");
  if (existing) {
    return existing as Row;
  }

  const templateData = (nudge.template_data ?? {}) as Row;
  const emailTemplate = {
    subject_template: getString(nudge, "subject_snapshot"),
    custom_message_block: getString(nudge, "custom_message_block_snapshot")
  };
  const { data, error } = await supabaseAdmin
    .from("appointment_email_events")
    .insert({
      user_id: nudge.user_id,
      client_id: nudge.client_id,
      appointment_id: nudge.last_appointment_id ?? null,
      rebook_nudge_id: nudgeId,
      email_type: "rebooking_prompt",
      recipient_email: nudge.recipient_email,
      status: "queued",
      idempotency_key: idempotencyKey,
      template_data: {
        ...templateData,
        message_type: "rebooking_prompt",
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

    handleSupabaseError(duplicateError, "Unable to load existing rebook email");
    return duplicate as Row | null;
  }

  handleSupabaseError(error, "Unable to queue rebook email");
  return data as Row;
};

export const rebookNudgesService = {
  async listForUser(userId: string, filters: ListRebookNudgesFilters) {
    const cursor = filters.cursor ? decodeCursor(filters.cursor) : null;
    let query = supabaseAdmin
      .from("rebook_nudges")
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

    handleSupabaseError(error, "Unable to load rebook nudges");
    const fetchedRows = (data ?? []) as Row[];
    const rows = fetchedRows.slice(0, filters.limit);
    const nextCursor = fetchedRows.length > filters.limit && rows.length > 0
      ? encodeCursor(rows[rows.length - 1] as Row)
      : null;

    return {
      data: rows.map(toApiNudge),
      next_cursor: nextCursor
    };
  },

  async getOutstandingForUser(userId: string, limit = 50): Promise<RowList> {
    const { data, error } = await supabaseAdmin
      .from("rebook_nudges")
      .select("*")
      .eq("user_id", userId)
      .eq("status", "pending_approval")
      .order("send_after", { ascending: true })
      .limit(limit);

    handleSupabaseError(error, "Unable to load outstanding rebook nudges");
    return ((data ?? []) as Row[]).map(toApiNudge);
  },

  async getCountsForUser(userId: string) {
    const [pendingResult, queuedResult] = await Promise.all([
      supabaseAdmin
        .from("rebook_nudges")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("status", "pending_approval"),
      supabaseAdmin
        .from("rebook_nudges")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .in("status", ["queued", "failed"])
    ]);

    handleSupabaseError(pendingResult.error, "Unable to load pending rebook nudge count");
    handleSupabaseError(queuedResult.error, "Unable to load queued rebook nudge count");

    return {
      pending_approval: pendingResult.count ?? 0,
      queued: Array.isArray(queuedResult.data) ? queuedResult.data.length : queuedResult.count ?? 0
    };
  },

  async queueManualForUser(userId: string, options: QueueManualRebookNudgeOptions): Promise<Row> {
    const settings = await rebookNudgeSettingsService.getRawForUser(userId);
    const intervalDays = options.rebookIntervalDays ?? Number(settings?.default_rebook_interval_days ?? rebookNudgeSettingsService.defaultIntervalDays);
    const approvalRequired = options.approvalRequired ?? settings?.approval_required !== false;

    if (!Number.isInteger(intervalDays) || intervalDays < 1 || intervalDays > 730) {
      throw new ApiError(400, "Rebook interval must be between 1 and 730 days");
    }

    const { data: client, error: clientError } = await supabaseAdmin
      .from("clients")
      .select("id, first_name, last_name, preferred_name, email")
      .eq("user_id", userId)
      .eq("id", options.clientId)
      .maybeSingle();

    handleSupabaseError(clientError, "Unable to load rebook nudge client");
    requireFound(client, "Client not found");

    const lastAppointment = await getLatestPastAppointment(userId, options.clientId, new Date());
    if (!lastAppointment) {
      throw new ApiError(400, "Client does not have an eligible past appointment");
    }

    const nudge = await insertNudge({
      userId,
      client: client as Row,
      lastAppointment,
      intervalDays,
      approvalRequired,
      now: new Date(),
      requireDue: false
    });

    if (!nudge) {
      throw new ApiError(400, "Unable to queue rebook nudge");
    }

    return toApiNudge(nudge);
  },

  async approveForUser(userId: string, nudgeId: string): Promise<Row> {
    const { data, error } = await supabaseAdmin
      .from("rebook_nudges")
      .update({
        status: "queued",
        approved_at: new Date().toISOString(),
        approved_by: userId,
        error: null
      })
      .eq("user_id", userId)
      .eq("id", nudgeId)
      .eq("status", "pending_approval")
      .select("*")
      .maybeSingle();

    handleSupabaseError(error, "Unable to approve rebook nudge");
    return toApiNudge(requireFound(data, "Pending rebook nudge not found"));
  },

  async cancelForUser(userId: string, nudgeId: string, reason?: string | null): Promise<Row> {
    const { data, error } = await supabaseAdmin
      .from("rebook_nudges")
      .update({
        status: "cancelled",
        cancelled_at: new Date().toISOString(),
        cancelled_reason: reason?.trim() || null
      })
      .eq("user_id", userId)
      .eq("id", nudgeId)
      .in("status", activeStatuses)
      .select("*")
      .maybeSingle();

    handleSupabaseError(error, "Unable to cancel rebook nudge");
    const nudge = requireFound(data, "Active rebook nudge not found");
    await skipLinkedEmailEvent(nudge, "Rebook nudge cancelled");
    return toApiNudge(nudge);
  },

  async queueDueNudgesForUser(userId: string, now = new Date(), limit = 50): Promise<{ queued: number; skipped: number }> {
    if (!(await isRebookAutomationEnabled(userId))) {
      return { queued: 0, skipped: 0 };
    }

    const settings = await rebookNudgeSettingsService.getRawForUser(userId);
    const intervalDays = Number(settings?.default_rebook_interval_days ?? rebookNudgeSettingsService.defaultIntervalDays);
    const approvalRequired = settings?.approval_required !== false;
    const { data: clients, error: clientsError } = await supabaseAdmin
      .from("clients")
      .select("id, first_name, last_name, preferred_name, email")
      .eq("user_id", userId)
      .limit(limit * 3);

    handleSupabaseError(clientsError, "Unable to load rebook nudge clients");

    let queued = 0;
    let skipped = 0;
    for (const client of (clients ?? []) as Row[]) {
      if (queued >= limit) {
        break;
      }

      const clientId = String(client.id ?? "");
      const recipientEmail = normalizeEmail(client.email);
      if (!clientId || !recipientEmail) {
        skipped += 1;
        continue;
      }

      const lastAppointment = await getLatestPastAppointment(userId, clientId, now);
      if (!lastAppointment) {
        skipped += 1;
        continue;
      }

      const nudge = await insertNudge({
        userId,
        client,
        lastAppointment,
        intervalDays,
        approvalRequired,
        now,
        requireDue: true
      });

      if (nudge) {
        queued += 1;
      } else {
        skipped += 1;
      }
    }

    return { queued, skipped };
  },

  async queueDueNudges(now = new Date(), limit = 100): Promise<{ processed_users: number; queued: number; skipped: number }> {
    const { data, error } = await supabaseAdmin
      .from("users")
      .select("id")
      .limit(limit);

    handleSupabaseError(error, "Unable to load users for rebook nudge queue");

    let queued = 0;
    let skipped = 0;
    for (const user of (data ?? []) as Row[]) {
      const userId = String(user.id ?? "");
      if (!userId) {
        continue;
      }

      const result = await this.queueDueNudgesForUser(userId, now, limit);
      queued += result.queued;
      skipped += result.skipped;
    }

    return {
      processed_users: ((data ?? []) as Row[]).length,
      queued,
      skipped
    };
  },

  async processQueuedNudgeEmails(now = new Date(), limit = 50): Promise<{ processed: number; queued_emails: number }> {
    const { data, error } = await supabaseAdmin
      .from("rebook_nudges")
      .select("*")
      .eq("status", "queued")
      .lt("send_after", now.toISOString())
      .order("send_after", { ascending: true })
      .limit(limit);

    handleSupabaseError(error, "Unable to load queued rebook nudges");
    let queuedEmails = 0;

    for (const nudge of (data ?? []) as Row[]) {
      const emailEvent = await queueEmailForNudge(nudge);
      if (!emailEvent) {
        continue;
      }

      queuedEmails += 1;
      const { error: updateError } = await supabaseAdmin
        .from("rebook_nudges")
        .update({
          status: "sending",
          email_event_id: emailEvent.id,
          error: null
        })
        .eq("id", nudge.id);

      handleSupabaseError(updateError, "Unable to mark rebook nudge email queued");
    }

    return {
      processed: ((data ?? []) as Row[]).length,
      queued_emails: queuedEmails
    };
  },

  async markForEmailEvent(emailEvent: Row, status: "sent" | "failed" | "skipped", error?: string | null): Promise<void> {
    const nudgeId = getString(emailEvent, "rebook_nudge_id");
    if (!nudgeId) {
      return;
    }

    const { error: updateError } = await supabaseAdmin
      .from("rebook_nudges")
      .update({
        status,
        sent_at: status === "sent" ? new Date().toISOString() : null,
        error: error ?? null
      })
      .eq("id", nudgeId);

    handleSupabaseError(updateError, "Unable to update rebook nudge delivery status");
  },

  async supersedeActiveForClient(userId: string, clientId: string): Promise<void> {
    const { data, error } = await supabaseAdmin
      .from("rebook_nudges")
      .select("*")
      .eq("user_id", userId)
      .eq("client_id", clientId)
      .in("status", activeStatuses);

    handleSupabaseError(error, "Unable to load active rebook nudges for supersede");

    for (const nudge of (data ?? []) as Row[]) {
      await skipLinkedEmailEvent(nudge, "Rebook nudge superseded by future appointment");
    }

    const { error: updateError } = await supabaseAdmin
      .from("rebook_nudges")
      .update({
        status: "superseded",
        error: null
      })
      .eq("user_id", userId)
      .eq("client_id", clientId)
      .in("status", activeStatuses);

    handleSupabaseError(updateError, "Unable to supersede active rebook nudges");
  }
};
