import { z } from "zod";
import { CAMPAIGN_LINK_TYPES, CAMPAIGN_STATUSES } from "../lib/outreachContracts";

const uniqueClientIds = z.array(z.string().uuid()).min(1).max(10_000)
  .refine((ids) => new Set(ids).size === ids.length, "Client selections must be unique");

export const estimateCampaignAudienceSchema = z.object({
  audience: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("everyone"), client_ids: z.array(z.string().uuid()).max(0).default([]) }),
    z.object({ mode: z.literal("specific"), client_ids: uniqueClientIds })
  ]),
  link_type: z.enum(CAMPAIGN_LINK_TYPES)
});

export const campaignIdParamSchema = z.object({ id: z.string().uuid() });
export const listCampaignsQuerySchema = z.object({
  status: z.enum(CAMPAIGN_STATUSES).optional(),
  limit: z.coerce.number().int().positive().max(100).default(50)
});
export const cancelCampaignSchema = z.object({ reason: z.string().trim().max(1000).nullable().optional() }).default({});
