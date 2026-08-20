import { z } from "zod";

export const createInAppFeedbackSchema = z.object({
  rating: z.number().int().min(1).max(3),
  feedback: z.string().trim().max(4000).optional()
}).strict();
