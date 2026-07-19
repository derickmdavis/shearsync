import { env } from "../config/env";
import { ApiError, requireFound } from "../lib/errors";
import { hashToken } from "../lib/communications";
import { createPublicBookingContextToken, type PublicBookingContext } from "../lib/publicBookingContext";
import { CAMPAIGN_ATTRIBUTION_WINDOW_DAYS } from "../lib/outreachContracts";
import { supabaseAdmin } from "../lib/supabase";
import { referralLinksService } from "./referralLinksService";
import { stylistsService } from "./stylistsService";
import type { Row } from "./db";
import { handleSupabaseError } from "./db";

const addDays = (date: Date, days: number): Date => new Date(date.getTime() + days * 24 * 60 * 60 * 1000);

const getPublicBaseUrl = (): string => env.WEB_APP_URL ?? env.CLIENT_APP_URL
  ?? (() => { throw new ApiError(500, "Public booking web app URL is not configured"); })();

export const campaignAttributionService = {
  async resolvePublicLink(rawToken: string, now = new Date()) {
    const { data: recipient, error: recipientError } = await supabaseAdmin.from("campaign_recipients").select("*")
      .eq("booking_tracking_token_hash", hashToken(rawToken)).maybeSingle();
    handleSupabaseError(recipientError, "Unable to resolve campaign link");
    if (!recipient || recipient.eligibility_status !== "eligible") throw new ApiError(404, "Campaign link is invalid or expired");

    const issuedAt = new Date(String(recipient.queued_at ?? recipient.created_at ?? ""));
    const expiresAt = addDays(issuedAt, CAMPAIGN_ATTRIBUTION_WINDOW_DAYS);
    if (!Number.isFinite(issuedAt.getTime()) || expiresAt <= now) throw new ApiError(404, "Campaign link is invalid or expired");

    const { data: campaign, error: campaignError } = await supabaseAdmin.from("campaigns").select("id, user_id, status, link_type")
      .eq("id", recipient.campaign_id).eq("user_id", recipient.user_id).maybeSingle();
    handleSupabaseError(campaignError, "Unable to resolve campaign link");
    if (!campaign || campaign.status === "cancelled") throw new ApiError(404, "Campaign link is invalid or expired");

    const stylist = requireFound(await stylistsService.getByUserId(String(recipient.user_id)), "Campaign stylist not found");
    const context: PublicBookingContext = {
      stylistSlug: String(stylist.slug),
      isExistingClient: true,
      campaignAttribution: {
        campaignId: String(recipient.campaign_id),
        campaignRunId: String(recipient.campaign_run_id),
        campaignRecipientId: String(recipient.id),
        expiresAt: expiresAt.toISOString()
      }
    };
    const bookingContextToken = createPublicBookingContextToken(context);
    const redirect = new URL(`/book/${encodeURIComponent(String(stylist.slug))}`, getPublicBaseUrl());
    redirect.searchParams.set("booking_context_token", bookingContextToken);

    if (campaign.link_type === "referral_link" && typeof recipient.client_id === "string") {
      const referral = await referralLinksService.getOrCreateForClient(String(recipient.user_id), recipient.client_id, {
        source: "email_campaign"
      });
      const { error: referralUpdateError } = await supabaseAdmin.from("campaign_recipients").update({ referral_link_id: referral.id })
        .eq("id", recipient.id).eq("user_id", recipient.user_id);
      handleSupabaseError(referralUpdateError, "Unable to resolve campaign referral link");
      redirect.searchParams.set("ref", String(referral.referral_code));
    }

    return { redirect_url: redirect.toString(), expires_at: expiresAt.toISOString() };
  },

  toAppointmentFields(context: PublicBookingContext | null): Row {
    const attribution = context?.campaignAttribution;
    return attribution ? {
      campaign_id: attribution.campaignId,
      campaign_run_id: attribution.campaignRunId,
      campaign_recipient_id: attribution.campaignRecipientId,
      campaign_attributed_at: new Date().toISOString()
    } : {};
  }
};
