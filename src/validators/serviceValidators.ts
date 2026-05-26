import { z } from "zod";

const optionalTextField = z
  .string()
  .trim()
  .max(5000)
  .optional()
  .transform((value) => (value && value.length > 0 ? value : undefined));

const durationFieldSchema = z.number().int().gt(0).optional();
const priceFieldSchema = z.number().min(0).optional();

const serviceInputSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    durationMinutes: durationFieldSchema,
    price: priceFieldSchema,
    isActive: z.boolean().optional(),
    category: optionalTextField.pipe(z.string().max(160).optional()),
    description: optionalTextField,
    isDefault: z.boolean().optional(),
    sortOrder: z.number().int().min(0).optional()
  })
  .strict();

export const createServiceSchema = serviceInputSchema
  .superRefine((value, ctx) => {
    if (!value.name) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["name"],
        message: "name is required"
      });
    }

    if (value.durationMinutes === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["durationMinutes"],
        message: "durationMinutes is required"
      });
    }

    if (value.price === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["price"],
        message: "price is required"
      });
    }

    if (value.isActive === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["isActive"],
        message: "isActive is required"
      });
    }
  })
  .transform((value) => value);

export const updateServiceSchema = serviceInputSchema.transform((value) => value);

export const reorderServicesSchema = z.object({
  serviceIds: z.array(z.string().uuid()).min(1)
});
