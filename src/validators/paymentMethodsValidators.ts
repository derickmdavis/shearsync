import { z } from "zod";

export const paymentProviderSchema = z.enum([
  "venmo",
  "paypal",
  "square",
  "cash_app",
  "zelle",
  "apple_pay",
  "google_pay",
  "cash",
  "other"
]);

const emptyToNull = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? null : value;

const nullableTrimmedString = (max: number) =>
  z.preprocess(
    emptyToNull,
    z.string().trim().max(max).nullable().optional()
  );

const nullableUrl = (max: number) =>
  z.preprocess(
    emptyToNull,
    z.string().trim().url().max(max).nullable().optional()
  );

const paymentMethodTargetFields = {
  payment_url: nullableUrl(2048),
  qr_image_url: nullableUrl(2048),
  qr_image_path: nullableTrimmedString(500)
};

const hasExternalPaymentTarget = (value: {
  provider?: string;
  payment_url?: string | null;
  qr_image_url?: string | null;
  qr_image_path?: string | null;
}) =>
  value.provider === "cash"
  || value.provider === "other"
  || Boolean(value.payment_url)
  || Boolean(value.qr_image_url)
  || Boolean(value.qr_image_path);

export const listPaymentMethodsQuerySchema = z.object({
  include_inactive: z.coerce.boolean().optional().default(false)
});

export const createPaymentMethodSchema = z.object({
  provider: paymentProviderSchema,
  display_name: z.string().trim().min(1).max(80),
  ...paymentMethodTargetFields,
  instructions: nullableTrimmedString(500),
  is_default: z.boolean().optional().default(false),
  is_active: z.boolean().optional().default(true),
  sort_order: z.number().int().min(0).optional().default(0)
}).refine(hasExternalPaymentTarget, {
  message: "At least one payment URL or QR image is required unless provider is cash or other",
  path: ["payment_url"]
});

export const updatePaymentMethodSchema = z.object({
  provider: paymentProviderSchema.optional(),
  display_name: z.string().trim().min(1).max(80).optional(),
  ...paymentMethodTargetFields,
  instructions: nullableTrimmedString(500),
  is_default: z.boolean().optional(),
  is_active: z.boolean().optional(),
  sort_order: z.number().int().min(0).optional()
});

export const reorderPaymentMethodsSchema = z.object({
  items: z.array(z.object({
    id: z.string().uuid(),
    sort_order: z.number().int().min(0)
  })).min(1).max(100)
});

export const qrUploadIntentSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  content_type: z.enum(["image/png", "image/jpeg", "image/webp"]),
  size_bytes: z.number().int().positive().max(5 * 1024 * 1024)
});

export type PaymentProvider = z.infer<typeof paymentProviderSchema>;
