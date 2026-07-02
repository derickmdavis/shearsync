import { ApiError, requireFound } from "../lib/errors";
import { logger } from "../lib/logger";
import { normalizeEmail } from "../lib/communications";
import { addDays, formatDateInTimeZone, getCurrentLocalDate, zonedDateTimeToUtc } from "../lib/timezone";
import { normalizeBirthday, toBirthdayOccurrence } from "../lib/birthday";
import { supabaseAdmin } from "../lib/supabase";
import type { Row } from "./db";
import { handleSupabaseError } from "./db";
import { appointmentEmailTemplatesService } from "./appointmentEmailTemplatesService";
import { businessTimeZoneService } from "./businessTimeZoneService";
import { usersService } from "./usersService";
import { entitlementsService } from "./entitlementsService";

type BirthdayReminderStatus = "queued" | "sending" | "sent" | "cancelled" | "skipped" | "failed";

interface ListBirthdayReminderFilters {
  limit: number;
  cursor?: string;
}

interface ProcessQueuedBirthdayEmailOptions {
  requestId?: string;
}

interface CursorPayload {
  scheduled_send_at: string;
  id: string;
}

const defaultWindowDays = 30;
const upcomingFlagWindowDays = 7;
const activeStatuses: BirthdayReminderStatus[] = ["queued", "sending", "failed"];
const skippableEmailStatuses = ["queued", "failed", "sending"];

const getString = (row: Row | null | undefined, key: string): string | null =>
  typeof row?.[key] === "string" && String(row[key]).trim().length > 0 ? String(row[key]).trim() : null;

const parseDateText = (dateText: string): { year: number; month: number; day: number } | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText);
  if (!match) {
    return null;
  }

  const [, yearText, monthText, dayText] = match;
  return {
    year: Number(yearText),
    month: Number(monthText),
    day: Number(dayText)
  };
};

const daysBetweenDates = (startDate: string, endDate: string): number => {
  const start = parseDateText(startDate);
  const end = parseDateText(endDate);
  if (!start || !end) {
    return Number.POSITIVE_INFINITY;
  }

  const startMs = Date.UTC(start.year, start.month - 1, start.day);
  const endMs = Date.UTC(end.year, end.month - 1, end.day);

  return Math.round((endMs - startMs) / 86_400_000);
};

const getClientDisplayName = (client: Row | null | undefined): string => {
  const preferredName = getString(client, "preferred_name");
  const firstName = getString(client, "first_name");
  const lastName = getString(client, "last_name");
  return preferredName ?? ([firstName, lastName].filter(Boolean).join(" ").trim() || "Client");
};

const getBusinessDisplayName = (user: Row | null): string => {
  const businessName = getString(user, "business_name");
  const fullName = getString(user, "full_name");
  const email = normalizeEmail(user?.email);
  return businessName ?? fullName ?? email ?? "Your stylist";
};

const toApiReminder = (row: Row): Row => {
  const templateData = (row.template_data ?? {}) as Row;
  const daysUntil = typeof templateData.days_until === "number" ? templateData.days_until : null;

  return {
    reminder_id: row.id,
    client_id: row.client_id,
    client_name: getString(templateData, "client_name") ?? "Client",
    client_email: row.recipient_email ?? null,
    birthday: row.birthday,
    birthday_label: getString(templateData, "birthday_label"),
    scheduled_send_at: row.scheduled_send_at,
    status: row.status,
    upcoming_birthday: typeof daysUntil === "number" ? daysUntil <= upcomingFlagWindowDays : false
  };
};

const encodeCursor = (row: Row): string =>
  Buffer.from(JSON.stringify({
    scheduled_send_at: String(row.scheduled_send_at ?? ""),
    id: String(row.id ?? "")
  } satisfies CursorPayload), "utf8").toString("base64url");

