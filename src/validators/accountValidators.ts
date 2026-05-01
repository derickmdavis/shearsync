import { z } from "zod";

export const updateAccountPlanSchema = z.object({
  tier: z.enum(["basic", "pro", "premium"]),
  status: z.enum(["trialing", "active", "past_due", "cancelled"]).optional()
});
