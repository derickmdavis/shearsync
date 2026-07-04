import { z } from "zod";

export const birthdayReminderIdParamSchema = z.object({
  id: z.string().uuid()
});

export const cancelBirthdayReminderSchema = z.object({
  reason: z.string().max(500).nullable().optional()
});
