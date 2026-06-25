import { randomUUID } from "crypto";
import { ApiError, requireFound } from "../lib/errors";
import {
  ResolvedPublicAppointmentImageUploadContext,
  resolvePublicAppointmentImageUploadToken
} from "../lib/publicAppointmentImageUpload";
import { supabaseAdmin } from "../lib/supabase";
import {
  APPOINTMENT_IMAGES_BUCKET,
  APPOINTMENT_IMAGE_MAX_DISPLAY_BYTES,
  APPOINTMENT_IMAGE_MAX_DISPLAY_LONG_EDGE,
  APPOINTMENT_IMAGE_MAX_THUMBNAIL_BYTES,
  APPOINTMENT_IMAGE_MAX_THUMBNAIL_LONG_EDGE,
  AppointmentImagePaths,
  appointmentImageStorageService
} from "./appointmentImageStorageService";
import type { Row } from "./db";
import { handleSupabaseError } from "./db";
import { entitlementsService } from "./entitlementsService";
import { bookingErrorEventsService } from "./bookingErrorEventsService";

const UPLOAD_INTENT_TTL_MINUTES = 15;

type PublicUploadIntentPayload = {
  reference_photo_upload_token: string;
  original_filename?: string | null;
  content_type: string;
  input_size_bytes: number;
  display_content_type: string;
  thumbnail_content_type: string;
};

type PublicFinalizePayload = {
  reference_photo_upload_token: string;
  image_id: string;
  storage_path: string;
  thumbnail_path: string;
  original_filename?: string | null;
  content_type: string;
  file_size_bytes: number;
  thumbnail_size_bytes?: number | null;
  width: number;
  height: number;
  thumbnail_width: number;
  thumbnail_height: number;
  caption?: string | null;
};

const toIso = (date: Date): string => date.toISOString();

const assertReferencePhotosAllowed = async (stylistId: string): Promise<void> => {
  await entitlementsService.assertFeatureAllowed(stylistId, "appointmentPhotos");
};

const isActiveReferenceImage = (image: Row, nowIso: string): boolean => {
  if (image.upload_status === "ready") {
    return true;
  }

  return image.upload_status === "pending"
    && typeof image.upload_expires_at === "string"
    && image.upload_expires_at > nowIso;
};

const inferContentTypeFromPath = (path: string): string | null => {
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) {
    return "image/jpeg";
  }

  if (path.endsWith(".png")) {
    return "image/png";
  }

  if (path.endsWith(".webp")) {
    return "image/webp";
  }

  return null;
};

const assertLongestEdgeWithinLimit = (
  label: string,
  width: number,
  height: number,
  maxLongEdge: number
): void => {
  if (Math.max(width, height) > maxLongEdge) {
    throw new ApiError(400, `${label} dimensions exceed maximum size`);
  }
};

const resolveContext = (token: string): ResolvedPublicAppointmentImageUploadContext =>
  resolvePublicAppointmentImageUploadToken(token);

