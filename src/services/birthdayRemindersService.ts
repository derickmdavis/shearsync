import { ApiError, requireFound } from "../lib/errors";
import { normalizeEmail } from "../lib/communications";
import { addDays, formatDateInTimeZone, getCurrentLocalDate, zonedDateTimeToUtc } from "../lib/timezone";
import { supabaseAdmin } from "../lib/supabase";
import type { Row } from "./db";
import { handleSupabaseError } from "./db";
import { businessTimeZoneService } from "./businessTimeZoneService";
import { usersService } from "./usersService";

type BirthdayReminderStatus = "queued" | "sending" | "sent" | "cancelled" | "skipped" | "failed";

interface ListBirthdayReminderFilters {
  limit: number;
  cursor?: string;
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

const pad = (value: number): string => String(value).padStart(2, "0");

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

const toBirthdayOccurrence = (birthday: string, year: number): string | null => {
  const parts = parseDateText(birthday);
  if (!parts || !Number.isFinite(parts.year) || !Number.isFinite(parts.month) || !Number.isFinite(parts.day)) {
    return null;
  }

  const lastDayOfMonth = new Date(Date.UTC(year, parts.month, 0)).getUTCDate();
  const day = Math.min(parts.day, lastDayOfMonth);

  return `${year}-${pad(parts.month)}-${pad(day)}`;
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

const normalizeDate = (value: unknown): string | null =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;

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
  const user = await usersService.getById(userId);
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
    message_type: "birthday_reminder"
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
        ...((reminder.template_data ?? {}) as Row),
        message_type: "birthday_reminder"
      }
    })
    .select("*")
    .single();

  handleSupabaseError(error, "Unable to queue birthday email");
  return data as Row;
};

export const birthdayRemindersService = {
  async queueUpcomingForUser(userId: string, now = new Date(), windowDays = defaultWindowDays): Promise<{ queued: number; skipped: number }> {
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
        const birthday = normalizeDate(client.birthday);
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
    const { data, error } = await supabaseAdmin
      .from("birthday_reminders")
      .select("*")
      .eq("user_id", userId)
      .in("status", activeStatuses)
      .order("scheduled_send_at", { ascending: true })
      .limit(limit);

    handleSupabaseError(error, "Unable to load birthday reminder queue");
    return ((data ?? []) as Row[]).map(toApiReminder);
  },

  async getCountsForUser(userId: string): Promise<{ queued: number }> {
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

  async processQueuedBirthdayEmails(now = new Date(), limit = 50): Promise<{ processed: number; queued_emails: number }> {
    const { data, error } = await supabaseAdmin
      .from("birthday_reminders")
      .select("*")
      .eq("status", "queued")
      .lt("scheduled_send_at", now.toISOString())
      .order("scheduled_send_at", { ascending: true })
      .limit(limit);

    handleSupabaseError(error, "Unable to load queued birthday reminders");
    let queuedEmails = 0;

    for (const reminder of (data ?? []) as Row[]) {
      const emailEvent = await queueEmailForReminder(reminder);
      if (!emailEvent) {
        continue;
      }

      queuedEmails += 1;
      const { error: updateError } = await supabaseAdmin
        .from("birthday_reminders")
        .update({
          status: "sending",
          email_event_id: emailEvent.id,
          error: null
        })
        .eq("id", reminder.id);

      handleSupabaseError(updateError, "Unable to mark birthday reminder email queued");
    }

    return {
      processed: ((data ?? []) as Row[]).length,
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
