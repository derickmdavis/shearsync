import { z } from "zod";
import {
  CAMPAIGN_AUDIENCE_MODES,
  CAMPAIGN_EXCEPTION_STATUSES,
  CAMPAIGN_KINDS,
  CAMPAIGN_LIFECYCLE_STATUSES,
  CAMPAIGN_LINK_TYPES,
  CAMPAIGN_MAXIMUM_SCHEDULE_HORIZON_MONTHS,
  CAMPAIGN_MESSAGE_MAX_LENGTH,
  CAMPAIGN_MINIMUM_SCHEDULE_LEAD_MINUTES,
  CAMPAIGN_NAME_MAX_LENGTH,
  CAMPAIGN_PERSONALIZATION_TOKENS,
  CAMPAIGN_RECIPIENT_EXCLUSION_REASONS,
  CAMPAIGN_SEND_MODES,
  CAMPAIGN_STATUSES,
  CAMPAIGN_SUBJECT_MAX_LENGTH,
  OUTREACH_AUTOMATION_KEYS,
  OUTREACH_AUTOMATION_MODES,
  OUTREACH_CHANNELS,
  SCHEDULED_OUTREACH_ACTIONS,
  SCHEDULED_OUTREACH_CANCEL_SCOPES,
  SCHEDULED_OUTREACH_KINDS,
  SCHEDULED_OUTREACH_STATUSES
} from "../lib/outreachContracts";
import { isoDateTimeSchema, timeZoneSchema } from "./common";

export const campaignLifecycleStatusSchema = z.enum(CAMPAIGN_LIFECYCLE_STATUSES);
export const campaignExceptionStatusSchema = z.enum(CAMPAIGN_EXCEPTION_STATUSES);
export const campaignStatusSchema = z.enum(CAMPAIGN_STATUSES);
export const campaignKindSchema = z.enum(CAMPAIGN_KINDS);
export const campaignSendModeSchema = z.enum(CAMPAIGN_SEND_MODES);
export const campaignLinkTypeSchema = z.enum(CAMPAIGN_LINK_TYPES);
export const campaignAudienceModeSchema = z.enum(CAMPAIGN_AUDIENCE_MODES);
export const campaignPersonalizationTokenSchema = z.enum(CAMPAIGN_PERSONALIZATION_TOKENS);
export const campaignRecipientExclusionReasonSchema = z.enum(CAMPAIGN_RECIPIENT_EXCLUSION_REASONS);
export const scheduledOutreachKindSchema = z.enum(SCHEDULED_OUTREACH_KINDS);
export const scheduledOutreachStatusSchema = z.enum(SCHEDULED_OUTREACH_STATUSES);
export const outreachChannelSchema = z.enum(OUTREACH_CHANNELS);
export const scheduledOutreachCancelScopeSchema = z.enum(SCHEDULED_OUTREACH_CANCEL_SCOPES);
export const scheduledOutreachActionSchema = z.enum(SCHEDULED_OUTREACH_ACTIONS);
export const outreachAutomationKeySchema = z.enum(OUTREACH_AUTOMATION_KEYS);
export const outreachAutomationModeSchema = z.enum(OUTREACH_AUTOMATION_MODES);

export const campaignNameSchema = z.string().trim().min(1).max(CAMPAIGN_NAME_MAX_LENGTH);

const campaignTokenPattern = /{{\s*([a-zA-Z0-9_]+)\s*}}/g;

export const extractCampaignTokens = (value: string): string[] =>
  [...value.matchAll(campaignTokenPattern)].map((match) => match[1] ?? "");

