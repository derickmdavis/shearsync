import { z } from "zod";
import { SCHEDULED_OUTREACH_KINDS } from "../lib/outreachContracts";
import { scheduledOutreachKindSchema, scheduledOutreachStatusSchema } from "./outreachValidators";

const scheduledOutreachKindsQuerySchema = z.string().trim().min(1).transform((value, context) => {
  const values = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
  const invalid = values.find((item) => !(SCHEDULED_OUTREACH_KINDS as readonly string[]).includes(item));
  if (invalid) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `Unsupported scheduled outreach kind: ${invalid}` });
    return z.NEVER;
  }

  return values as Array<z.infer<typeof scheduledOutreachKindSchema>>;
});

export const listScheduledOutreachQuerySchema = z.object({
  status: scheduledOutreachStatusSchema.refine(
    (value) => value === "queued" || value === "sending",
    "Scheduled sends status must be queued or sending"
  ).default("queued"),
  kind: scheduledOutreachKindsQuerySchema.optional(),
  window: z.enum(["today_tomorrow"]).optional(),
  limit: z.coerce.number().int().positive().max(100).default(20),
  cursor: z.string().min(1).max(4000).optional()
});

export const scheduledOutreachIdParamSchema = z.object({
  id: z.string().min(1).max(4000)
});

export const cancelScheduledOutreachSchema = z.object({
  reason: z.string().trim().max(500).nullable().optional()
});