const decodeCursor = (cursor: string): CursorPayload => {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as CursorPayload;
    if (typeof parsed.scheduled_send_at !== "string" || typeof parsed.id !== "string") {
      throw new Error("Invalid cursor shape");
    }

    return parsed;
  } catch {
    throw new ApiError(400, "Invalid birthday reminder cursor");
  }
};

const createTemplateData = async ({
  userId,
  client,
  birthday,
  occurrenceDate,
  scheduledSendAt,
  timeZone,
  today
}: {
  userId: string;
  client: Row;
  birthday: string;
  occurrenceDate: string;
  scheduledSendAt: string;
  timeZone: string;
  today: string;
}): Promise<Row> => {
  const [user, emailTemplate] = await Promise.all([
    usersService.getById(userId),
    appointmentEmailTemplatesService.getSnapshotForUser(userId, "birthday_reminder")
  ]);
  const clientName = getClientDisplayName(client);
  const businessDisplayName = getBusinessDisplayName(user);
  const birthdayLabel = formatDateInTimeZone(zonedDateTimeToUtc(occurrenceDate, timeZone, 12), timeZone, {
    month: "long",
    day: "numeric"
  });

  return {
    recipient_name: clientName,
    client_name: clientName,
    birthday,
    birthday_occurrence_date: occurrenceDate,
    birthday_label: birthdayLabel,
    birthday_display: birthdayLabel,
    scheduled_send_at: scheduledSendAt,
    business_timezone: timeZone,
    business_name: getString(user, "business_name"),
    business_display_name: businessDisplayName,
    business_phone: getString(user, "phone_number"),
    business_email: normalizeEmail(user?.email),
    days_until: daysBetweenDates(today, occurrenceDate),
    message_type: "birthday_reminder",
    ...(emailTemplate ? { email_template: emailTemplate } : {})
  };
};

const skipLinkedEmailEvent = async (reminder: Row, reason: string): Promise<void> => {
  const emailEventId = getString(reminder, "email_event_id");
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

  handleSupabaseError(error, "Unable to skip linked birthday email");
};

const queueEmailForReminder = async (reminder: Row): Promise<Row | null> => {
  const reminderId = String(reminder.id ?? "");
  const existingEventId = getString(reminder, "email_event_id");
  if (existingEventId) {
    return null;
  }

  const idempotencyKey = `birthday_reminder:${reminderId}`;
  const { data: existing, error: existingError } = await supabaseAdmin
    .from("appointment_email_events")
    .select("*")
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();

  handleSupabaseError(existingError, "Unable to validate birthday email uniqueness");
  if (existing) {
    return existing as Row;
  }

  const templateData = (reminder.template_data ?? {}) as Row;
  const existingEmailTemplate = (templateData.email_template ?? {}) as Row;
  const emailTemplate = {
    subject_template: getString(reminder, "subject_snapshot") ?? getString(existingEmailTemplate, "subject_template"),
    custom_message_block: getString(reminder, "custom_message_block_snapshot") ?? getString(existingEmailTemplate, "custom_message_block")
  };
  const { data, error } = await supabaseAdmin
    .from("appointment_email_events")
    .insert({
      user_id: reminder.user_id,
      client_id: reminder.client_id,
      appointment_id: null,
      birthday_reminder_id: reminderId,
      email_type: "birthday_reminder",
      recipient_email: reminder.recipient_email,
      status: "queued",
      idempotency_key: idempotencyKey,
      template_data: {
        ...templateData,
        message_type: "birthday_reminder",
        email_template: emailTemplate
      }
    })
    .select("*")
    .single();

  handleSupabaseError(error, "Unable to queue birthday email");
  return data as Row;
};

const claimQueuedBirthdayReminderForEmail = async (reminder: Row, now: Date): Promise<Row | null> => {
  const reminderId = String(reminder.id ?? "");
  if (!reminderId) {
    return null;
  }

  const { data, error } = await supabaseAdmin
    .from("birthday_reminders")
    .update({
      status: "sending",
      error: null
    })
    .eq("id", reminderId)
    .eq("status", "queued")
    .lt("scheduled_send_at", now.toISOString())
    .select("*")
    .maybeSingle();

  handleSupabaseError(error, "Unable to claim birthday reminder for email");
  return data as Row | null;
};

