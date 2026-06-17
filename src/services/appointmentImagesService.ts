import { randomUUID } from "crypto";
import { ApiError, requireFound } from "../lib/errors";
import { supabaseAdmin } from "../lib/supabase";
import {
  APPOINTMENT_IMAGES_BUCKET,
  AppointmentImagePaths,
  appointmentImageStorageService
} from "./appointmentImageStorageService";
import { appointmentsService } from "./appointmentsService";
import type { Row, RowList } from "./db";
import { handleSupabaseError } from "./db";

const MAX_APPOINTMENT_IMAGES = 10;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const UPLOAD_INTENT_TTL_MINUTES = 15;
const SIGNED_THUMBNAIL_URL_TTL_SECONDS = 300;
const SIGNED_DISPLAY_URL_TTL_SECONDS = 300;
const DEFAULT_THUMBNAIL_PREFETCH_WINDOW_DAYS = 7;

type ThumbnailPrefetchQuery = {
  start_at?: string;
  end_at?: string;
  appointment_limit?: number;
  image_limit_per_appointment?: number;
  total_image_limit?: number;
};

type ThumbnailPrefetchAppointment = Row & {
  images: RowList;
};

type ThumbnailPrefetchResult = {
  appointments: ThumbnailPrefetchAppointment[];
  meta: {
    start_at: string;
    end_at: string;
    appointment_limit: number;
    image_limit_per_appointment: number;
    total_image_limit: number;
    appointment_count: number;
    image_count: number;
  };
};

type UploadIntentPayload = {
  original_filename?: string | null;
  content_type: string;
  input_size_bytes: number;
  display_content_type: string;
  thumbnail_content_type: string;
};

type FinalizePayload = {
  image_id: string;
  storage_path: string;
  thumbnail_path: string;
  original_filename?: string | null;
  content_type: string;
  file_size_bytes: number;
  thumbnail_size_bytes?: number | null;
  width?: number | null;
  height?: number | null;
  image_role: string;
  captured_at?: string | null;
  label?: string | null;
  tags?: string[];
  caption?: string | null;
  sort_order?: number;
};

type UpdatePayload = {
  caption?: string | null;
  image_role?: string;
  sort_order?: number;
  label?: string | null;
  tags?: string[];
};

const toIso = (date: Date): string => date.toISOString();

const addDays = (date: Date, days: number): Date => new Date(date.getTime() + days * 24 * 60 * 60 * 1000);

const getClientId = (appointment: Row): string | null =>
  typeof appointment.client_id === "string" ? appointment.client_id : null;

