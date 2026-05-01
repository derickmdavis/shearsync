import { requireFound } from "../lib/errors";
import { supabaseAdmin } from "../lib/supabase";
import type { Row, RowList } from "./db";
import { handleSupabaseError } from "./db";
import { clientsService } from "./clientsService";
import { activityEventsService } from "./activityEventsService";

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