const campaignPersonalizedTextSchema = (maximumLength: number) =>
  z.string().trim().min(1).max(maximumLength).superRefine((value, context) => {
    const unsupportedToken = extractCampaignTokens(value).find(
      (token) => !(CAMPAIGN_PERSONALIZATION_TOKENS as readonly string[]).includes(token)
    );

    if (unsupportedToken) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Unsupported campaign personalization token: ${unsupportedToken}`
      });
    }
  });

export const campaignSubjectSchema = campaignPersonalizedTextSchema(CAMPAIGN_SUBJECT_MAX_LENGTH);
export const campaignMessageSchema = campaignPersonalizedTextSchema(CAMPAIGN_MESSAGE_MAX_LENGTH);

export const campaignContentSchema = z.object({
  subject: campaignSubjectSchema,
  message: campaignMessageSchema
});

export const campaignAudienceSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("everyone"),
    client_ids: z.array(z.string().uuid()).max(0).default([])
  }),
  z.object({
    mode: z.literal("specific"),
    client_ids: z.array(z.string().uuid()).min(1)
  })
]);

const addMonthsUtc = (instant: Date, months: number): Date => {
  const targetMonthIndex = instant.getUTCMonth() + months;
  const targetYear = instant.getUTCFullYear() + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
  const lastTargetDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();

  return new Date(Date.UTC(
    targetYear,
    targetMonth,
    Math.min(instant.getUTCDate(), lastTargetDay),
    instant.getUTCHours(),
    instant.getUTCMinutes(),
    instant.getUTCSeconds(),
    instant.getUTCMilliseconds()
  ));
};

export const createCampaignScheduleAtSchema = (now = new Date()) =>
  isoDateTimeSchema.superRefine((value, context) => {
    const scheduledAt = new Date(value);
    const minimum = new Date(now.getTime() + CAMPAIGN_MINIMUM_SCHEDULE_LEAD_MINUTES * 60_000);
    const maximum = addMonthsUtc(now, CAMPAIGN_MAXIMUM_SCHEDULE_HORIZON_MONTHS);

    if (scheduledAt < minimum) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Campaign must be scheduled at least ${CAMPAIGN_MINIMUM_SCHEDULE_LEAD_MINUTES} minutes ahead`
      });
    }

    if (scheduledAt > maximum) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Campaign cannot be scheduled more than ${CAMPAIGN_MAXIMUM_SCHEDULE_HORIZON_MONTHS} months ahead`
      });
    }
  });

export const campaignDraftSetupSchema = z
  .object({
    name: campaignNameSchema,
    campaign_kind: campaignKindSchema.default("one_time"),
    send_mode: campaignSendModeSchema,
    send_at: isoDateTimeSchema.nullable(),
    timezone: timeZoneSchema,
    link_type: campaignLinkTypeSchema,
    audience: campaignAudienceSchema
  })
  .superRefine((value, context) => {
    if (value.send_mode === "scheduled" && value.send_at === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "send_at is required for scheduled campaigns",
        path: ["send_at"]
      });
    }

    if (value.send_mode === "now" && value.send_at !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "send_at must be null for send-now campaigns",
        path: ["send_at"]
      });
    }
  });

export const scheduledOutreachRecipientSchema = z.object({
  client_id: z.string().uuid(),
  display_name: z.string().min(1)
});

export const scheduledOutreachItemSchema = z.object({
  id: z.string().min(1),
  kind: scheduledOutreachKindSchema,
  status: scheduledOutreachStatusSchema,
  channel: outreachChannelSchema,
  send_at: isoDateTimeSchema,
  recipient: scheduledOutreachRecipientSchema.nullable(),
  appointment_id: z.string().uuid().nullable(),
  campaign_id: z.string().uuid().nullable(),
  title: z.string().min(1),
  context_label: z.string().nullable(),
  can_cancel: z.boolean(),
  cancel_scope: scheduledOutreachCancelScopeSchema.nullable(),
  allowed_actions: z.array(scheduledOutreachActionSchema)
});

export const scheduledOutreachListSchema = z.object({
  data: z.array(scheduledOutreachItemSchema),
  next_cursor: z.string().nullable(),
  total_count: z.number().int().nonnegative().optional()
});

export const outreachAutomationControlSchema = z.object({
  key: outreachAutomationKeySchema,
  label: z.string().min(1),
  enabled: z.boolean(),
  feature_available: z.boolean(),
  unavailable_reason: z.string().nullable(),
  mode: outreachAutomationModeSchema.nullable(),
  pending_approval_count: z.number().int().nonnegative(),
  queued_count: z.number().int().nonnegative(),
  scheduled_count: z.number().int().nonnegative(),
  status_label: z.string(),
  settings_version: z.number().int().positive().nullable(),
  channels: z.object({
    email: z.object({
      available: z.boolean(),
      enabled: z.boolean(),
      unavailable_reason: z.string().nullable()
    }),
    sms: z.object({
      available: z.boolean(),
      enabled: z.boolean(),
      unavailable_reason: z.string().nullable()
    })
  }),
  timing: z.record(z.union([z.number(), z.boolean(), z.null()])),
  settings: z.record(z.unknown()),
  content_rules: z.object({
    subject_max_length: z.number().int().positive(),
    message_max_length: z.number().int().positive(),
    available_tokens: z.array(z.string().min(1))
  }).nullable(),
  templates: z.array(z.object({
    emailType: z.string().min(1),
    subjectTemplate: z.string().nullable(),
    customMessageBlock: z.string().nullable(),
    configured: z.boolean(),
    availableTokens: z.array(z.string().min(1)),
    mutation: z.object({ method: z.literal("PATCH"), path: z.string().startsWith("/api/") })
  })),
  mutation: z.object({ method: z.literal("PATCH"), path: z.string().startsWith("/api/") }).nullable()
});

export const outreachAutomationsSchema = z.object({
  account_timezone: timeZoneSchema,
  summary: z.object({
    enabled_count: z.number().int().nonnegative(),
    available_count: z.number().int().nonnegative(),
    total_count: z.number().int().nonnegative()
  }),
  controls: z.array(outreachAutomationControlSchema),
  customers_reached: z.object({
    unique_clients: z.number().int().nonnegative(),
    window_start: isoDateTimeSchema,
    window_end: isoDateTimeSchema,
    timezone: timeZoneSchema,
    window_kind: z.literal("rolling"),
    window_days: z.number().int().positive(),
    included_message_types: z.array(z.string().min(1))
  })
});
