import { z } from "zod";
import { normalizePhone } from "../lib/phone";

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

const optionalNullableText = (maxLength: number) =>
  z.union([z.string().trim().max(maxLength), z.null()]).optional().transform((value) => {
    if (value === undefined) {
      return undefined;
    }

    return value && value.length > 0 ? value : null;
  });

const optionalEmail = z.union([z.string().trim().email(), z.literal(""), z.null()]).optional().transform((value) => {
  if (value === undefined) {
    return undefined;
  }

  return value ? value.toLowerCase() : null;
});

const optionalPhone = z.union([z.string().trim().max(40), z.literal(""), z.null()]).optional().transform((value, ctx) => {
  if (value === undefined) {
    return undefined;
  }

  if (!value) {
    return null;
  }

  const normalized = normalizePhone(value);
  if (!normalized) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "clientPhone must be a valid phone number"
    });
    return z.NEVER;
  }

  return normalized;
});

const isoDateOnlySchema = z.string().refine(isValidDateString, "requestedDate must be YYYY-MM-DD");

const waitlistStatusSchema = z.enum(["active", "contacted", "booked", "cancelled", "expired"]);

const waitlistInputFields = {
  requestedDate: isoDateOnlySchema,
  serviceId: z.string().uuid().nullable().optional(),
  requestedTimePreference: optionalNullableText(120),
  clientName: z.string().trim().min(1).max(120),
  clientEmail: optionalEmail,
  clientPhone: optionalPhone,
  note: optionalNullableText(500)
};

const requireContact = <T extends { clientEmail?: string | null; clientPhone?: string | null }>(
  value: T,
  ctx: z.RefinementCtx
) => {
  if (!value.clientEmail && !value.clientPhone) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["clientEmail"],
      message: "Please provide either an email address or phone number."
    });
  }
};

export const createPublicWaitlistEntrySchema = z
  .object(waitlistInputFields)
  .superRefine(requireContact);

export const createStylistWaitlistEntrySchema = createPublicWaitlistEntrySchema;

export const updateWaitlistEntrySchema = z
  .object({
    ...waitlistInputFields,
    status: waitlistStatusSchema.optional()
  })
  .partial()
  .superRefine((value, ctx) => {
    if (
      (value.clientEmail !== undefined || value.clientPhone !== undefined) &&
      !value.clientEmail &&
      !value.clientPhone
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["clientEmail"],
        message: "Please provide either an email address or phone number."
      });
    }
  });

export const listWaitlistQuerySchema = z
  .object({
    status: waitlistStatusSchema.optional(),
    startDate: isoDateOnlySchema.optional(),
    endDate: isoDateOnlySchema.optional(),
    serviceId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional()
  })
  .superRefine((value, ctx) => {
    if (value.startDate && value.endDate && value.startDate > value.endDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["startDate"],
        message: "startDate must be before or equal to endDate"
      });
    }
  });

