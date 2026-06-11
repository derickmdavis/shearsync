import { z } from "zod";

const booleanQuerySchema = z
  .union([z.literal("true"), z.literal("false"), z.boolean()])
  .optional()
  .transform((value) => value === true || value === "true");

export const processAppointmentEmailsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  allow_noop: booleanQuerySchema
});

export const queueRebookNudgesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional()
});

export const processRebookNudgesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional()
});

export const queueBirthdayRemindersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional()
});

export const processBirthdayRemindersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional()
});