export const publicAppointmentImagesService = {
  async getTokenAppointment(context: ResolvedPublicAppointmentImageUploadContext): Promise<Row> {
    const { data, error } = await supabaseAdmin
      .from("appointments")
      .select("*")
      .eq("id", context.appointmentId)
      .eq("user_id", context.stylistId)
      .eq("client_id", context.clientId)
      .maybeSingle();

    handleSupabaseError(error, "Unable to load reference photo appointment");
    const appointment = requireFound(data, "Reference photo upload token is invalid or expired");

    if (appointment.appointment_date !== context.appointmentStartTime) {
      throw new ApiError(400, "Reference photo upload token is invalid or expired");
    }

    if (appointment.status === "cancelled") {
      throw new ApiError(409, "Reference photo upload is no longer available for this appointment");
    }

    return appointment;
  },

  async expirePendingReferenceUploads(context: ResolvedPublicAppointmentImageUploadContext, now = new Date()): Promise<void> {
    const { error } = await supabaseAdmin
      .from("appointment_images")
      .update({ upload_status: "expired" })
      .eq("user_id", context.stylistId)
      .eq("client_id", context.clientId)
      .eq("appointment_id", context.appointmentId)
      .eq("image_source", "client")
      .eq("image_role", "reference")
      .eq("upload_status", "pending")
      .lte("upload_expires_at", toIso(now));

    handleSupabaseError(error, "Unable to expire pending reference photo uploads");
  },

  async assertReferenceImageAvailable(context: ResolvedPublicAppointmentImageUploadContext, now = new Date()): Promise<void> {
    const nowIso = toIso(now);
    const { data, error } = await supabaseAdmin
      .from("appointment_images")
      .select("id, upload_status, upload_expires_at")
      .eq("user_id", context.stylistId)
      .eq("client_id", context.clientId)
      .eq("appointment_id", context.appointmentId)
      .eq("image_source", "client")
      .eq("image_role", "reference")
      .in("upload_status", ["pending", "ready"]);

    handleSupabaseError(error, "Unable to validate reference photo limit");

    if ((data ?? []).some((image) => isActiveReferenceImage(image, nowIso))) {
      throw new ApiError(409, "Appointment reference photo already exists");
    }
  },

  async createUploadIntent(payload: PublicUploadIntentPayload, now = new Date()): Promise<Row> {
    if (payload.content_type !== payload.display_content_type) {
      throw new ApiError(400, "Reference photo upload intent content_type must match display_content_type");
    }

    if (payload.input_size_bytes > APPOINTMENT_IMAGE_MAX_DISPLAY_BYTES) {
      throw new ApiError(400, "Appointment reference photo exceeds maximum size");
    }

    const context = resolveContext(payload.reference_photo_upload_token);
    try {
      await assertReferencePhotosAllowed(context.stylistId);
      const appointment = await this.getTokenAppointment(context);
      await this.expirePendingReferenceUploads(context, now);
      await this.assertReferenceImageAvailable(context, now);

      const imageId = randomUUID();
      const uploadExpiresAt = new Date(now.getTime() + UPLOAD_INTENT_TTL_MINUTES * 60 * 1000);
      const paths = appointmentImageStorageService.generatePaths({
        userId: context.stylistId,
        clientId: context.clientId,
        appointmentId: context.appointmentId,
        imageId,
        displayContentType: payload.display_content_type,
        thumbnailContentType: payload.thumbnail_content_type
      });
      const uploadUrls = await appointmentImageStorageService.createSignedUploadUrls(paths);

      const { data, error } = await supabaseAdmin
        .from("appointment_images")
        .insert({
          id: imageId,
          user_id: context.stylistId,
          client_id: context.clientId,
          appointment_id: context.appointmentId,
          bucket: APPOINTMENT_IMAGES_BUCKET,
          storage_path: paths.storagePath,
          thumbnail_path: paths.thumbnailPath,
          original_filename: payload.original_filename ?? null,
          content_type: payload.display_content_type,
          file_size_bytes: payload.input_size_bytes,
          image_role: "reference",
          image_source: "client",
          uploaded_by_user_id: null,
          public_upload_token_id: context.tokenId,
          cache_version: 1,
          upload_status: "pending",
          upload_expires_at: toIso(uploadExpiresAt),
          finalized_at: null
        })
        .select("*")
        .single();

      handleSupabaseError(error, "Unable to create reference photo upload intent");

      return {
        ...requireFound(data, "Reference photo upload intent was not created"),
        signed_upload_urls: uploadUrls,
        max_constraints: {
          max_reference_images: 1,
          max_file_size_bytes: APPOINTMENT_IMAGE_MAX_DISPLAY_BYTES,
          max_display_file_size_bytes: APPOINTMENT_IMAGE_MAX_DISPLAY_BYTES,
          max_thumbnail_file_size_bytes: APPOINTMENT_IMAGE_MAX_THUMBNAIL_BYTES,
          max_display_long_edge_px: APPOINTMENT_IMAGE_MAX_DISPLAY_LONG_EDGE,
          max_thumbnail_long_edge_px: APPOINTMENT_IMAGE_MAX_THUMBNAIL_LONG_EDGE,
          upload_expires_in_minutes: UPLOAD_INTENT_TTL_MINUTES
        },
        appointment_status: appointment.status
      };
    } catch (error) {
      await bookingErrorEventsService.recordBookingError({
        accountUserId: context.stylistId,
        clientId: context.clientId,
        appointmentId: context.appointmentId,
        step: "reference_photo_upload",
        errorCode: "reference_photo_upload_failed",
        severity: error instanceof ApiError && error.statusCode < 500 ? "warning" : "error",
        errorMessage: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  },

  async finalize(payload: PublicFinalizePayload, now = new Date()): Promise<Row> {
    const context = resolveContext(payload.reference_photo_upload_token);
    try {
      await assertReferencePhotosAllowed(context.stylistId);
      await this.getTokenAppointment(context);

    const { data: pendingImage, error: pendingError } = await supabaseAdmin
      .from("appointment_images")
      .select("*")
      .eq("id", payload.image_id)
      .eq("user_id", context.stylistId)
      .eq("client_id", context.clientId)
      .eq("appointment_id", context.appointmentId)
      .eq("image_source", "client")
      .eq("image_role", "reference")
      .eq("upload_status", "pending")
      .maybeSingle();

    handleSupabaseError(pendingError, "Unable to load pending reference photo");
    const image = requireFound(pendingImage, "Pending reference photo not found");
    const paths: AppointmentImagePaths = {
      storagePath: payload.storage_path,
      thumbnailPath: payload.thumbnail_path
    };

    if (image.public_upload_token_id !== context.tokenId) {
      throw new ApiError(400, "Reference photo upload token does not match upload intent");
    }

    if (typeof image.upload_expires_at === "string" && image.upload_expires_at <= toIso(now)) {
      const { error } = await supabaseAdmin
        .from("appointment_images")
        .update({ upload_status: "expired" })
        .eq("id", payload.image_id)
        .eq("user_id", context.stylistId);

      handleSupabaseError(error, "Unable to expire reference photo upload intent");
      throw new ApiError(410, "Reference photo upload intent expired");
    }

    if (payload.storage_path !== image.storage_path || payload.thumbnail_path !== image.thumbnail_path) {
      throw new ApiError(400, "Reference photo storage path does not match upload intent");
    }

    appointmentImageStorageService.assertPathMatches({
      userId: context.stylistId,
      clientId: context.clientId,
      appointmentId: context.appointmentId,
      imageId: payload.image_id,
      displayContentType: payload.content_type,
      thumbnailContentType: inferContentTypeFromPath(payload.thumbnail_path) ?? payload.content_type,
      storagePath: payload.storage_path,
      thumbnailPath: payload.thumbnail_path
    });

    try {
      assertLongestEdgeWithinLimit(
        "Reference photo display",
        payload.width,
        payload.height,
        APPOINTMENT_IMAGE_MAX_DISPLAY_LONG_EDGE
      );
      assertLongestEdgeWithinLimit(
        "Reference photo thumbnail",
        payload.thumbnail_width,
        payload.thumbnail_height,
        APPOINTMENT_IMAGE_MAX_THUMBNAIL_LONG_EDGE
      );

      const verified = await appointmentImageStorageService.verifyObjects(paths, {
        display: {
          expectedContentType: payload.content_type,
          expectedSizeBytes: payload.file_size_bytes,
          maxSizeBytes: APPOINTMENT_IMAGE_MAX_DISPLAY_BYTES
        },
        thumbnail: {
          expectedContentType: inferContentTypeFromPath(payload.thumbnail_path) ?? undefined,
          expectedSizeBytes: payload.thumbnail_size_bytes ?? undefined,
          maxSizeBytes: APPOINTMENT_IMAGE_MAX_THUMBNAIL_BYTES
        }
      });

      if (!verified.display.exists || !verified.thumbnail.exists) {
        throw new ApiError(400, "Reference photo upload is incomplete");
      }
    } catch (error) {
      await appointmentImageStorageService.deleteObjects(paths);
      await supabaseAdmin
        .from("appointment_images")
        .update({ upload_status: "failed" })
        .eq("id", payload.image_id)
        .eq("user_id", context.stylistId);
      throw error;
    }

    const finalizedAt = toIso(now);
    const { data, error } = await supabaseAdmin
      .from("appointment_images")
      .update({
        original_filename: payload.original_filename ?? image.original_filename ?? null,
        content_type: payload.content_type,
        file_size_bytes: payload.file_size_bytes,
        thumbnail_size_bytes: payload.thumbnail_size_bytes ?? null,
        width: payload.width,
        height: payload.height,
        thumbnail_width: payload.thumbnail_width,
        thumbnail_height: payload.thumbnail_height,
        image_role: "reference",
        image_source: "client",
        captured_at: null,
        label: null,
        tags: [],
        caption: payload.caption ?? null,
        sort_order: image.sort_order ?? 0,
        uploaded_by_user_id: null,
        public_upload_token_id: context.tokenId,
        cache_version: 1,
        upload_status: "ready",
        finalized_at: finalizedAt
      })
      .eq("id", payload.image_id)
      .eq("user_id", context.stylistId)
      .eq("client_id", context.clientId)
      .eq("appointment_id", context.appointmentId)
      .select("*")
      .maybeSingle();

      handleSupabaseError(error, "Unable to finalize reference photo");
      return requireFound(data, "Reference photo not found");
    } catch (error) {
      await bookingErrorEventsService.recordBookingError({
        accountUserId: context.stylistId,
        clientId: context.clientId,
        appointmentId: context.appointmentId,
        step: "reference_photo_upload",
        errorCode: "reference_photo_upload_failed",
        severity: error instanceof ApiError && error.statusCode < 500 ? "warning" : "error",
        errorMessage: error instanceof Error ? error.message : String(error),
        metadata: {
          image_id: payload.image_id
        }
      });
      throw error;
    }
  }
};
