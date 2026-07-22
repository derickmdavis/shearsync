import { z } from "zod";
import { timeZoneSchema } from "./common";

/**
 * Contract-only schemas for the future GET /api/insights endpoint.  The route
 * is deliberately not registered until the metric builders are implemented.
 */
export const insightsContractVersion = "2026-07-21" as const;

export const insightsQuerySchema = z.object({
  business_snapshot_period: z.enum(["week", "month"]).default("week"),
  referral_period: z.enum(["this_month", "all_time"]).default("this_month")
});

export const insightsUnavailableReasonSchema = z.enum([
  "insufficient_history",
  "feature_unavailable",
  "processing",
  "temporarily_unavailable"
]);

// Periods and freshness values are transport-level UTC instants. The account
// timezone is returned separately and is the only timezone used for business
// period selection.
const utcInstantSchema = z.string().datetime({ offset: true }).refine((value) => value.endsWith("Z"), {
  message: "timestamp must be a UTC ISO-8601 instant ending in Z"
});

const sectionTimingSchema = z.object({
  calculated_at: utcInstantSchema.optional()
});

const unavailableSectionSchema = sectionTimingSchema.extend({
  available: z.literal(false),
  reason: insightsUnavailableReasonSchema,
  message: z.string().min(1).max(280).optional(),
  retry_after_seconds: z.number().int().positive().max(86_400).optional()
});

export const insightsMoneyValueSchema = z.object({
  kind: z.literal("money"),
  amount_minor: z.number().int(),
  currency: z.string().regex(/^[A-Z]{3}$/, "currency must be an ISO 4217 code")
});

export const insightsCountValueSchema = z.object({
  kind: z.literal("count"),
  count: z.number().int().nonnegative()
});

export const insightsPercentValueSchema = z.object({
  kind: z.literal("percent"),
  percent: z.number().min(0).max(100)
});

export const insightsDurationValueSchema = z.object({
  kind: z.literal("duration"),
  minutes: z.number().int().nonnegative()
});

export const insightsTextValueSchema = z.object({
  kind: z.literal("text"),
  text: z.string().min(1).max(280)
});

export const insightsMetricValueSchema = z.discriminatedUnion("kind", [
  insightsMoneyValueSchema,
  insightsCountValueSchema,
  insightsPercentValueSchema,
  insightsDurationValueSchema,
  insightsTextValueSchema
]);

export const insightsComparisonSchema = z.object({
  label: z.string().min(1).max(120),
  // A null value means there is no meaningful prior-period denominator. The
  // client must omit the comparison treatment rather than invent a trend.
  percent_change: z.number().finite().nullable(),
  trend: z.enum(["up", "down", "neutral"]).optional()
}).superRefine((comparison, context) => {
  if (comparison.percent_change === null && comparison.trend !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "trend must be omitted when percent_change is null",
      path: ["trend"]
    });
  }
});

export const insightsSnapshotMetricSchema = z.object({
  // IDs are stable server identifiers. The mobile app must not branch on them.
  id: z.string().min(1).max(80).regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/),
  label: z.string().min(1).max(80),
  value: insightsMetricValueSchema,
  detail: z.string().min(1).max(160).optional(),
  comparison: insightsComparisonSchema.optional()
});

export const insightsSnapshotPageSchema = z.object({
  id: z.string().min(1).max(80).regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/),
  title: z.string().min(1).max(80),
  period_label: z.string().min(1).max(80),
  layout: z.enum(["grid_2x2", "list"]),
  window: z.object({
    start_at: utcInstantSchema,
    end_at: utcInstantSchema
  }).refine((window) => window.start_at < window.end_at, {
    message: "window.start_at must be before window.end_at",
    path: ["end_at"]
  }),
  metrics: z.array(insightsSnapshotMetricSchema).min(1).max(20)
});

const availableBusinessSnapshotSectionSchema = sectionTimingSchema.extend({
  available: z.literal(true),
  pages: z.array(insightsSnapshotPageSchema).max(20)
});

export const insightsBusinessSnapshotSectionSchema = z.discriminatedUnion("available", [
  availableBusinessSnapshotSectionSchema,
  unavailableSectionSchema
]);

const insightsPeriodSchema = z.object({
  label: z.string().min(1).max(80),
  start_at: utcInstantSchema,
  end_at: utcInstantSchema
}).refine((period) => period.start_at < period.end_at, {
  message: "period.start_at must be before period.end_at",
  path: ["end_at"]
});

const campaignMetricSchema = (id: "emails_sent" | "appointments_booked" | "attributed_revenue", iconKey: "campaign_email" | "campaign_appointment" | "campaign_revenue") => z.object({
  id: z.literal(id),
  icon_key: z.literal(iconKey),
  display_value: z.string().min(1).max(80),
  label: z.string().min(1).max(80),
  supporting_text: z.string().min(1).max(160).nullable().optional(),
  semantic_tone: z.enum(["default", "positive", "neutral", "warning"]).optional(),
  accessibility_label: z.string().min(1).max(280).nullable().optional()
});

