import { supabaseAdmin } from "../lib/supabase";
import { handleSupabaseError } from "./db";
import { entitlementsService } from "./entitlementsService";
import { referralProgramSettingsService } from "./referralProgramSettingsService";

const ACTIVE_REFERRAL_CAMPAIGN_STATUSES = ["scheduled", "sending"] as const;

export const referralProgramStatusService = {
  activeCampaignStatuses: [...ACTIVE_REFERRAL_CAMPAIGN_STATUSES],

  async getForUser(userId: string) {
    const [program, referralEntitled, thankYouAutomationResult, activeCampaignsResult] = await Promise.all([
      referralProgramSettingsService.getForUser(userId),
      entitlementsService.isFeatureAllowed(userId, "referrals"),
      supabaseAdmin
        .from("automation_settings")
        .select("enabled")
        .eq("user_id", userId)
        .eq("key", "thank_you_emails")
        .maybeSingle(),
      supabaseAdmin
        .from("campaigns")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("link_type", "referral_link")
        .in("status", [...ACTIVE_REFERRAL_CAMPAIGN_STATUSES])
    ]);

    handleSupabaseError(thankYouAutomationResult.error, "Unable to load thank you referral automation status");
    handleSupabaseError(activeCampaignsResult.error, "Unable to load active referral campaign count");

    const programEnabled = program.enabled;
    const offerConfigured = program.configured;
    const thankYouReferralEnabled = referralEntitled && thankYouAutomationResult.data?.enabled === true;
    const activeCampaignCount = activeCampaignsResult.count ?? 0;

    return {
      configured: offerConfigured,
      active: referralEntitled && (
        (programEnabled && offerConfigured)
        || thankYouReferralEnabled
        || activeCampaignCount > 0
      ),
      program_enabled: programEnabled,
      offer_configured: offerConfigured,
      thank_you_referral_enabled: thankYouReferralEnabled,
      active_campaign_count: activeCampaignCount
    };
  }
};
