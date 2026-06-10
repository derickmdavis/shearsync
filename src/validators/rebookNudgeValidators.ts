import { z } from "zod";

export const rebookNudgeStatusSchema = z.enum([
  "pending_approval",
  "queued",
  "sending",
  "sent",
  "cancelled",
  "skipped",
  "failed",
  "superseded"
]);

export const listRebookNudgesQuerySchema = z.object({
  status: rebookNudgeStatusSchema.optional(),
  limit: z.coerce.number().int().positive().max(100).default(25),
  cursor: z.string().min(1).optional()
});

export const createRebookNudgeSchema = z.object({
  client_id: z.string().uuid(),
  rebook_interval_days: z.number().int().min(1).max(730).optional(),
  approval_required: z.boolean().optional()
});

export const rebookNudgeIdParamSchema = z.object({
  id: z.string().uuid()
});

export const cancelRebookNudgeSchema = z.object({
  reason: z.string().max(500).nullable().optional()
});
