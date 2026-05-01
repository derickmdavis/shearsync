import { z } from "zod";
import { isoDateTimeSchema } from "./common";

export const reminderStatusSchema = z.enum(["open", "done", "dismissed", "sent"]);
export const createReminderStatusSchema = z.enum(["open", "done", "dismissed"]);
export const reminderChannelSchema = z.enum(["sms", "email"]);
export const reminderTypeSchema = z.enum(["appointment_reminder", "follow_up", "general"]);

export const createReminderSchema = z.object({
  client_id: z.string().uuid(),
  appointment_id: z.string().uuid().optional(),
  title: z.string().min(1).max(200),
  due_date: isoDateTimeSchema,
  status: createReminderStatusSchema.default("open"),
  channel: reminderChannelSchema.optional(),
  reminder_type: reminderTypeSchema.optional(),
  sent_at: isoDateTimeSchema.optional(),
  notes: z.string().max(5000).optional()
});

export const updateReminderSchema = createReminderSchema
  .omit({ status: true })
  .partial()
  .extend({
    status: reminderStatusSchema.optional()
  });
