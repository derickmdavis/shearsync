import { z } from "zod";
import { isValidTimeZone } from "../lib/timezone";

export const uuidParamSchema = z.object({
  id: z.string().uuid()
});

export const slugParamSchema = z.object({
  slug: z.string().min(2).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
});

export const isoDateTimeSchema = z.string().datetime({ offset: true });

export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");

export const optionalEmailSchema = z.string().email().optional().or(z.literal(""));

export const timeZoneSchema = z.string().refine(isValidTimeZone, "timezone must be a valid IANA timezone");
