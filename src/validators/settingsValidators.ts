import { z } from "zod";
import { timeZoneSchema } from "./common";

export const updateProfileSchema = z.object({
  full_name: z.string().min(1).max(160).optional(),
  phone_number: z.string().max(40).optional(),
  business_name: z.string().max(180).optional(),
  location_label: z.string().max(180).optional().or(z.literal("")),
  avatar_image_id: z.string().max(255).optional().or(z.literal("")),
  timezone: timeZoneSchema.optional()
});

export const updateBookingSettingsSchema = z.object({
  slug: z.string().min(2).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
  display_name: z.string().min(1).max(160).optional(),
  bio: z.string().max(2000).optional(),
  cover_photo_url: z.string().url().optional().or(z.literal("")),
  booking_enabled: z.boolean().optional()
});

const timeOfDaySchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/, "sameDayBookingCutoff must be HH:MM or HH:MM:SS");

const availabilityTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Availability times must use HH:MM");

const maxReschedulesSchema = z.union([z.number().int().min(0), z.literal("unlimited"), z.null()]);

const bookingRulesFields = {
  leadTimeHours: z.number().int().min(0),
  sameDayBookingAllowed: z.boolean(),
  sameDayBookingCutoff: timeOfDaySchema,
  maxBookingWindowDays: z.number().int().gt(0),
  cancellationWindowHours: z.number().int().min(0),
  lateCancellationFeeEnabled: z.boolean(),
  lateCancellationFeeType: z.enum(["flat", "percent"]),
  lateCancellationFeeValue: z.number().min(0),
  allowCancellationAfterCutoff: z.boolean(),
  rescheduleWindowHours: z.number().int().min(0),
  maxReschedules: maxReschedulesSchema,
  sameDayReschedulingAllowed: z.boolean(),
  preserveAppointmentHistory: z.boolean(),
  newClientApprovalRequired: z.boolean(),
  newClientBookingWindowDays: z.number().int().min(0),
  restrictServicesForNewClients: z.boolean(),
  restrictedServiceIds: z.array(z.string().uuid())
} satisfies Record<string, z.ZodTypeAny>;

export const bookingRulesSchema = z
  .object(bookingRulesFields)
  .superRefine((value, ctx) => {
    if (value.leadTimeHours > value.maxBookingWindowDays * 24) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "leadTimeHours must be less than or equal to maxBookingWindowDays * 24",
        path: ["leadTimeHours"]
      });
    }
  });

export const updateBookingRulesSchema = z.object(
  Object.fromEntries(
    Object.entries(bookingRulesFields).map(([key, schema]) => [key, schema.optional()])
  ) as {
    [K in keyof typeof bookingRulesFields]: z.ZodOptional<(typeof bookingRulesFields)[K]>;
  }
);

const availabilityWindowSchema = z.object({
  startTime: availabilityTimeSchema,
  endTime: availabilityTimeSchema
});

const availabilityDaySchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  isOpen: z.boolean(),
  windows: z.array(availabilityWindowSchema)
});

export const replaceAvailabilitySchema = z
  .object({
    days: z.array(availabilityDaySchema).length(7)
  })
  .superRefine((value, ctx) => {
    const daySet = new Set<number>();

    value.days.forEach((day, index) => {
      if (daySet.has(day.dayOfWeek)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Each dayOfWeek must appear exactly once",
          path: ["days", index, "dayOfWeek"]
        });
      }

      daySet.add(day.dayOfWeek);

      if (!day.isOpen && day.windows.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Closed days cannot include availability windows",
          path: ["days", index, "windows"]
        });
      }

      if (day.isOpen && day.windows.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Open days must include at least one availability window",
          path: ["days", index, "windows"]
        });
      }
    });
  });
