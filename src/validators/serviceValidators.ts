import { z } from "zod";

const optionalTextField = z
  .string()
  .trim()
  .max(5000)
  .optional()
  .transform((value) => (value && value.length > 0 ? value : undefined));

const durationFieldSchema = z.number().int().gt(0).optional();
const priceFieldSchema = z.number().min(0).optional();

const normalizeServicePayload = <
  T extends {
    duration?: number;
    durationMinutes?: number;
    price?: number;
    priceAmount?: number;
  }
>(
  value: T
) => ({
  ...value,
  duration: value.duration ?? value.durationMinutes,
  price: value.price ?? value.priceAmount
});

const serviceInputSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    duration: durationFieldSchema,
    durationMinutes: durationFieldSchema,
    price: priceFieldSchema,
    priceAmount: priceFieldSchema,
    visible: z.boolean().optional(),
    category: optionalTextField.pipe(z.string().max(160).optional()),
    description: optionalTextField,
    isDefault: z.boolean().optional(),
    sortOrder: z.number().int().min(0).optional()
  })
  .superRefine((value, ctx) => {
    if (
      value.duration !== undefined &&
      value.durationMinutes !== undefined &&
      value.duration !== value.durationMinutes
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["durationMinutes"],
        message: "durationMinutes must match duration when both are provided"
      });
    }

    if (value.price !== undefined && value.priceAmount !== undefined && value.price !== value.priceAmount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["priceAmount"],
        message: "priceAmount must match price when both are provided"
      });
    }
  });

export const createServiceSchema = serviceInputSchema
  .superRefine((value, ctx) => {
    if (!value.name) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["name"],
        message: "name is required"
      });
    }

    if (value.duration === undefined && value.durationMinutes === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["duration"],
        message: "duration is required"
      });
    }

    if (value.price === undefined && value.priceAmount === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["price"],
        message: "price is required"
      });
    }

    if (value.visible === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["visible"],
        message: "visible is required"
      });
    }
  })
  .transform((value) => normalizeServicePayload(value));

export const updateServiceSchema = serviceInputSchema.transform((value) => normalizeServicePayload(value));

export const reorderServicesSchema = z.object({
  serviceIds: z.array(z.string().uuid()).min(1)
});
