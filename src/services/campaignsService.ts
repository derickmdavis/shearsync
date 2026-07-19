import { ApiError } from "../lib/errors";
import { CAMPAIGN_ATTRIBUTION_WINDOW_DAYS, CAMPAIGN_STATUSES, type CampaignStatus } from "../lib/outreachContracts";
import { supabaseAdmin } from "../lib/supabase";
import type { Row } from "./db";
import { handleSupabaseError } from "./db";
import { campaignStoreService } from "./campaignStoreService";

const REPORTING_CURRENCY = "USD";

const allowedActions = (status: CampaignStatus): string[] => {
  if (status === "draft") return ["preview", "validate", "delete"];
  if (status === "scheduled") return ["view", "cancel"];
  return ["view"];
};

const numberValue = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const emptyReportingMetrics = () => ({
  recipients: {
    total: 0, eligible: 0, excluded: 0, pending: 0, queued: 0, sending: 0,
    sent: 0, delivered: 0, failed: 0, skipped: 0, cancelled: 0
  },
  attribution: { booked_count: 0, booked_revenue_cents: 0, currency: REPORTING_CURRENCY },
  delivery_analytics: {
    delivered_raw: 0,
    opens: { raw: 0, unique: 0, automated_raw: 0, privacy_limited_raw: 0, rate: { numerator: 0, denominator: 0, value: null } },
    clicks: { raw: 0, unique: 0, automated_raw: 0, privacy_limited_raw: 0, rate: { numerator: 0, denominator: 0, value: null } }
  }
});

const toReportingMetrics = (row?: Row) => ({
  recipients: {
    total: numberValue(row?.recipient_total),
    eligible: numberValue(row?.eligible_count),
    excluded: numberValue(row?.excluded_count),
    pending: numberValue(row?.pending_count),
    queued: numberValue(row?.queued_count),
    sending: numberValue(row?.sending_count),
    sent: numberValue(row?.sent_count),
    delivered: numberValue(row?.delivered_count),
    failed: numberValue(row?.failed_count),
    skipped: numberValue(row?.skipped_count),
    cancelled: numberValue(row?.cancelled_count)
  },
  attribution: {
    booked_count: numberValue(row?.attributed_booking_count),
    booked_revenue_cents: numberValue(row?.booked_revenue_cents),
    currency: REPORTING_CURRENCY
  },
  delivery_analytics: {
    delivered_raw: numberValue(row?.delivered_raw),
    opens: (() => {
      const unique = numberValue(row?.opens_unique);
      const denominator = numberValue(row?.delivered_raw);
      return { raw: numberValue(row?.opens_raw), unique, automated_raw: numberValue(row?.opens_automated), privacy_limited_raw: numberValue(row?.opens_privacy_limited), rate: { numerator: unique, denominator, value: denominator > 0 ? unique / denominator : null } };
    })(),
    clicks: (() => {
      const unique = numberValue(row?.clicks_unique);
      const denominator = numberValue(row?.delivered_raw);
      return { raw: numberValue(row?.clicks_raw), unique, automated_raw: numberValue(row?.clicks_automated), privacy_limited_raw: numberValue(row?.clicks_privacy_limited), rate: { numerator: unique, denominator, value: denominator > 0 ? unique / denominator : null } };
    })()
  }
});

const reportingMetadata = () => ({
  currency: REPORTING_CURRENCY,
  revenue_unit: "cents",
  attribution_window: {
    duration_days: CAMPAIGN_ATTRIBUTION_WINDOW_DAYS,
    starts_at: "campaign_recipient_queued_at",
    qualifying_event: "appointment_created_with_signed_campaign_booking_context",
    cancelled_appointments_included: false
  },
  definitions: {
    recipients: "Counts are raw campaign-recipient records grouped by eligibility and current delivery status.",
    booked_count: "Non-cancelled appointments attributed to this campaign through its signed booking context.",
    booked_revenue_cents: "Sum of non-cancelled attributed appointment prices, rounded to integer cents."
  },
  delivery_analytics: {
    opens: { available: true, limitations: "Privacy proxies and automated prefetches can inflate opens; raw and unique counts retain these flags." },
    clicks: { available: true, limitations: "Tracked redirect clicks can include security scanners; raw and unique counts retain automated-event flags." }
  }
});

const loadReporting = async (userId: string, campaignIds: string[]): Promise<Map<string, Row>> => {
  if (campaignIds.length === 0) return new Map();
  const { data, error } = await supabaseAdmin.rpc("get_campaign_reporting_summaries_v2", {
    p_user_id: userId,
    p_campaign_ids: campaignIds
  });
  handleSupabaseError(error, "Unable to load campaign reporting summaries");
  return new Map(((data ?? []) as Row[]).map((row) => [String(row.campaign_id), row]));
};

const toCampaign = (row: Row, reporting?: Row) => {
  const metrics = reporting ? toReportingMetrics(reporting) : emptyReportingMetrics();
  return {
    id: row.id,
    name: row.name ?? null,
    status: row.status as CampaignStatus,
    send_mode: row.send_mode,
    scheduled_for: row.scheduled_for ?? row.scheduled_at ?? null,
    audience_mode: row.audience_mode,
    recipient_total: metrics.recipients.total,
    eligible_count: metrics.recipients.eligible,
    excluded_count: metrics.recipients.excluded,
    summary: metrics,
    allowed_actions: allowedActions(row.status as CampaignStatus),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
};

export const campaignsService = {
  async listForUser(userId: string, options: { status?: CampaignStatus; limit: number }) {
    let query = supabaseAdmin.from("campaigns").select("*").eq("user_id", userId);
    if (options.status) query = query.eq("status", options.status);
    const { data, error } = await query.order("created_at", { ascending: false }).limit(options.limit);
    handleSupabaseError(error, "Unable to list campaigns");
    const campaigns = (data ?? []) as Row[];
    const reporting = await loadReporting(userId, campaigns.map((campaign) => String(campaign.id)));
    return {
      data: campaigns.map((campaign) => toCampaign(campaign, reporting.get(String(campaign.id)))),
      metric_definitions: reportingMetadata()
    };
  },

  async getForUser(userId: string, campaignId: string) {
    const campaign = await campaignStoreService.getCampaignForUser(userId, campaignId);
    if (!(CAMPAIGN_STATUSES as readonly string[]).includes(String(campaign.status))) {
      throw new ApiError(500, "Campaign has an invalid status");
    }
    const reporting = await loadReporting(userId, [campaignId]);
    const metrics = toReportingMetrics(reporting.get(campaignId));
    return {
      ...toCampaign(campaign, reporting.get(campaignId)),
      metrics,
      metric_definitions: reportingMetadata()
    };
  }
};
