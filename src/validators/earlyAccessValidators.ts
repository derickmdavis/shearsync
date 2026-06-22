import { z } from "zod";

const optionalTrimmedText = (maxLength: number) =>
  z.union([z.string(), z.null()]).optional().transform((value) => {
    if (value === undefined) {
      return undefined;
    }

    if (value === null) {
      return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }).pipe(z.string().max(maxLength).nullable().optional());

const normalizeOptionalAlias = (value: string | undefined): string | null | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const createEarlyAccessRequestSchema = z
  .object({
    fullName: z.string().optional(),
    full_name: z.string().optional(),
    email: z.string(),
    phone: optionalTrimmedText(40),
    source: optionalTrimmedText(100),
    utmSource: z.string().optional(),
    utm_source: z.string().optional(),
    utmMedium: z.string().optional(),
    utm_medium: z.string().optional(),
    utmCampaign: z.string().optional(),
    utm_campaign: z.string().optional(),
    notes: optionalTrimmedText(1000)
  })
  .transform((value) => ({
    full_name: (value.full_name ?? value.fullName ?? "").trim(),
    email: value.email.trim().toLowerCase(),
    phone: value.phone,
    source: value.source,
    utm_source: normalizeOptionalAlias(value.utm_source ?? value.utmSource),
    utm_medium: normalizeOptionalAlias(value.utm_medium ?? value.utmMedium),
    utm_campaign: normalizeOptionalAlias(value.utm_campaign ?? value.utmCampaign),
    notes: value.notes
  }))
  .pipe(
    z.object({
      full_name: z.string().min(2).max(120),
      email: z.string().email().max(254),
      phone: z.string().max(40).nullable().optional(),
      source: z.string().max(100).nullable().optional(),
      utm_source: z.string().max(100).nullable().optional(),
      utm_medium: z.string().max(100).nullable().optional(),
      utm_campaign: z.string().max(150).nullable().optional(),
      notes: z.string().max(1000).nullable().optional()
    })
  );

export type CreateEarlyAccessRequestInput = z.infer<typeof createEarlyAccessRequestSchema>;
