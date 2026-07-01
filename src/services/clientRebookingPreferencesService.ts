import { clientsService } from "./clientsService";
import type { Row } from "./db";
import { handleSupabaseError } from "./db";
import { supabaseAdmin } from "../lib/supabase";

export interface ClientRebookingPreferencePayload {
  preferred_interval_days: number | null;
}

export const clientRebookingPreferencesService = {
  async getForClient(userId: string, clientId: string): Promise<Row | null> {
    const { data, error } = await supabaseAdmin
      .from("client_rebooking_preferences")
      .select("*")
      .eq("user_id", userId)
      .eq("client_id", clientId)
      .maybeSingle();

    handleSupabaseError(error, "Unable to load client rebooking preference");
    return data as Row | null;
  },

  async updateForClient(userId: string, clientId: string, payload: ClientRebookingPreferencePayload): Promise<Row | null> {
    await clientsService.assertOwned(userId, clientId);

    if (payload.preferred_interval_days === null) {
      const { error } = await supabaseAdmin
        .from("client_rebooking_preferences")
        .delete()
        .eq("user_id", userId)
        .eq("client_id", clientId);

      handleSupabaseError(error, "Unable to clear client rebooking preference");
      return null;
    }

    const { data, error } = await supabaseAdmin
      .from("client_rebooking_preferences")
      .upsert({
        user_id: userId,
        client_id: clientId,
        preferred_interval_days: payload.preferred_interval_days,
        source: "manual"
      }, { onConflict: "user_id,client_id" })
      .select("*")
      .single();

    handleSupabaseError(error, "Unable to update client rebooking preference");
    return data as Row;
  }
};
