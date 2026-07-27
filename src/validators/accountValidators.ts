import { z } from "zod";

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
