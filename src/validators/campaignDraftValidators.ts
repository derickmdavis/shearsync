import { z } from "zod";
import {
  CAMPAIGN_LINK_TYPES,
  CAMPAIGN_MESSAGE_MAX_LENGTH,
  CAMPAIGN_NAME_MAX_LENGTH,
  CAMPAIGN_PERSONALIZATION_TOKENS,
  CAMPAIGN_SEND_MODES,
  CAMPAIGN_SUBJECT_MAX_LENGTH
} from "../lib/outreachContracts";
import { isoDateTimeSchema, timeZoneSchema } from "./common";
import { extractCampaignTokens } from "./outreachValidators";

const draftText = (max: number) => z.string().max(max).superRefine((value, context) => {
  const unsupported = extractCampaignTokens(value).find(
    (token) => !(CAMPAIGN_PERSONALIZATION_TOKENS as readonly string[]).includes(token)
  );
  if (unsupported) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `Unsupported campaign personalization token: ${unsupported}` });
  }
});

const draftAudienceSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("everyone"), client_ids: z.array(z.string().uuid()).max(0).default([]) }),
  z.object({ mode: z.literal("specific"), client_ids: z.array(z.string().uuid()).max(10_000)
    .refine((ids) => new Set(ids).size === ids.length, "Client selections must be unique") })
]);

export const createCampaignDraftSchema = z.object({
  template_id: z.string().uuid().nullable().optional()
}).default({});

export const campaignDraftIdParamSchema = z.object({ id: z.string().uuid() });

export const previewCampaignDraftSchema = z.object({
  first_name: z.string().trim().max(100).nullable().optional()
}).default({});

export const validateCampaignDraftSchema = z.object({
  revision: z.number().int().positive()
});

export const submitCampaignDraftSchema = z.object({
  revision: z.number().int().positive(),
  validation_token: z.string().min(20).max(10_000)
});

export const updateCampaignDraftSchema = z.object({
  revision: z.number().int().positive(),
  name: z.string().trim().min(1).max(CAMPAIGN_NAME_MAX_LENGTH).nullable().optional(),
  send_mode: z.enum(CAMPAIGN_SEND_MODES).optional(),
  send_at: isoDateTimeSchema.nullable().optional(),
  timezone: timeZoneSchema.optional(),
  link_type: z.enum(CAMPAIGN_LINK_TYPES).nullable().optional(),
  template_id: z.string().uuid().nullable().optional(),
  audience: draftAudienceSchema.optional(),
  content: z.object({
    subject: draftText(CAMPAIGN_SUBJECT_MAX_LENGTH).nullable().optional(),
    message: draftText(CAMPAIGN_MESSAGE_MAX_LENGTH).nullable().optional()
  }).partial().optional()
}).superRefine((value, context) => {
  if (Object.keys(value).every((key) => key === "revision")) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "At least one draft field is required" });
  }
  if (value.send_mode === "now" && value.send_at) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "send_at must be null for send-now drafts", path: ["send_at"] });
  }
});

export const listCampaignTemplatesQuerySchema = z.object({
  status: z.enum(["active", "inactive", "all"]).default("active"),
  limit: z.coerce.number().int().positive().max(100).default(20),
  cursor: z.string().min(1).max(1000).optional()
});
