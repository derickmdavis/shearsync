import { z } from "zod";
import { normalizePhone } from "../lib/phone";
import { isoDateTimeSchema, optionalEmailSchema } from "./common";
import { getCalendarDaySchema } from "./calendarValidators";

const publicPhoneSchema = z
  .string()
  .min(1)
  .max(40)
  .refine((value) => normalizePhone(value) !== null, "phone must be a valid phone number");

const bookingContextTokenSchema = z.string().min(1).max(4000).optional();

export const createPublicBookingSchema = z.object({
  stylist_slug: z.string().min(2).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  service_id: z.string().uuid(),
  requested_datetime: isoDateTimeSchema,
  guest_first_name: z.string().min(1).max(100),
  guest_last_name: z.string().min(1).max(100),
  guest_email: optionalEmailSchema,
  guest_phone: publicPhoneSchema,
  notes: z.string().max(2000).optional()
});

export const createPublicBookingIntakeSchema = z.object({
  stylist_slug: z.string().min(2).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  full_name: z.string().min(1).max(200),
  phone: publicPhoneSchema,
  email: optionalEmailSchema
});

export const getPublicServicesSchema = z.object({
  booking_context_token: bookingContextTokenSchema
});

export const getPublicAvailabilitySchema = z.object({
  booking_context_token: bookingContextTokenSchema
});

export const getPublicAvailabilitySlotsSchema = getCalendarDaySchema.extend({
  service_id: z.string().uuid(),
  booking_context_token: bookingContextTokenSchema
});
