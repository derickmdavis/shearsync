import { z } from "zod";

export const campaignTrackingTokenParamSchema = z.object({
  token: z.string().min(32).max(200).regex(/^[A-Za-z0-9_-]+$/)
});
