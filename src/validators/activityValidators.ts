import { z } from "zod";
import { isoDateSchema, isoDateTimeSchema } from "./common";

export const activityTypeSchema = z.enum([
  "booking_created",
  "appointment_cancelled",
  "appointment_rescheduled",
  "reminder_sent"
]);

const isValidDateString = (value: string): boolean => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);

  if (!match) {
    return false;
  }

  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    Number.isFinite(date.getTime()) &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
};

export const listActivityQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(25),
  cursor: z.string().min(1).optional(),
  activity_type: activityTypeSchema.optional(),
  start_date: isoDateSchema.refine(isValidDateString, "start_date must be YYYY-MM-DD").optional(),
  end_date: isoDateSchema.refine(isValidDateString, "end_date must be YYYY-MM-DD").optional()
}).refine(
  (value) => !value.start_date || !value.end_date || value.start_date <= value.end_date,
  {
    message: "start_date must be on or before end_date",
    path: ["end_date"]
  }
);

const bookingCreatedMetadataSchema = z.object({
  client_name: z.string().min(1),
  service_name: z.string().min(1),
  appointment_start_time: isoDateTimeSchema
});

const appointmentCancelledMetadataSchema = z.object({
  client_name: z.string().min(1),
  service_name: z.string().min(1),
  appointment_start_time: isoDateTimeSchema,
  cancelled_by: z.enum(["client", "stylist"])
});

const appointmentRescheduledMetadataSchema = z.object({
  client_name: z.string().min(1),
  service_name: z.string().min(1),
  old_start_time: isoDateTimeSchema,
  new_start_time: isoDateTimeSchema
});

const reminderSentMetadataSchema = z.object({
  client_name: z.string().min(1),
  channel: z.enum(["sms", "email"]),
  reminder_type: z.enum(["appointment_reminder", "follow_up", "general"]),
  appointment_start_time: isoDateTimeSchema.nullable()
});

const activityEventBaseSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  description: z.string().nullable(),
  occurred_at: isoDateTimeSchema,
  client_id: z.string().uuid().nullable(),
  appointment_id: z.string().uuid().nullable()
});

export const activityEventItemSchema = z.discriminatedUnion("activity_type", [
  activityEventBaseSchema.extend({
    activity_type: z.literal("booking_created"),
    metadata: bookingCreatedMetadataSchema.nullable()
  }),
  activityEventBaseSchema.extend({
    activity_type: z.literal("appointment_cancelled"),
    metadata: appointmentCancelledMetadataSchema.nullable()
  }),
  activityEventBaseSchema.extend({
    activity_type: z.literal("appointment_rescheduled"),
    metadata: appointmentRescheduledMetadataSchema.nullable()
  }),
  activityEventBaseSchema.extend({
    activity_type: z.literal("reminder_sent"),
    metadata: reminderSentMetadataSchema.nullable()
  })
]);

export const activityGroupSummarySchema = z.object({
  new_bookings: z.number().int().nonnegative(),
  cancellations: z.number().int().nonnegative(),
  reschedules: z.number().int().nonnegative(),
  reminders_sent: z.number().int().nonnegative()
});

export const activityDayGroupSchema = z.object({
  date: isoDateSchema.refine(isValidDateString, "date must be YYYY-MM-DD"),
  label: z.string(),
  summary: activityGroupSummarySchema,
  events: z.array(activityEventItemSchema)
});

export const activityFeedResponseSchema = z.object({
  groups: z.array(activityDayGroupSchema),
  next_cursor: z.string().nullable()
});

export const appointmentActivityResponseSchema = z.object({
  events: z.array(activityEventItemSchema)
});
