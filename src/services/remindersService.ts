import { requireFound } from "../lib/errors";
import { supabaseAdmin } from "../lib/supabase";
import { addDays, getCurrentLocalDate } from "../lib/timezone";
import type { Row, RowList } from "./db";
import { handleSupabaseError } from "./db";
import { businessTimeZoneService } from "./businessTimeZoneService";
import { clientsService } from "./clientsService";
import { activityEventsService } from "./activityEventsService";

interface BirthdayReminderFilters {
  windowDays: number;
  limit: number;
}

const CLIENT_BIRTHDAY_SELECT =
  "id, first_name, last_name, preferred_name, birthday, phone, email, preferred_contact_method, reminder_consent";

const pad = (value: number): string => String(value).padStart(2, "0");

const toClientName = (client: Row): string => {
  const firstName = typeof client.first_name === "string" ? client.first_name : "";
  const lastName = typeof client.last_name === "string" ? client.last_name : "";
  const preferredName = typeof client.preferred_name === "string" ? client.preferred_name : "";

  return preferredName || [firstName, lastName].filter(Boolean).join(" ").trim() || "Client";
};

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

export const remindersService = {
  async list(userId: string): Promise<RowList> {
    const { data, error } = await supabaseAdmin
      .from("reminders")
      .select("*")
      .eq("user_id", userId)
      .order("due_date", { ascending: true });

    handleSupabaseError(error, "Unable to load reminders");
    return data ?? [];
  },

  async listBirthdayReminders(userId: string, filters: BirthdayReminderFilters): Promise<RowList> {
    const timeZone = await businessTimeZoneService.getForUser(userId);
    const today = getCurrentLocalDate(timeZone);
    const windowEndDate = addDays(today, filters.windowDays);
    const currentYear = Number(today.slice(0, 4));

    const { data, error } = await supabaseAdmin
      .from("clients")
      .select(CLIENT_BIRTHDAY_SELECT)
      .eq("user_id", userId)
      .order("first_name", { ascending: true });

    handleSupabaseError(error, "Unable to load birthday reminders");

    return ((data ?? []) as Row[])
      .map((client): Row | null => {
        const birthday = typeof client.birthday === "string" ? client.birthday : null;
        if (!birthday) {
          return null;
        }

        const thisYearBirthday = toBirthdayOccurrence(birthday, currentYear);
        const nextBirthday = thisYearBirthday && thisYearBirthday >= today
          ? thisYearBirthday
          : toBirthdayOccurrence(birthday, currentYear + 1);

        if (!nextBirthday || nextBirthday > windowEndDate) {
          return null;
        }

        const birthdayParts = parseDateText(birthday);
        const nextBirthdayYear = Number(nextBirthday.slice(0, 4));

        return {
          client_id: String(client.id ?? ""),
          client_name: toClientName(client),
          birthday,
          next_birthday: nextBirthday,
          days_until: daysBetweenDates(today, nextBirthday),
          turning_age: birthdayParts ? nextBirthdayYear - birthdayParts.year : null,
          reminder_consent: typeof client.reminder_consent === "boolean" ? client.reminder_consent : null,
          preferred_contact_method: typeof client.preferred_contact_method === "string" ? client.preferred_contact_method : null,
          phone: typeof client.phone === "string" ? client.phone : null,
          email: typeof client.email === "string" ? client.email : null
        };
      })
      .filter((item): item is Row => item !== null)
      .sort((left, right) => {
        const dayDiff = Number(left.days_until) - Number(right.days_until);
        if (dayDiff !== 0) {
          return dayDiff;
        }

        return String(left.client_name).localeCompare(String(right.client_name));
      })
      .slice(0, filters.limit);
  },

  async create(userId: string, payload: Row): Promise<Row> {
    await clientsService.assertOwned(userId, payload.client_id as string);

    const { data, error } = await supabaseAdmin
      .from("reminders")
      .insert({ ...payload, user_id: userId })
      .select("*")
      .single();

    handleSupabaseError(error, "Unable to create reminder");
    return requireFound(data, "Reminder was not created");
  },

  async getOwned(userId: string, reminderId: string): Promise<Row> {
    const { data, error } = await supabaseAdmin
      .from("reminders")
      .select("*")
      .eq("id", reminderId)
      .eq("user_id", userId)
      .maybeSingle();

    handleSupabaseError(error, "Unable to load reminder");
    return requireFound(data, "Reminder not found");
  },

  async update(userId: string, reminderId: string, updates: Row): Promise<Row> {
    const existingReminder = await this.getOwned(userId, reminderId);

    if (updates.client_id) {
      await clientsService.assertOwned(userId, updates.client_id as string);
    }

    const nextStatus = (updates.status as string | undefined) ?? (existingReminder.status as string | undefined);
    const normalizedUpdates: Row = { ...updates };

    if (nextStatus === "sent" && updates.sent_at === undefined && !existingReminder.sent_at) {
      normalizedUpdates.sent_at = new Date().toISOString();
    }

    const { data, error } = await supabaseAdmin
      .from("reminders")
      .update(normalizedUpdates)
      .eq("id", reminderId)
      .eq("user_id", userId)
      .select("*")
      .maybeSingle();

    handleSupabaseError(error, "Unable to update reminder");
    const reminder = requireFound(data, "Reminder not found");

    if ((reminder.status as string | undefined) === "sent") {
      await activityEventsService.recordReminderSent(userId, reminder);
    }

    return reminder;
  }
};