const isActiveImageForLimit = (image: Row, nowIso: string): boolean => {
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

const normalizeImage = async (image: Row, includeThumbnailUrl = false): Promise<Row> => {
  if (!includeThumbnailUrl || typeof image.thumbnail_path !== "string") {
    return image;
  }

  return {
    ...image,
    thumbnail_url: await appointmentImageStorageService.createSignedReadUrl(
      image.thumbnail_path,
      SIGNED_THUMBNAIL_URL_TTL_SECONDS
    )
  };
};

export const appointmentImagesService = {
  async expirePendingUploads(userId: string, appointmentId: string, now = new Date()): Promise<void> {
    const { error } = await supabaseAdmin
      .from("appointment_images")
      .update({ upload_status: "expired" })
      .eq("user_id", userId)
      .eq("appointment_id", appointmentId)
      .eq("upload_status", "pending")
      .lte("upload_expires_at", toIso(now));

    handleSupabaseError(error, "Unable to expire pending appointment images");
  },

  async assertImageLimitAvailable(userId: string, appointmentId: string, now = new Date()): Promise<void> {
    const nowIso = toIso(now);
    const { data, error } = await supabaseAdmin
      .from("appointment_images")
      .select("id, upload_status, upload_expires_at")
      .eq("user_id", userId)
      .eq("appointment_id", appointmentId)
      .in("upload_status", ["pending", "ready"]);

    handleSupabaseError(error, "Unable to validate appointment image limit");

    if ((data ?? []).filter((image) => isActiveImageForLimit(image, nowIso)).length >= MAX_APPOINTMENT_IMAGES) {
      throw new ApiError(409, "Appointment image limit reached");
    }
  },

  async list(userId: string, appointmentId: string): Promise<RowList> {
    await appointmentsService.getOwned(userId, appointmentId);

    const { data, error } = await supabaseAdmin
      .from("appointment_images")
      .select("*")
      .eq("user_id", userId)
      .eq("appointment_id", appointmentId)
      .eq("upload_status", "ready")
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });

    handleSupabaseError(error, "Unable to load appointment images");
    return Promise.all((data ?? []).map((image) => normalizeImage(image, true)));
  },

  async prefetchThumbnails(
    userId: string,
    query: ThumbnailPrefetchQuery = {},
    now = new Date()
  ): Promise<ThumbnailPrefetchResult> {
    const startAt = query.start_at ?? toIso(now);
    const endAt = query.end_at ?? toIso(addDays(new Date(startAt), DEFAULT_THUMBNAIL_PREFETCH_WINDOW_DAYS));
    const appointmentLimit = query.appointment_limit ?? 25;
    const imageLimitPerAppointment = query.image_limit_per_appointment ?? 2;
    const totalImageLimit = query.total_image_limit ?? 50;

    const { data: appointments, error: appointmentsError } = await supabaseAdmin
      .from("appointments")
      .select("id, client_id, appointment_date, service_name, status")
      .eq("user_id", userId)
      .in("status", ["pending", "scheduled"])
      .gte("appointment_date", startAt)
      .lt("appointment_date", endAt)
      .order("appointment_date", { ascending: true })
      .limit(appointmentLimit);

    handleSupabaseError(appointmentsError, "Unable to load appointments for image thumbnail prefetch");
    const boundedAppointments = (appointments ?? []) as RowList;
    const appointmentIds = boundedAppointments
      .map((appointment) => appointment.id)
      .filter((id): id is string => typeof id === "string");

    if (appointmentIds.length === 0) {
      return {
        appointments: [],
        meta: {
          start_at: startAt,
          end_at: endAt,
          appointment_limit: appointmentLimit,
          image_limit_per_appointment: imageLimitPerAppointment,
          total_image_limit: totalImageLimit,
          appointment_count: 0,
          image_count: 0
        }
      };
    }

    const imageQueryLimit = Math.min(appointmentIds.length * MAX_APPOINTMENT_IMAGES, 1000);
    const { data: images, error: imagesError } = await supabaseAdmin
      .from("appointment_images")
      .select("*")
      .eq("user_id", userId)
      .in("appointment_id", appointmentIds)
      .eq("upload_status", "ready")
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true })
      .limit(imageQueryLimit);

    handleSupabaseError(imagesError, "Unable to load appointment image thumbnails for prefetch");

    const imagesByAppointment = new Map<string, RowList>();
    let imageCount = 0;

    for (const image of images ?? []) {
      if (imageCount >= totalImageLimit) {
        break;
      }

      const appointmentId = typeof image.appointment_id === "string" ? image.appointment_id : null;
      if (!appointmentId) {
        continue;
      }

      const appointmentImages = imagesByAppointment.get(appointmentId) ?? [];
      if (appointmentImages.length >= imageLimitPerAppointment) {
        continue;
      }

      appointmentImages.push(await normalizeImage(image, true));
      imagesByAppointment.set(appointmentId, appointmentImages);
      imageCount += 1;
    }

    const prefetchAppointments = boundedAppointments
      .map((appointment) => ({
        ...appointment,
        images: imagesByAppointment.get(appointment.id as string) ?? []
      }))
      .filter((appointment) => appointment.images.length > 0);

    return {
      appointments: prefetchAppointments,
      meta: {
        start_at: startAt,
        end_at: endAt,
        appointment_limit: appointmentLimit,
        image_limit_per_appointment: imageLimitPerAppointment,
        total_image_limit: totalImageLimit,
        appointment_count: prefetchAppointments.length,
        image_count: imageCount
      }
    };
  },

  async createUploadIntent(userId: string, appointmentId: string, payload: UploadIntentPayload, now = new Date()): Promise<Row> {
    if (payload.input_size_bytes > MAX_IMAGE_BYTES) {
      throw new ApiError(400, "Appointment image exceeds maximum size");
    }

    const appointment = await appointmentsService.getOwned(userId, appointmentId);
    await this.expirePendingUploads(userId, appointmentId, now);
    await this.assertImageLimitAvailable(userId, appointmentId, now);

    const imageId = randomUUID();
    const uploadExpiresAt = new Date(now.getTime() + UPLOAD_INTENT_TTL_MINUTES * 60 * 1000);
    const paths = appointmentImageStorageService.generatePaths({
      userId,
      clientId: getClientId(appointment),
      appointmentId,
      imageId,
      displayContentType: payload.display_content_type,
      thumbnailContentType: payload.thumbnail_content_type
    });
    const uploadUrls = await appointmentImageStorageService.createSignedUploadUrls(paths);

    const { data, error } = await supabaseAdmin
      .from("appointment_images")
      .insert({
        id: imageId,
        user_id: userId,
        client_id: getClientId(appointment),
        appointment_id: appointmentId,
        bucket: APPOINTMENT_IMAGES_BUCKET,
        storage_path: paths.storagePath,
        thumbnail_path: paths.thumbnailPath,
        original_filename: payload.original_filename ?? null,
        content_type: payload.display_content_type,
        file_size_bytes: payload.input_size_bytes,
        image_role: "general",
        image_source: "stylist",
        uploaded_by_user_id: userId,
        cache_version: 1,
        upload_status: "pending",
        upload_expires_at: toIso(uploadExpiresAt),
        finalized_at: null
      })
      .select("*")
      .single();

    handleSupabaseError(error, "Unable to create appointment image upload intent");

    return {
      ...requireFound(data, "Appointment image upload intent was not created"),
      signed_upload_urls: uploadUrls,
      max_constraints: {
        max_images: MAX_APPOINTMENT_IMAGES,
        max_file_size_bytes: MAX_IMAGE_BYTES,
        upload_expires_in_minutes: UPLOAD_INTENT_TTL_MINUTES
      }
    };
  },

  async finalize(userId: string, appointmentId: string, payload: FinalizePayload, now = new Date()): Promise<Row> {
    const appointment = await appointmentsService.getOwned(userId, appointmentId);
    const { data: pendingImage, error: pendingError } = await supabaseAdmin
      .from("appointment_images")
      .select("*")
      .eq("id", payload.image_id)
      .eq("user_id", userId)
      .eq("appointment_id", appointmentId)
      .eq("upload_status", "pending")
      .maybeSingle();

    handleSupabaseError(pendingError, "Unable to load pending appointment image");
    const image = requireFound(pendingImage, "Pending appointment image not found");
    const paths: AppointmentImagePaths = {
      storagePath: payload.storage_path,
      thumbnailPath: payload.thumbnail_path
    };

    if (typeof image.upload_expires_at === "string" && image.upload_expires_at <= toIso(now)) {
      const { error } = await supabaseAdmin
        .from("appointment_images")
        .update({ upload_status: "expired" })
        .eq("id", payload.image_id)
        .eq("user_id", userId);

      handleSupabaseError(error, "Unable to expire appointment image upload intent");
      throw new ApiError(410, "Appointment image upload intent expired");
    }

    if (payload.storage_path !== image.storage_path || payload.thumbnail_path !== image.thumbnail_path) {
      throw new ApiError(400, "Appointment image storage path does not match upload intent");
    }

    appointmentImageStorageService.assertPathMatches({
      userId,
      clientId: getClientId(appointment),
      appointmentId,
      imageId: payload.image_id,
      displayContentType: payload.content_type,
      thumbnailContentType: inferContentTypeFromPath(payload.thumbnail_path) ?? payload.content_type,
      storagePath: payload.storage_path,
      thumbnailPath: payload.thumbnail_path
    });

    try {
      const verified = await appointmentImageStorageService.verifyObjects(paths, {
        display: {
          expectedContentType: payload.content_type,
          expectedSizeBytes: payload.file_size_bytes,
          maxSizeBytes: MAX_IMAGE_BYTES
        },
        thumbnail: {
          expectedContentType: inferContentTypeFromPath(payload.thumbnail_path) ?? undefined,
          expectedSizeBytes: payload.thumbnail_size_bytes ?? undefined,
          maxSizeBytes: MAX_IMAGE_BYTES
        }
      });

      if (!verified.display.exists || !verified.thumbnail.exists) {
        throw new ApiError(400, "Appointment image upload is incomplete");
      }
    } catch (error) {
      await appointmentImageStorageService.deleteObjects(paths);
      await supabaseAdmin
        .from("appointment_images")
        .update({ upload_status: "failed" })
        .eq("id", payload.image_id)
        .eq("user_id", userId);
      throw error;
    }

    const finalizedAt = toIso(now);
    const { data, error } = await supabaseAdmin
      .from("appointment_images")
      .update({
        client_id: getClientId(appointment),
        original_filename: payload.original_filename ?? image.original_filename ?? null,
        content_type: payload.content_type,
        file_size_bytes: payload.file_size_bytes,
        thumbnail_size_bytes: payload.thumbnail_size_bytes ?? null,
        width: payload.width ?? null,
        height: payload.height ?? null,
        image_role: payload.image_role,
        image_source: "stylist",
        captured_at: payload.captured_at ?? null,
        label: payload.label ?? null,
        tags: payload.tags ?? [],
        caption: payload.caption ?? null,
        sort_order: payload.sort_order ?? image.sort_order ?? 0,
        uploaded_by_user_id: userId,
        cache_version: 1,
        upload_status: "ready",
        finalized_at: finalizedAt
      })
      .eq("id", payload.image_id)
      .eq("user_id", userId)
      .eq("appointment_id", appointmentId)
      .select("*")
      .maybeSingle();

    handleSupabaseError(error, "Unable to finalize appointment image");
    return normalizeImage(requireFound(data, "Appointment image not found"), true);
  },

  async getDisplayUrl(userId: string, appointmentId: string, imageId: string): Promise<Row> {
    await appointmentsService.getOwned(userId, appointmentId);
    const image = await this.getReadyImage(userId, appointmentId, imageId);
    const displayUrl = await appointmentImageStorageService.createSignedReadUrl(
      image.storage_path as string,
      SIGNED_DISPLAY_URL_TTL_SECONDS
    );

    return {
      image_id: image.id,
      display_url: displayUrl,
      updated_at: image.updated_at,
      cache_version: image.cache_version,
      content_type: image.content_type,
      width: image.width ?? null,
      height: image.height ?? null
    };
  },

  async update(userId: string, appointmentId: string, imageId: string, payload: UpdatePayload): Promise<Row> {
    await appointmentsService.getOwned(userId, appointmentId);

    const { data, error } = await supabaseAdmin
      .from("appointment_images")
      .update(payload)
      .eq("id", imageId)
      .eq("user_id", userId)
      .eq("appointment_id", appointmentId)
      .eq("upload_status", "ready")
      .select("*")
      .maybeSingle();

    handleSupabaseError(error, "Unable to update appointment image");
    return normalizeImage(requireFound(data, "Appointment image not found"), true);
  },

  async remove(userId: string, appointmentId: string, imageId: string): Promise<void> {
    await appointmentsService.getOwned(userId, appointmentId);
    const image = await this.getImage(userId, appointmentId, imageId);
    await appointmentImageStorageService.deleteObjects({
      storagePath: image.storage_path as string | undefined,
      thumbnailPath: image.thumbnail_path as string | undefined
    });

    const { error } = await supabaseAdmin
      .from("appointment_images")
      .delete()
      .eq("id", imageId)
      .eq("user_id", userId)
      .eq("appointment_id", appointmentId);

    handleSupabaseError(error, "Unable to delete appointment image");
  },

  async reorder(userId: string, appointmentId: string, imageIds: string[]): Promise<RowList> {
    await appointmentsService.getOwned(userId, appointmentId);
    const { data: existingImages, error: existingError } = await supabaseAdmin
      .from("appointment_images")
      .select("id")
      .eq("user_id", userId)
      .eq("appointment_id", appointmentId)
      .eq("upload_status", "ready")
      .in("id", imageIds);

    handleSupabaseError(existingError, "Unable to load appointment images for reorder");

    if ((existingImages ?? []).length !== imageIds.length) {
      throw new ApiError(400, "All reordered images must belong to the appointment");
    }

    for (const [sortOrder, id] of imageIds.entries()) {
      const { error } = await supabaseAdmin
        .from("appointment_images")
        .update({ sort_order: sortOrder })
        .eq("id", id)
        .eq("user_id", userId)
        .eq("appointment_id", appointmentId);

      handleSupabaseError(error, "Unable to reorder appointment images");
    }

    return this.list(userId, appointmentId);
  },

  async getImage(userId: string, appointmentId: string, imageId: string): Promise<Row> {
    const { data, error } = await supabaseAdmin
      .from("appointment_images")
      .select("*")
      .eq("id", imageId)
      .eq("user_id", userId)
      .eq("appointment_id", appointmentId)
      .maybeSingle();

    handleSupabaseError(error, "Unable to load appointment image");
    return requireFound(data, "Appointment image not found");
  },

  async getReadyImage(userId: string, appointmentId: string, imageId: string): Promise<Row> {
    const { data, error } = await supabaseAdmin
      .from("appointment_images")
      .select("*")
      .eq("id", imageId)
      .eq("user_id", userId)
      .eq("appointment_id", appointmentId)
      .eq("upload_status", "ready")
      .maybeSingle();

    handleSupabaseError(error, "Unable to load appointment image");
    return requireFound(data, "Appointment image not found");
  }
};
