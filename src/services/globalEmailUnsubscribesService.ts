import { isAppointmentUpdateMessage, type MessageType, normalizeEmail } from "../lib/communications";
import { supabaseAdmin } from "../lib/supabase";
import type { Row } from "./db";
import { handleSupabaseError } from "./db";

interface UpsertGlobalEmailUnsubscribeOptions {
  email: string;
  source: "unsubscribe_link" | "admin" | "manual" | "import" | "system";
  userId?: string | null;
  clientId?: string | null;
  stylistId?: string | null;
  messageType?: MessageType | null;
  preferenceTokenId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Row | null;
}

export const isGlobalEmailUnsubscribeExempt = isAppointmentUpdateMessage;


export const globalEmailUnsubscribesService = {
  async isGloballyUnsubscribed(email: string): Promise<boolean> {
    const emailNormalized = normalizeEmail(email);
    if (!emailNormalized) {
      return false;
    }

    const { data, error } = await supabaseAdmin
      .from("global_email_unsubscribes")
      .select("id")
      .eq("email_normalized", emailNormalized)
      .maybeSingle();

    handleSupabaseError(error, "Unable to load global email unsubscribe");
    return Boolean(data);
  },

  async upsertGlobalEmailUnsubscribe(options: UpsertGlobalEmailUnsubscribeOptions): Promise<Row> {
    const emailNormalized = normalizeEmail(options.email);
    if (!emailNormalized) {
      throw new Error("Global email unsubscribe requires a valid email");
    }

    const { data, error } = await supabaseAdmin
      .from("global_email_unsubscribes")
      .upsert({
        email_normalized: emailNormalized,
        opted_out_at: new Date().toISOString(),
        opt_out_source: options.source,
        triggering_user_id: options.userId ?? null,
        triggering_client_id: options.clientId ?? null,
        triggering_stylist_id: options.stylistId ?? null,
        triggering_message_type: options.messageType ?? null,
        preference_token_id: options.preferenceTokenId ?? null,
        ip_address: options.ipAddress ?? null,
        user_agent: options.userAgent ?? null,
        metadata: options.metadata ?? {}
      }, { onConflict: "email_normalized" })
      .select("*")
      .single();

    handleSupabaseError(error, "Unable to save global email unsubscribe");
    return data as Row;
  }
};
