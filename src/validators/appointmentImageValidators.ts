import { z } from "zod";
import { isoDateTimeSchema } from "./common";
import { APPOINTMENT_IMAGE_ALLOWED_CONTENT_TYPES } from "../services/appointmentImageStorageService";

const contentTypeSchema = z.enum(APPOINTMENT_IMAGE_ALLOWED_CONTENT_TYPES);
const imageRoleSchema = z.enum(["before", "after", "inspiration", "reference", "formula", "progress", "general"]);
const tagsSchema = z.array(z.string().trim().min(1).max(40)).max(10);

export const appointmentImageParamsSchema = z.object({
  id: z.string().uuid(),
  imageId: z.string().uuid()
});

export const appointmentImageUploadIntentSchema = z.object({
  original_filename: z.string().trim().min(1).max(255).nullable().optional(),
  content_type: contentTypeSchema,
  input_size_bytes: z.number().int().positive().max(5 * 1024 * 1024),
  display_content_type: contentTypeSchema,
  thumbnail_content_type: contentTypeSchema
});

export const finalizeAppointmentImageSchema = z.object({
  image_id: z.string().uuid(),
  storage_path: z.string().trim().min(1).max(2000),
  thumbnail_path: z.string().trim().min(1).max(2000),
  original_filename: z.string().trim().min(1).max(255).nullable().optional(),
  content_type: contentTypeSchema,
  file_size_bytes: z.number().int().positive().max(5 * 1024 * 1024),
  thumbnail_size_bytes: z.number().int().positive().nullable().optional(),
  width: z.number().int().positive().nullable().optional(),
  height: z.number().int().positive().nullable().optional(),
  image_role: imageRoleSchema.default("general"),
  captured_at: isoDateTimeSchema.nullable().optional(),
  label: z.string().trim().min(1).max(120).nullable().optional(),
  tags: tagsSchema.default([]),
  caption: z.string().max(1000).nullable().optional(),
  sort_order: z.number().int().min(0).optional()
});

export const updateAppointmentImageSchema = z.object({
  caption: z.string().max(1000).nullable().optional(),
  image_role: imageRoleSchema.optional(),
  sort_order: z.number().int().min(0).optional(),
  label: z.string().trim().min(1).max(120).nullable().optional(),
  tags: tagsSchema.optional()
}).refine((value) => Object.keys(value).length > 0, "At least one image metadata field is required");

export const reorderAppointmentImagesSchema = z.object({
  image_ids: z.array(z.string().uuid()).min(1).max(50)
});
