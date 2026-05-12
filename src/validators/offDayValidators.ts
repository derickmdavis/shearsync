import { z } from "zod";

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

const isoDateSchema = z.string().refine(isValidDateString, "date must be YYYY-MM-DD");

const nullableText = (maxLength: number) =>
  z.union([z.string().trim().max(maxLength), z.null()]).optional().transform((value) => {
    if (value === undefined) {
      return undefined;
    }

    return value && value.length > 0 ? value : null;
  });

export const listOffDaysQuerySchema = z
  .object({
    startDate: isoDateSchema.optional(),
    endDate: isoDateSchema.optional()
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

const offDayInputSchema = z.object({
  date: isoDateSchema.optional(),
  label: nullableText(100),
  reason: nullableText(500),
  isRecurring: z.boolean().optional()
});

export const createOffDaySchema = offDayInputSchema
  .superRefine((value, ctx) => {
    if (!value.date) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["date"],
        message: "date is required"
      });
    }
  })
  .transform((value) => ({
    ...value,
    date: value.date as string,
    isRecurring: value.isRecurring ?? false
  }));

export const updateOffDaySchema = offDayInputSchema.transform((value) => ({
  ...value,
  isRecurring: value.isRecurring
}));

export const bulkCreateOffDaysSchema = z.object({
  offDays: z.array(createOffDaySchema).min(1).max(366)
});