export const campaignPresentationSchema = z.object({
  // Lifetime product-use state. It intentionally does not depend on the
  // selected reporting period or on whether a campaign successfully sent.
  has_campaign_history: z.boolean(),
  // A tuple makes the fixed 2+1 layout and server-defined ordering explicit.
  metrics: z.tuple([
    campaignMetricSchema("emails_sent", "campaign_email"),
    campaignMetricSchema("appointments_booked", "campaign_appointment"),
    campaignMetricSchema("attributed_revenue", "campaign_revenue")
  ]),
  top_campaign: z.object({
    campaign_id: z.string().uuid(),
    icon_key: z.literal("campaign").nullable().optional(),
    eyebrow: z.string().min(1).max(80).nullable().optional(),
    title: z.string().min(1).max(280),
    result_text: z.string().min(1).max(160).nullable().optional(),
    accessibility_label: z.string().min(1).max(280).nullable().optional()
  }).nullable(),
  empty_state: z.object({
    icon_key: z.literal("campaign"),
    title: z.string().min(1).max(120),
    body: z.string().min(1).max(280),
    cta_label: z.string().min(1).max(80)
  })
});

const availableCampaignsSectionSchema = sectionTimingSchema.extend({
  available: z.literal(true),
  period: insightsPeriodSchema
}).merge(campaignPresentationSchema);

export const insightsCampaignsSectionSchema = z.discriminatedUnion("available", [
  availableCampaignsSectionSchema,
  unavailableSectionSchema
]);

const availableReferralsSectionSchema = sectionTimingSchema.extend({
  available: z.literal(true),
  period: insightsPeriodSchema,
  new_clients: z.number().int().nonnegative(),
  appointments_booked: z.number().int().nonnegative(),
  conversion_rate_percent: z.number().min(0).max(100).nullable(),
  links_sent: z.number().int().nonnegative(),
  links_clicked: z.number().int().nonnegative(),
  attributed_revenue: insightsMoneyValueSchema,
  booked_value: insightsMoneyValueSchema,
  historical_results: z.object({
    new_clients: z.number().int().nonnegative(),
    appointments_booked: z.number().int().nonnegative(),
    has_successful_conversions: z.boolean()
  }),
  top_referrer: z.object({
    client_id: z.string().uuid().nullable(),
    display_name: z.string().min(1).max(160),
    referral_count: z.number().int().nonnegative()
  }).nullable()
});

export const insightsReferralsSectionSchema = z.discriminatedUnion("available", [
  availableReferralsSectionSchema,
  unavailableSectionSchema
]);

const appointmentChangeMetricSchema = z.object({
  current_count: z.number().int().nonnegative(),
  previous_count: z.number().int().nonnegative(),
  percent_change: z.number().finite().nullable()
});

const availableAppointmentChangesSectionSchema = sectionTimingSchema.extend({
  available: z.literal(true),
  window: z.object({
    label: z.string().min(1).max(80),
    current_start_at: utcInstantSchema,
    current_end_at: utcInstantSchema,
    previous_start_at: utcInstantSchema,
    previous_end_at: utcInstantSchema
  }).superRefine((window, context) => {
    if (window.current_start_at >= window.current_end_at) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "current_start_at must be before current_end_at", path: ["current_end_at"] });
    }
    if (window.previous_start_at >= window.previous_end_at) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "previous_start_at must be before previous_end_at", path: ["previous_end_at"] });
    }
    if (window.previous_end_at !== window.current_start_at) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "previous and current windows must be contiguous", path: ["current_start_at"] });
    }
  }),
  new_appointments: appointmentChangeMetricSchema,
  cancellations: appointmentChangeMetricSchema
});

export const insightsAppointmentChangesSectionSchema = z.discriminatedUnion("available", [
  availableAppointmentChangesSectionSchema,
  unavailableSectionSchema
]);

export const insightsResponseSchema = z.object({
  contract_version: z.literal(insightsContractVersion),
  generated_at: utcInstantSchema,
  account_timezone: timeZoneSchema,
  business_snapshot: insightsBusinessSnapshotSectionSchema,
  campaigns: insightsCampaignsSectionSchema,
  referrals: insightsReferralsSectionSchema,
  appointment_changes: insightsAppointmentChangesSectionSchema
});

// All authenticated screen read endpoints use a data envelope. The inner
// schema remains exported so the future service can validate its own output
// before the controller sends it.
export const insightsHttpResponseSchema = z.object({
  data: insightsResponseSchema
});

export type InsightsQuery = z.infer<typeof insightsQuerySchema>;
export type InsightsResponse = z.infer<typeof insightsResponseSchema>;
export type InsightsHttpResponse = z.infer<typeof insightsHttpResponseSchema>;
export type InsightsMetricValue = z.infer<typeof insightsMetricValueSchema>;
export type InsightsSnapshotMetric = z.infer<typeof insightsSnapshotMetricSchema>;
export type InsightsSnapshotPage = z.infer<typeof insightsSnapshotPageSchema>;
export type InsightsCampaignPresentation = z.infer<typeof campaignPresentationSchema>;
