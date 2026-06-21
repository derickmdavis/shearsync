import { z } from "zod";

export const thankYouEmailStatusSchema = z.enum([
  "pending_approval",
  "queued",
  "sending",
  "sent",
  "cancelled",
  "skipped",
  "failed",
  "superseded"
]);

export const listThankYouEmailsQuerySchema = z.object({
  status: thankYouEmailStatusSchema.optional(),
  limit: z.coerce.number().int().positive().max(100).default(25),
  cursor: z.string().min(1).optional()
});

export const createThankYouEmailSchema = z.object({
  appointment_id: z.string().uuid(),
  approval_required: z.boolean().optional()
});

export const thankYouEmailIdParamSchema = z.object({
  id: z.string().uuid()
});

export const cancelThankYouEmailSchema = z.object({
  reason: z.string().max(500).nullable().optional()
});
