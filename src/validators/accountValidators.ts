import { z } from "zod";

export const updateAccountPlanSchema = z.object({
  tier: z.enum(["basic", "pro", "premium"]),
  status: z.enum(["trialing", "active", "past_due", "cancelled"]).optional()
});

export const requestAccountDeletionSchema = z.object({
  confirmation: z.literal("DELETE"),
  reason: z
    .string()
    .trim()
    .max(1000)
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined)),
  clientRequestId: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .optional()
});
