import { ApiError } from "../lib/errors";
import {
  type CommunicationChannel,
  type CommunicationPreferenceTokenAction,
  type MessageType,
  generatePreferenceToken,
  hashToken,
  normalizeContact
} from "../lib/communications";
import { supabaseAdmin } from "../lib/supabase";
import type { Row } from "./db";
import { handleSupabaseError } from "./db";

interface CreateCommunicationPreferenceTokenOptions {
  userId: string;
  clientId?: string | null;
  stylistId?: string | null;
  channel: CommunicationChannel;
  contactValue: string;
  messageType?: MessageType | null;
  action: CommunicationPreferenceTokenAction;
  expiresAt: Date;
}

export const communicationPreferenceTokensService = {
  async createCommunicationPreferenceToken(options: CreateCommunicationPreferenceTokenOptions): Promise<string> {
    const contactNormalized = normalizeContact(options.channel, options.contactValue);
    if (!contactNormalized) {
      throw new ApiError(400, "Preference token requires a valid contact value");
    }

    const rawToken = generatePreferenceToken();
    const { error } = await supabaseAdmin.from("communication_preference_tokens").insert({
      token_hash: hashToken(rawToken),
      user_id: options.userId,
      client_id: options.clientId ?? null,
      stylist_id: options.stylistId ?? null,
      channel: options.channel,
      contact_value: options.contactValue,
      contact_normalized: contactNormalized,
      message_type: options.messageType ?? null,
      action: options.action,
      expires_at: options.expiresAt.toISOString()
    });

    handleSupabaseError(error, "Unable to create communication preference token");
    return rawToken;
  },

  async consumeCommunicationPreferenceToken(rawToken: string): Promise<Row> {
    const tokenHash = hashToken(rawToken);
    const { data, error } = await supabaseAdmin
      .from("communication_preference_tokens")
      .select("*")
      .eq("token_hash", tokenHash)
      .maybeSingle();

    handleSupabaseError(error, "Unable to validate communication preference token");

    if (!data) {
      throw new ApiError(404, "Invalid or expired communication preference token");
    }

    const token = data as Row;
    const expiresAt = typeof token.expires_at === "string" ? new Date(token.expires_at) : null;
    if (!expiresAt || !Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() < Date.now()) {
      throw new ApiError(404, "Invalid or expired communication preference token");
    }

    const { data: updatedToken, error: updateError } = await supabaseAdmin
      .from("communication_preference_tokens")
      .update({ used_at: token.used_at ?? new Date().toISOString() })
      .eq("id", token.id)
      .select("*")
      .maybeSingle();

    handleSupabaseError(updateError, "Unable to consume communication preference token");
    return (updatedToken as Row | null) ?? token;
  }
};
