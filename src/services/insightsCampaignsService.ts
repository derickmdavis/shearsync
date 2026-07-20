import { getCurrentLocalDate, getStartOfLocalDayUtc } from "../lib/timezone";
import { CAMPAIGN_STATUSES, type CampaignStatus } from "../lib/outreachContracts";
import { supabaseAdmin } from "../lib/supabase";
import { handleSupabaseError } from "./db";

const numberValue = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const isCampaignStatus = (value: unknown): value is CampaignStatus =>
  typeof value === "string" && (CAMPAIGN_STATUSES as readonly string[]).includes(value);

export type InsightsCampaignAggregate = {
  period: { label: "This Month"; startAt: string; endAt: string };
  campaignCount: number;
  activeCampaignCount: number;
  emailsSent: number;
  appointmentsBooked: number;
  attributedRevenueMinor: number;
  topCampaign: {
    campaignId: string;
    name: string;
    status: CampaignStatus;
    appointmentsBooked: number;
    attributedRevenueMinor: number;
  } | null;
};

export const insightsCampaignsService = {
  async getForUser(userId: string, timeZone: string, now = new Date()): Promise<InsightsCampaignAggregate> {
    const today = getCurrentLocalDate(timeZone, now);
    const monthStartDate = `${today.slice(0, 7)}-01`;
    const startAt = getStartOfLocalDayUtc(monthStartDate, timeZone).toISOString();
    const endAt = now.toISOString();
    const { data, error } = await supabaseAdmin.rpc("get_insights_campaign_aggregate", {
      p_user_id: userId,
      p_start_at: startAt,
      p_end_at: endAt
    });
    handleSupabaseError(error, "Unable to load Insights campaign aggregate");

    const row = Array.isArray(data) ? data[0] as Record<string, unknown> | undefined : undefined;
    const topCampaign = row
      && typeof row.top_campaign_id === "string"
      && typeof row.top_campaign_name === "string"
      && row.top_campaign_name.trim().length > 0
      && isCampaignStatus(row.top_campaign_status)
      ? {
          campaignId: row.top_campaign_id,
          name: row.top_campaign_name,
          status: row.top_campaign_status,
          appointmentsBooked: numberValue(row.top_campaign_appointments_booked),
          attributedRevenueMinor: numberValue(row.top_campaign_attributed_revenue_minor)
        }
      : null;

    return {
      period: { label: "This Month", startAt, endAt },
      campaignCount: numberValue(row?.campaign_count),
      activeCampaignCount: numberValue(row?.active_campaign_count),
      emailsSent: numberValue(row?.emails_sent),
      appointmentsBooked: numberValue(row?.appointments_booked),
      attributedRevenueMinor: numberValue(row?.attributed_revenue_minor),
      topCampaign
    };
  }
};