const markBirthdayEmailQueueFailure = async (reminderId: string, error: unknown): Promise<void> => {
  const message = error instanceof Error ? error.message : "Unable to queue birthday reminder email";
  const { error: updateError } = await supabaseAdmin
    .from("birthday_reminders")
    .update({
      status: "failed",
      error: message
    })
    .eq("id", reminderId)
    .eq("status", "sending");

  handleSupabaseError(updateError, "Unable to mark birthday reminder email queue failure");
};

const isBirthdayRemindersEnabled = async (userId: string): Promise<boolean> => {
  if (!(await entitlementsService.isFeatureAllowed(userId, "birthdayReminders"))) {
    return false;
  }

  const { data, error } = await supabaseAdmin
    .from("automation_settings")
    .select("enabled")
    .eq("user_id", userId)
    .eq("key", "birthday_reminders")
    .maybeSingle();

  handleSupabaseError(error, "Unable to load birthday reminder automation setting");
  return data?.enabled === true;
};

export const birthdayRemindersService = {
  async queueUpcomingForUser(userId: string, now = new Date(), windowDays = defaultWindowDays): Promise<{ queued: number; skipped: number }> {
    if (!(await isBirthdayRemindersEnabled(userId))) {
      return { queued: 0, skipped: 0 };
    }

    const timeZone = await businessTimeZoneService.getForUser(userId);
    const today = getCurrentLocalDate(timeZone, now);
    const windowEndDate = addDays(today, windowDays);
    const currentYear = Number(today.slice(0, 4));

    const { data: clients, error: clientsError } = await supabaseAdmin
      .from("clients")
      .select("id, first_name, last_name, preferred_name, email, birthday")
      .eq("user_id", userId)
      .order("first_name", { ascending: true });

    handleSupabaseError(clientsError, "Unable to load birthday reminder clients");

    const candidates = ((clients ?? []) as Row[])
      .map((client): { client: Row; birthday: string; occurrenceDate: string; recipientEmail: string } | null => {
        const birthday = normalizeBirthday(client.birthday);
        const clientId = getString(client, "id");
        const recipientEmail = normalizeEmail(client.email);
        if (!clientId || !birthday || !recipientEmail) {
          return null;
        }

        const thisYearBirthday = toBirthdayOccurrence(birthday, currentYear);
        const occurrenceDate = thisYearBirthday && thisYearBirthday >= today
          ? thisYearBirthday
          : toBirthdayOccurrence(birthday, currentYear + 1);

        if (!occurrenceDate || occurrenceDate > windowEndDate) {
          return null;
        }

        return { client, birthday, occurrenceDate, recipientEmail };
      })
      .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);

    if (candidates.length === 0) {
      return { queued: 0, skipped: ((clients ?? []) as Row[]).length };
    }

    const clientIds = candidates.map((candidate) => String(candidate.client.id));
    const { data: existingRows, error: existingError } = await supabaseAdmin
      .from("birthday_reminders")
      .select("id, client_id, birthday_occurrence_date, status")
      .eq("user_id", userId)
      .in("client_id", clientIds)
      .in("status", activeStatuses);

    handleSupabaseError(existingError, "Unable to load existing birthday reminders");
    const existingKeys = new Set(
      ((existingRows ?? []) as Row[])
        .map((row) => `${row.client_id}:${row.birthday_occurrence_date}`)
    );

    let queued = 0;
    let skipped = 0;
    for (const candidate of candidates) {
      const clientId = String(candidate.client.id);
      const existingKey = `${clientId}:${candidate.occurrenceDate}`;
      if (existingKeys.has(existingKey)) {
        skipped += 1;
        continue;
      }

      const scheduledSendAt = zonedDateTimeToUtc(candidate.occurrenceDate, timeZone, 9, 0, 0, 0).toISOString();
      const templateData = await createTemplateData({
        userId,
        client: candidate.client,
        birthday: candidate.birthday,
        occurrenceDate: candidate.occurrenceDate,
        scheduledSendAt,
        timeZone,
        today
      });
      const emailTemplate = (templateData.email_template ?? {}) as Row;

      const { error } = await supabaseAdmin
        .from("birthday_reminders")
        .insert({
          user_id: userId,
          client_id: clientId,
          recipient_email: candidate.recipientEmail,
          birthday: candidate.birthday,
          birthday_occurrence_date: candidate.occurrenceDate,
          scheduled_send_at: scheduledSendAt,
          status: "queued",
          subject_snapshot: getString(emailTemplate, "subject_template"),
          custom_message_block_snapshot: getString(emailTemplate, "custom_message_block"),
          template_data: templateData
        });

      handleSupabaseError(error, "Unable to create birthday reminder");
      existingKeys.add(existingKey);
      queued += 1;
    }

    return { queued, skipped };
  },

  async queueUpcoming(now = new Date(), limit = 100): Promise<{ processed_users: number; queued: number; skipped: number }> {
    const { data, error } = await supabaseAdmin
      .from("users")
      .select("id")
      .limit(limit);

    handleSupabaseError(error, "Unable to load users for birthday reminder queue");

    let queued = 0;
    let skipped = 0;
    for (const user of (data ?? []) as Row[]) {
      const userId = String(user.id ?? "");
      if (!userId) {
        continue;
      }

      const result = await this.queueUpcomingForUser(userId, now, defaultWindowDays);
      queued += result.queued;
      skipped += result.skipped;
    }

    return {
      processed_users: ((data ?? []) as Row[]).length,
      queued,
      skipped
    };
  },

  async listForUser(userId: string, filters: ListBirthdayReminderFilters) {
    await entitlementsService.assertFeatureAllowed(userId, "birthdayReminders");

    const cursor = filters.cursor ? decodeCursor(filters.cursor) : null;
    let query = supabaseAdmin
      .from("birthday_reminders")
      .select("*")
      .eq("user_id", userId)
      .in("status", activeStatuses);

    if (cursor) {
      query = query.or(`scheduled_send_at.gt.${cursor.scheduled_send_at},and(scheduled_send_at.eq.${cursor.scheduled_send_at},id.gt.${cursor.id})`);
    }

    const { data, error } = await query
      .order("scheduled_send_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(filters.limit + 1);

    handleSupabaseError(error, "Unable to load birthday reminders");
    const fetchedRows = (data ?? []) as Row[];
    const rows = fetchedRows.slice(0, filters.limit);
    const nextCursor = fetchedRows.length > filters.limit && rows.length > 0
      ? encodeCursor(rows[rows.length - 1] as Row)
      : null;

    return {
      data: rows.map(toApiReminder),
      next_cursor: nextCursor
    };
  },

  async getQueuedForUser(userId: string, limit = 50): Promise<Row[]> {
    if (!(await entitlementsService.isFeatureAllowed(userId, "birthdayReminders"))) {
      return [];
    }

    const { data, error } = await supabaseAdmin
      .from("birthday_reminders")
      .select("*")
      .eq("user_id", userId)
      .eq("status", "queued")
      .gte("scheduled_send_at", new Date().toISOString())
      .order("scheduled_send_at", { ascending: true })
      .limit(limit);

    handleSupabaseError(error, "Unable to load birthday reminder queue");
    return ((data ?? []) as Row[]).map(toApiReminder);
  },

  async getCountsForUser(userId: string): Promise<{ queued: number }> {
    if (!(await entitlementsService.isFeatureAllowed(userId, "birthdayReminders"))) {
      return {
        queued: 0
      };
    }

    const { count, data, error } = await supabaseAdmin
      .from("birthday_reminders")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .in("status", activeStatuses);

    handleSupabaseError(error, "Unable to load birthday reminder count");
    return {
      queued: Array.isArray(data) ? data.length : count ?? 0
    };
  },

  async cancelForUser(userId: string, reminderId: string, reason?: string | null): Promise<Row> {
    await entitlementsService.assertFeatureAllowed(userId, "birthdayReminders");

    const { data, error } = await supabaseAdmin
      .from("birthday_reminders")
      .update({
        status: "cancelled",
        cancelled_at: new Date().toISOString(),
        cancelled_reason: reason?.trim() || "User chose not to send this year's birthday email"
      })
      .eq("user_id", userId)
      .eq("id", reminderId)
      .in("status", activeStatuses)
      .select("*")
      .maybeSingle();

    handleSupabaseError(error, "Unable to cancel birthday reminder");
    const reminder = requireFound(data, "Active birthday reminder not found");
    await skipLinkedEmailEvent(reminder, "Birthday reminder cancelled");
    return toApiReminder(reminder);
  },

  async processQueuedBirthdayEmails(
    now = new Date(),
    limit = 50,
    options: ProcessQueuedBirthdayEmailOptions = {}
  ): Promise<{ processed: number; queued_emails: number }> {
    const { data, error } = await supabaseAdmin
      .from("birthday_reminders")
      .select("*")
      .eq("status", "queued")
      .lt("scheduled_send_at", now.toISOString())
      .order("scheduled_send_at", { ascending: true })
      .limit(limit);

    handleSupabaseError(error, "Unable to load queued birthday reminders");
    const candidates = (data ?? []) as Row[];
    const oldestDueAt = getString(candidates.find((reminder) => getString(reminder, "scheduled_send_at")), "scheduled_send_at");
    const lagSeconds = oldestDueAt
      ? Math.max(0, Math.floor((now.getTime() - new Date(oldestDueAt).getTime()) / 1000))
      : null;
    logger.info("birthday_reminder_email_processing_started", {
      requestId: options.requestId,
      candidateCount: candidates.length,
      oldestDueAt,
      lagSeconds
    });

    let processed = 0;
    let queuedEmails = 0;

    for (const reminder of candidates) {
      const userId = String(reminder.user_id ?? "");
      if (!userId || !(await entitlementsService.isFeatureAllowed(userId, "birthdayReminders"))) {
        continue;
      }

      const claimedReminder = await claimQueuedBirthdayReminderForEmail(reminder, now);
      if (!claimedReminder) {
        continue;
      }

      processed += 1;
      const reminderId = String(claimedReminder.id ?? "");
      try {
        const emailEvent = await queueEmailForReminder(claimedReminder);
        if (!emailEvent) {
          continue;
        }

        queuedEmails += 1;
        const { error: updateError } = await supabaseAdmin
          .from("birthday_reminders")
          .update({
            email_event_id: emailEvent.id,
            error: null
          })
          .eq("id", reminderId)
          .eq("status", "sending");

        handleSupabaseError(updateError, "Unable to link queued birthday reminder email");
      } catch (queueError) {
        await markBirthdayEmailQueueFailure(reminderId, queueError);
        logger.error("birthday_reminder_email_queue_failed", {
          requestId: options.requestId,
          birthdayReminderId: reminderId,
          userId,
          errorMessage: queueError instanceof Error ? queueError.message : String(queueError)
        });
      }
    }

    logger.info("birthday_reminder_email_processing_completed", {
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
    const reminderId = getString(emailEvent, "birthday_reminder_id");
    if (!reminderId) {
      return;
    }

    const { error: updateError } = await supabaseAdmin
      .from("birthday_reminders")
      .update({
        status,
        sent_at: status === "sent" ? new Date().toISOString() : null,
        error: error ?? null
      })
      .eq("id", reminderId);

    handleSupabaseError(updateError, "Unable to update birthday reminder delivery status");
  }
};
