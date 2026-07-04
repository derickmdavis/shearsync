import { requireFound } from "../lib/errors";
import { supabaseAdmin } from "../lib/supabase";
import type { Row } from "./db";
import { handleSupabaseError } from "./db";
import { entitlementsService } from "./entitlementsService";

export interface BirthdayReminderSettingsPayload {
  approvalRequired?: boolean;
}

const toApiSettings = (row?: Row | null) => ({
  approvalRequired: row?.approval_required !== false,
  configured: Boolean(row)
});

const validateSettingsPayload = (
  payload: BirthdayReminderSettingsPayload
): BirthdayReminderSettingsPayload => ({
  ...(payload.approvalRequired !== undefined ? { approvalRequired: payload.approvalRequired } : {})
});

export const birthdayReminderSettingsService = {
  validateSettingsPayload,

  async getForUser(userId: string) {
    await entitlementsService.assertFeatureAllowed(userId, "birthdayReminders");

    const { data, error } = await supabaseAdmin
      .from("birthday_reminder_settings")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    handleSupabaseError(error, "Unable to load birthday reminder settings");
    return toApiSettings(data as Row | null);
  },

  async getRawForUser(userId: string): Promise<Row | null> {
    const { data, error } = await supabaseAdmin
      .from("birthday_reminder_settings")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    handleSupabaseError(error, "Unable to load birthday reminder settings");
    return data as Row | null;
  },

  async upsertForUser(userId: string, payload: BirthdayReminderSettingsPayload) {
    await entitlementsService.assertFeatureAllowed(userId, "birthdayReminders");

    const normalized = validateSettingsPayload(payload);
    const updates: Row = {};

    if ("approvalRequired" in normalized) {
      const { data, error } = await supabaseAdmin.rpc(
        "upsert_birthday_reminder_settings_with_approval_mode",
        {
          p_user_id: userId,
          p_approval_required: normalized.approvalRequired
        }
      );

      handleSupabaseError(error, "Unable to update birthday reminder settings");
      return toApiSettings(requireFound(data as Row | null, "Birthday reminder settings were not saved"));
    }

    const existing = await this.getRawForUser(userId);

    if (existing) {
      const { data, error } = await supabaseAdmin
        .from("birthday_reminder_settings")
        .update(updates)
        .eq("user_id", userId)
        .select("*")
        .maybeSingle();

      handleSupabaseError(error, "Unable to update birthday reminder settings");
      return toApiSettings(requireFound(data, "Birthday reminder settings not found"));
    }

    const { data, error } = await supabaseAdmin
      .from("birthday_reminder_settings")
      .insert({
        user_id: userId,
        approval_required: "approvalRequired" in normalized ? normalized.approvalRequired : true
      })
      .select("*")
      .single();

    handleSupabaseError(error, "Unable to create birthday reminder settings");
    return toApiSettings(requireFound(data, "Birthday reminder settings were not created"));
  }
};
