import { z } from "zod";
import { isoDateSchema } from "./common";
import {
  APPOINTMENT_IMAGE_ALLOWED_CONTENT_TYPES,
  APPOINTMENT_IMAGE_MAX_DISPLAY_BYTES,
  APPOINTMENT_IMAGE_MAX_THUMBNAIL_BYTES
} from "../services/appointmentImageStorageService";

export const CLIENT_FORMULA_SECTION_TYPES = [
  "formula",
  "application",
  "processing",
  "result",
  "aftercare",
  "custom"
] as const;
export const CLIENT_FORMULA_SECTION_KINDS = ["root", "lightener", "toner", "gloss", "color", "mid_lengths", "ends", "custom"] as const;

export const clientFormulaSectionTypeSchema = z.enum(CLIENT_FORMULA_SECTION_TYPES);
export const clientFormulaSectionKindSchema = z.enum(CLIENT_FORMULA_SECTION_KINDS);

export const clientFormulaSectionSchema = z.object({
  type: clientFormulaSectionTypeSchema.optional(),
  section_kind: clientFormulaSectionKindSchema.optional(),
  display_label: z.string().trim().min(1).max(120).nullable().optional(),
  custom_label: z.string().trim().min(1).max(120).nullable().optional(),
  content: z.string().trim().min(1).max(5000),
  sort_order: z.number().int().min(0)
}).superRefine((section, context) => {
  if (!section.type && !section.section_kind) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["section_kind"], message: "A section kind is required" });
  }
  if (section.section_kind === "custom" && !section.display_label && !section.custom_label) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["display_label"], message: "A custom section requires a display_label" });
  }
  if (section.type === "custom" && !section.custom_label) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["custom_label"],
      message: "A custom section requires a custom_label"
    });
  }

  if (section.type !== "custom" && section.custom_label !== undefined && section.custom_label !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["custom_label"],
      message: "custom_label is only allowed for custom sections"
    });
  }
});

const nullableText = (max: number) => z.string().max(max).nullable().optional();
const formulaBaseSchema = z.object({
  appointment_id: z.string().uuid().nullable().optional(), service_id: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(1).max(160).nullable().optional(), formula_date: isoDateSchema,
  service_name_snapshot: z.string().trim().min(1).max(160).nullable().optional(),
  processing_notes: nullableText(5000), result_notes: nullableText(5000),
  sections: z.array(clientFormulaSectionSchema).min(1).max(30)
});
export const createClientFormulaSchema = formulaBaseSchema;
export const updateClientFormulaSchema = formulaBaseSchema.partial().refine((value) => Object.keys(value).length > 0, "At least one field is required");
export const listClientFormulasQuerySchema = z.object({ cursor: z.string().min(1).max(1000).optional(), limit: z.coerce.number().int().min(1).max(100).default(25), view: z.enum(["default", "client-detail"]).default("default") });
export const formulaParamsSchema = z.object({ id: z.string().uuid(), formulaId: z.string().uuid() });
export const formulaPhotoParamsSchema = formulaParamsSchema.extend({ photoId: z.string().uuid() });

const imageContentType = z.enum(APPOINTMENT_IMAGE_ALLOWED_CONTENT_TYPES);
export const formulaImageUploadIntentSchema = z.object({
  original_filename: z.string().trim().min(1).max(255).nullable().optional(), content_type: imageContentType,
  input_size_bytes: z.number().int().positive().max(APPOINTMENT_IMAGE_MAX_DISPLAY_BYTES), display_content_type: imageContentType,
  thumbnail_content_type: imageContentType
}).refine((value) => value.content_type === value.display_content_type, { path: ["display_content_type"], message: "content_type must match display_content_type" });
export const finalizeFormulaImageSchema = z.object({
  image_id: z.string().uuid(), storage_path: z.string().min(1).max(2000), thumbnail_path: z.string().min(1).max(2000),
  original_filename: z.string().trim().min(1).max(255).nullable().optional(), content_type: imageContentType,
  file_size_bytes: z.number().int().positive().max(APPOINTMENT_IMAGE_MAX_DISPLAY_BYTES), thumbnail_size_bytes: z.number().int().positive().max(APPOINTMENT_IMAGE_MAX_THUMBNAIL_BYTES).nullable().optional(),
  width: z.number().int().positive().max(1600), height: z.number().int().positive().max(1600), thumbnail_width: z.number().int().positive().max(400), thumbnail_height: z.number().int().positive().max(400),
  image_role: z.enum(["formula", "reference", "inspiration", "general"]).default("formula"), caption: z.string().max(1000).nullable().optional(), photo_type: z.string().trim().min(1).max(80).nullable().optional()
});
export const attachFormulaPhotoSchema = z.object({ image_id: z.string().uuid(), source: z.enum(["appointment", "formula"]), photo_type: z.string().trim().min(1).max(80).nullable().optional() });
export const reorderFormulaPhotosSchema = z.object({ photo_ids: z.array(z.string().uuid()).min(1).max(50) });
