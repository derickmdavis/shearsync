import type { InsightsCampaignPresentation } from "../validators/insightsValidators";
import type { InsightsCampaignAggregate } from "./insightsCampaignsService";

// This is the complete client icon contract for Campaign Insights. The client
// renders these semantic keys but never derives them from metric IDs or copy.
export const CAMPAIGN_INSIGHTS_ICON_KEYS = [
  "campaign",
  "campaign_email",
  "campaign_appointment",
  "campaign_revenue"
] as const;

const formatCount = (value: number): string => new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0
}).format(value);

const formatUsd = (amountMinor: number): string => new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD"
}).format(amountMinor / 100);

const pluralize = (count: number, singular: string, plural: string): string =>
  `${formatCount(count)} ${count === 1 ? singular : plural}`;

const topCampaignResult = (campaign: NonNullable<InsightsCampaignAggregate["topCampaign"]>): string => {
  if (campaign.attributedRevenueMinor > 0) {
    return `${formatUsd(campaign.attributedRevenueMinor)} attributed revenue`;
  }
  if (campaign.appointmentsBooked > 0) {
    return `${pluralize(campaign.appointmentsBooked, "appointment", "appointments")} booked`;
  }
  return `${pluralize(campaign.emailsSent, "email", "emails")} sent`;
};

export const insightsCampaignPresentationService = {
  build(aggregate: InsightsCampaignAggregate): InsightsCampaignPresentation {
    const revenueDisplayValue = formatUsd(aggregate.attributedRevenueMinor);
    const topCampaign = aggregate.topCampaign;
    const topCampaignText = topCampaign ? topCampaignResult(topCampaign) : null;

    return {
      has_campaign_history: aggregate.hasCampaignHistory,
      metrics: [
        {
          id: "emails_sent",
          icon_key: "campaign_email",
          display_value: formatCount(aggregate.emailsSent),
          label: "Emails sent",
          supporting_text: null,
          semantic_tone: "default",
          accessibility_label: `${pluralize(aggregate.emailsSent, "email", "emails")} sent`
        },
        {
          id: "appointments_booked",
          icon_key: "campaign_appointment",
          display_value: formatCount(aggregate.appointmentsBooked),
          label: "Appointments booked",
          supporting_text: null,
          semantic_tone: "default",
          accessibility_label: `${pluralize(aggregate.appointmentsBooked, "appointment", "appointments")} booked`
        },
        {
          id: "attributed_revenue",
          icon_key: "campaign_revenue",
          display_value: revenueDisplayValue,
          label: "Attributed revenue",
          supporting_text: null,
          semantic_tone: aggregate.attributedRevenueMinor > 0 ? "positive" : "default",
          accessibility_label: `${revenueDisplayValue} attributed revenue`
        }
      ],
      top_campaign: topCampaign && topCampaignText ? {
        campaign_id: topCampaign.campaignId,
        icon_key: "campaign",
        eyebrow: "Top campaign",
        title: topCampaign.name,
        result_text: topCampaignText,
        accessibility_label: `Top campaign: ${topCampaign.name}. ${topCampaignText}.`
      } : null,
      empty_state: {
        icon_key: "campaign",
        title: "Send your first campaign",
        body: "Reach more clients with a targeted email campaign.",
        cta_label: "Create campaign"
      }
    };
  }
};
