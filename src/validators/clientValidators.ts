import { z } from "zod";
import { optionalEmailSchema } from "./common";

const preferredContactMethodSchema = z.enum(["text", "call", "email", "instagram"]);
const clientSourceSchema = z.enum(["referral", "instagram", "walk-in", "existing-client", "other"]);

export const createClientSchema = z.object({
  first_name: z.string().min(1).max(100),
  last_name: z.string().min(1).max(100),
  preferred_name: z.string().min(1).max(100).nullable().optional(),
  phone: z.string().max(40).optional(),
  email: optionalEmailSchema,
  instagram: z.string().max(100).nullable().optional(),
  birthday: z.string().date().optional(),
  preferred_contact_method: preferredContactMethodSchema.nullable().optional(),
  notes: z.string().max(5000).optional(),
  tags: z.array(z.string().min(1).max(100)).max(100).nullable().optional(),
  source: clientSourceSchema.nullable().optional(),
  reminder_consent: z.boolean().nullable().optional(),
  total_spend: z.number().min(0).nullable().optional(),
  last_visit_at: z.string().datetime({ offset: true }).nullable().optional()
});

export const updateClientSchema = createClientSchema.partial();
