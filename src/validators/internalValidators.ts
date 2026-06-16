import { z } from "zod";

const booleanQuerySchema = z
  .union([z.literal("true"), z.literal("false"), z.boolean()])
  .optional()
  .transform((value) => value === true || value === "true");

export const processAppointmentEmailsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  allow_noop: booleanQuerySchema
});

export const queueAppointmentRemindersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  user_limit: z.coerce.number().int().min(1).max(100).optional(),
  appointment_limit: z.coerce.number().int().min(1).max(100).optional(),
  window_minutes: z.coerce.number().int().min(1).max(120).optional()
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

export const purgeDeletedClientsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional()
});

export const cleanupAppointmentImagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  dry_run: booleanQuerySchema,
  include_orphans: booleanQuerySchema,
  prefix: z.string().trim().min(1).max(512).optional()
});
