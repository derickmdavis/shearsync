import type {
  InsightsReferralHighlight,
  InsightsReferralMetric
} from "../validators/insightsValidators";
import type { InsightsReferralStats } from "./referralLinksService";

export const REFERRAL_INSIGHTS_ICON_KEYS = [
  "referral_program",
  "referral_clients",
  "referral_appointments",
  "referral_conversion",
  "referral_top_referrer"
] as const;

const formatCount = (value: number): string => new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0
}).format(value);

const pluralize = (count: number, singular: string, plural: string): string =>
  `${formatCount(count)} ${count === 1 ? singular : plural}`;

const conversionSupportingText = (stats: InsightsReferralStats): string => {
  if (stats.appointmentsBooked > 0) {
    return `${pluralize(stats.linksClicked, "click", "clicks")}`;
  }
  return stats.linksClicked > 0 ? `${pluralize(stats.linksClicked, "click", "clicks")}` : "No bookings yet";
};

export const insightsReferralPresentationService = {
  build(stats: InsightsReferralStats): {
    has_successful_conversions: boolean;
    metrics: [InsightsReferralMetric, InsightsReferralMetric, InsightsReferralMetric];
    top_referrer: InsightsReferralHighlight | null;
  } {
    const conversionRate = stats.conversionRatePercent;
    const topReferrer = stats.topReferrer;
    const topReferrerText = topReferrer
      ? topReferrer.successfulOutcomeCount > 0
        ? pluralize(topReferrer.successfulOutcomeCount, "referral", "referrals")
        : pluralize(topReferrer.engagementCount, "click", "clicks")
      : null;

    return {
      has_successful_conversions: stats.historicalResults.hasSuccessfulConversions,
      metrics: [
        {
          id: "new_clients",
          icon_key: "referral_clients",
          display_value: formatCount(stats.newClients),
          label: "New clients",
          supporting_text: `${pluralize(stats.linksSent, "link", "links")} sent`,
          semantic_tone: "positive",
          accessibility_label: `${pluralize(stats.newClients, "new client", "new clients")} from ${pluralize(stats.linksSent, "referral link", "referral links")} sent`
        },
        {
          id: "appointments_booked",
          icon_key: "referral_appointments",
          display_value: formatCount(stats.appointmentsBooked),
          label: "Appointments",
          supporting_text: `${pluralize(stats.linksClicked, "click", "clicks")}`,
          semantic_tone: "positive",
          accessibility_label: `${pluralize(stats.appointmentsBooked, "referral appointment", "referral appointments")} from ${pluralize(stats.linksClicked, "click", "clicks")}`
        },
        {
          id: "conversion_rate",
          icon_key: "referral_conversion",
          display_value: `${formatCount(conversionRate)}%`,
          label: "Conversion",
          supporting_text: conversionSupportingText(stats),
          semantic_tone: stats.appointmentsBooked > 0 ? "positive" : "neutral",
          accessibility_label: `${formatCount(conversionRate)} percent referral conversion, ${conversionSupportingText(stats).toLowerCase()}`
        }
      ],
      top_referrer: topReferrer && topReferrerText ? {
        client_id: topReferrer.clientId,
        icon_key: "referral_top_referrer",
        eyebrow: "Top referrer",
        title: topReferrer.displayName,
        result_text: topReferrerText,
        accessibility_label: `Top referrer ${topReferrer.displayName}, ${topReferrerText}`
      } : null
    };
  }
};
