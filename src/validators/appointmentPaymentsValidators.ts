import { z } from "zod";
import { paymentProviderSchema } from "./paymentMethodsValidators";

const emptyToNull = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? null : value;

const optionalNullableTrimmedString = (max: number) =>
  z.preprocess(
    emptyToNull,
    z.string().trim().max(max).nullable().optional()
  );

const moneySchema = z.number().min(0).max(999999.99);

export const markAppointmentPaidSchema = z.object({
  payment_method_id: z.string().uuid().nullable().optional(),
  amount: moneySchema.optional(),
  tip_amount: moneySchema.optional().default(0),
  external_provider: paymentProviderSchema.nullable().optional(),
  external_provider_label: optionalNullableTrimmedString(120),
  external_reference: optionalNullableTrimmedString(255),
  notes: optionalNullableTrimmedString(2000)
});

export const updateAppointmentPaymentSchema = z.object({
  payment_method_id: z.string().uuid().nullable().optional(),
  amount: moneySchema.optional(),
  tip_amount: moneySchema.optional(),
  external_provider: paymentProviderSchema.nullable().optional(),
  external_provider_label: optionalNullableTrimmedString(120),
  external_reference: optionalNullableTrimmedString(255),
  notes: optionalNullableTrimmedString(2000)
});
