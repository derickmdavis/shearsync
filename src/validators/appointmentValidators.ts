import { z } from "zod";
import { isoDateTimeSchema } from "./common";

export const appointmentStatusSchema = z.enum(["pending", "scheduled", "completed", "cancelled", "no_show"]);
export const bookingSourceSchema = z.enum(["public", "internal"]);

export const createAppointmentSchema = z.object({
  client_id: z.string().uuid(),
  appointment_date: isoDateTimeSchema,
  service_name: z.string().min(1).max(160),
  duration_minutes: z.number().int().positive().max(720),
  price: z.number().min(0).optional(),
  notes: z.string().max(5000).optional(),
  status: appointmentStatusSchema.default("scheduled"),
  booking_source: bookingSourceSchema.default("internal")
});

export const updateAppointmentSchema = createAppointmentSchema
  .omit({ client_id: true })
  .partial()
  .extend({
    client_id: z.string().uuid().optional()
  });

export const pendingAppointmentDecisionSchema = z.object({
  decision: z.enum(["accept", "reject"])
});

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

export const getInternalAppointmentContextSchema = z.object({
  date: z.string().refine(isValidDateString, "date must be YYYY-MM-DD"),
  durationMinutes: z.coerce.number().int().positive().max(720)
});
