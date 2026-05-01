import { z } from "zod";

export const profileOverviewQuerySchema = z.object({
  performancePeriod: z.enum(["week", "month"]).optional()
});
