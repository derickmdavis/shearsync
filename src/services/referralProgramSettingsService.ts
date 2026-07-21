import { ApiError, requireFound } from "../lib/errors";
import { supabaseAdmin } from "../lib/supabase";
import type { Row } from "./db";
import { handleSupabaseError } from "./db";
import { entitlementsService } from "./entitlementsService";

export interface ReferralProgramSettingsPayload {
  enabled?: boolean;
  offerName?: string | null;
  offerDescription?: string | null;
}

const normalizeText = (value: string | null | undefined): string | null | undefined => {
  if (value === undefined || value === null) {
    return value;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const isConfigured = (row?: Row | null): boolean =>
  typeof row?.offer_name === "string" && row.offer_name.trim().length > 0
  && typeof row?.offer_description === "string" && row.offer_description.trim().length > 0;

const toApiSettings = (row?: Row | null) => ({
  enabled: row?.enabled === true,
  offerName: typeof row?.offer_name === "string" ? row.offer_name : null,
  offerDescription: typeof row?.offer_description === "string" ? row.offer_description : null,
  configured: isConfigured(row),
  createdAt: typeof row?.created_at === "string" ? row.created_at : null,
  updatedAt: typeof row?.updated_at === "string" ? row.updated_at : null
});

const validateSettingsPayload = (payload: ReferralProgramSettingsPayload): ReferralProgramSettingsPayload => {
  const offerName = normalizeText(payload.offerName);
  const offerDescription = normalizeText(payload.offerDescription);

  if (offerName && offerName.length > 120) {
    throw new ApiError(400, "Referral offer name must be 120 characters or fewer");
  }

  if (offerDescription && offerDescription.length > 500) {
    throw new ApiError(400, "Referral offer description must be 500 characters or fewer");
  }

  return {
    ...(payload.enabled !== undefined ? { enabled: payload.enabled } : {}),
    ...(offerName !== undefined ? { offerName } : {}),
    ...(offerDescription !== undefined ? { offerDescription } : {})
  };
};

export const referralProgramSettingsService = {
  validateSettingsPayload,

  async getForUser(userId: string) {
    const { data, error } = await supabaseAdmin
      .from("referral_programs")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    handleSupabaseError(error, "Unable to load referral program settings");
    return toApiSettings(data as Row | null);
  },

  async upsertForUser(userId: string, payload: ReferralProgramSettingsPayload) {
    await entitlementsService.assertFeatureAllowed(userId, "referrals");

    const normalized = validateSettingsPayload(payload);
    const updates: Row = {
      ...("enabled" in normalized ? { enabled: normalized.enabled } : {}),
      ...("offerName" in normalized ? { offer_name: normalized.offerName } : {}),
      ...("offerDescription" in normalized ? { offer_description: normalized.offerDescription } : {})
    };

    const { data: existing, error: existingError } = await supabaseAdmin
      .from("referral_programs")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();
    handleSupabaseError(existingError, "Unable to load referral program settings");

    if (existing) {
      const { data, error } = await supabaseAdmin
        .from("referral_programs")
        .update(updates)
        .eq("user_id", userId)
        .select("*")
        .maybeSingle();

      handleSupabaseError(error, "Unable to update referral program settings");
      return toApiSettings(requireFound(data, "Referral program settings not found"));
    }

    const { data, error } = await supabaseAdmin
      .from("referral_programs")
      .insert({ user_id: userId, ...updates })
      .select("*")
      .single();

    handleSupabaseError(error, "Unable to create referral program settings");
    return toApiSettings(requireFound(data, "Referral program settings were not created"));
  }
};
