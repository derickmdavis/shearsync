import { z } from "zod";
import { isoDateTimeSchema } from "./common";
import {
  APPOINTMENT_IMAGE_ALLOWED_CONTENT_TYPES,
  APPOINTMENT_IMAGE_MAX_DISPLAY_BYTES,
  APPOINTMENT_IMAGE_MAX_THUMBNAIL_BYTES
} from "../services/appointmentImageStorageService";

const contentTypeSchema = z.enum(APPOINTMENT_IMAGE_ALLOWED_CONTENT_TYPES);
const imageRoleSchema = z.enum(["before", "after", "inspiration", "reference", "formula", "progress", "general"]);
const tagsSchema = z.array(z.string().trim().min(1).max(40)).max(10);
const dimensionSchema = z.number().int().positive();

export const appointmentImageParamsSchema = z.object({
  id: z.string().uuid(),
  imageId: z.string().uuid()
});

export const appointmentImageUploadIntentSchema = z.object({
  original_filename: z.string().trim().min(1).max(255).nullable().optional(),
  content_type: contentTypeSchema,
  input_size_bytes: z.number().int().positive().max(APPOINTMENT_IMAGE_MAX_DISPLAY_BYTES),
  display_content_type: contentTypeSchema,
  thumbnail_content_type: contentTypeSchema
}).refine((value) => value.content_type === value.display_content_type, {
  message: "content_type must match display_content_type",
  path: ["display_content_type"]
});

const publicReferencePhotoUploadTokenSchema = z.string().trim().min(1).max(4000);

export const publicReferencePhotoUploadIntentSchema = z.object({
  reference_photo_upload_token: publicReferencePhotoUploadTokenSchema,
  original_filename: z.string().trim().min(1).max(255).nullable().optional(),
  content_type: contentTypeSchema,
  input_size_bytes: z.number().int().positive().max(APPOINTMENT_IMAGE_MAX_DISPLAY_BYTES),
  display_content_type: contentTypeSchema,
  thumbnail_content_type: contentTypeSchema
}).refine((value) => value.content_type === value.display_content_type, {
  message: "content_type must match display_content_type",
  path: ["display_content_type"]
});

export const finalizePublicReferencePhotoSchema = z.object({
  reference_photo_upload_token: publicReferencePhotoUploadTokenSchema,
  image_id: z.string().uuid(),
  storage_path: z.string().trim().min(1).max(2000),
  thumbnail_path: z.string().trim().min(1).max(2000),
  original_filename: z.string().trim().min(1).max(255).nullable().optional(),
  content_type: contentTypeSchema,
  file_size_bytes: z.number().int().positive().max(APPOINTMENT_IMAGE_MAX_DISPLAY_BYTES),
  thumbnail_size_bytes: z.number().int().positive().max(APPOINTMENT_IMAGE_MAX_THUMBNAIL_BYTES).nullable().optional(),
  width: dimensionSchema,
  height: dimensionSchema,
  thumbnail_width: dimensionSchema,
  thumbnail_height: dimensionSchema,
  caption: z.string().max(1000).nullable().optional()
});

export const appointmentImageThumbnailPrefetchQuerySchema = z.object({
  start_at: isoDateTimeSchema.optional(),
  end_at: isoDateTimeSchema.optional(),
  appointment_limit: z.coerce.number().int().min(1).max(100).default(25),
  image_limit_per_appointment: z.coerce.number().int().min(1).max(10).default(2),
  total_image_limit: z.coerce.number().int().min(1).max(100).default(50)
}).refine((value) => {
  if (!value.start_at || !value.end_at) {
    return true;
  }

  return Date.parse(value.start_at) < Date.parse(value.end_at);
}, {
  message: "end_at must be after start_at",
  path: ["end_at"]
});

export const clientVisualHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  include_display_urls: z.coerce.boolean().default(false)
});

export const finalizeAppointmentImageSchema = z.object({
  image_id: z.string().uuid(),
  storage_path: z.string().trim().min(1).max(2000),
  thumbnail_path: z.string().trim().min(1).max(2000),
  original_filename: z.string().trim().min(1).max(255).nullable().optional(),
  content_type: contentTypeSchema,
  file_size_bytes: z.number().int().positive().max(APPOINTMENT_IMAGE_MAX_DISPLAY_BYTES),
  thumbnail_size_bytes: z.number().int().positive().max(APPOINTMENT_IMAGE_MAX_THUMBNAIL_BYTES).nullable().optional(),
  width: dimensionSchema,
  height: dimensionSchema,
  thumbnail_width: dimensionSchema,
  thumbnail_height: dimensionSchema,
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
