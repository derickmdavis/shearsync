import { randomUUID } from "crypto";
import { ApiError, requireFound } from "../lib/errors";
import { logger } from "../lib/logger";
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
import { appointmentsService } from "./appointmentsService";
import { clientsService } from "./clientsService";
import type { Row, RowList } from "./db";
import { handleSupabaseError } from "./db";
import { entitlementsService } from "./entitlementsService";

type VisualHistoryErrorContext = {
  userId: string;
  clientId: string;
  stage: string;
};

const logClientVisualHistoryError = (error: unknown, context: VisualHistoryErrorContext) => {
  if (!error) {
    return;
  }

  const supabaseError = error as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
    hint?: unknown;
  };

  logger.error("client_visual_history_error", {
    ...context,
    errorCode: supabaseError.code,
    errorMessage: supabaseError.message,
    errorDetails: supabaseError.details,
    errorHint: supabaseError.hint
  });
};

const MAX_APPOINTMENT_IMAGES = 10;
const UPLOAD_INTENT_TTL_MINUTES = 15;
const SIGNED_THUMBNAIL_URL_TTL_SECONDS = 300;
const SIGNED_DISPLAY_URL_TTL_SECONDS = 300;
const DEFAULT_THUMBNAIL_PREFETCH_WINDOW_DAYS = 7;
const APPOINTMENT_IMAGE_LIST_FIELDS = [
  "id",
  "user_id",
  "client_id",
  "appointment_id",
  "bucket",
  "thumbnail_path",
  "original_filename",
  "content_type",
  "file_size_bytes",
  "thumbnail_size_bytes",
  "width",
  "height",
  "thumbnail_width",
  "thumbnail_height",
  "image_role",
  "image_source",
  "captured_at",
  "label",
  "tags",
  "uploaded_by_user_id",
  "public_upload_token_id",
  "caption",
  "sort_order",
  "cache_version",
  "upload_status",
  "upload_expires_at",
  "finalized_at",
  "created_at",
  "updated_at"
].join(", ");
const APPOINTMENT_IMAGE_THUMBNAIL_FIELDS = [
  "id",
  "user_id",
  "client_id",
  "appointment_id",
  "bucket",
  "thumbnail_path",
  "content_type",
  "thumbnail_size_bytes",
  "thumbnail_width",
  "thumbnail_height",
  "image_role",
  "image_source",
  "label",
  "tags",
  "caption",
  "sort_order",
  "cache_version",
  "created_at",
  "updated_at"
].join(", ");
const CLIENT_VISUAL_HISTORY_FIELDS = [
  "id",
  "user_id",
  "client_id",
  "appointment_id",
  "bucket",
  "storage_path",
  "thumbnail_path",
  "original_filename",
  "content_type",
  "file_size_bytes",
  "thumbnail_size_bytes",
  "width",
  "height",
  "thumbnail_width",
  "thumbnail_height",
  "image_role",
  "image_source",
  "captured_at",
  "label",
  "tags",
  "uploaded_by_user_id",
  "public_upload_token_id",
  "caption",
  "sort_order",
  "cache_version",
  "upload_status",
  "finalized_at",
  "created_at",
  "updated_at"
].join(", ");

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

type ClientVisualHistoryQuery = {
  limit?: number;
  include_display_urls?: boolean;
};

type ClientVisualHistoryResult = {
  data: RowList;
  photo_count: number;
  history_available: boolean;
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
  width: number;
  height: number;
  thumbnail_width: number;
  thumbnail_height: number;
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

const assertAppointmentPhotosAllowed = async (userId: string): Promise<void> => {
  await entitlementsService.assertFeatureAllowed(userId, "appointmentPhotos");
};

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

const omitStoragePaths = (image: Row): Row => {
  const { storage_path: _storagePath, thumbnail_path: _thumbnailPath, ...rest } = image;
  return rest;
};

const createOptionalSignedReadUrl = async (
  path: string,
  expiresInSeconds: number,
  context: Row = {}
): Promise<string | null> => {
  try {
    return await appointmentImageStorageService.createSignedReadUrl(path, expiresInSeconds);
  } catch (error) {
    if (error instanceof ApiError && error.statusCode >= 500) {
      logger.warn("appointment_image_signed_read_url_unavailable", {
        imageId: context.id,
        appointmentId: context.appointment_id,
        userId: context.user_id,
        statusCode: error.statusCode,
        message: error.message
      });
      return null;
    }

    throw error;
  }
};

const normalizeImage = async (
  image: Row,
  includeThumbnailUrl = false,
  exposeStoragePaths = true,
  tolerateThumbnailUrlFailure = false
): Promise<Row> => {
  const createThumbnailUrl = tolerateThumbnailUrlFailure
    ? createOptionalSignedReadUrl
    : appointmentImageStorageService.createSignedReadUrl.bind(appointmentImageStorageService);
  const normalized = includeThumbnailUrl && typeof image.thumbnail_path === "string"
    ? {
        ...image,
        thumbnail_url: await createThumbnailUrl(
          image.thumbnail_path,
          SIGNED_THUMBNAIL_URL_TTL_SECONDS,
          image
        )
      }
    : image;

  return exposeStoragePaths ? normalized : omitStoragePaths(normalized);
};

const normalizeImageForVisualHistory = async (
  image: Row,
  appointment: Row | undefined,
  includeDisplayUrl = false
): Promise<Row> => {
  const thumbnailUrl = typeof image.thumbnail_path === "string"
    ? await appointmentImageStorageService.createSignedReadUrl(image.thumbnail_path, SIGNED_THUMBNAIL_URL_TTL_SECONDS)
    : null;
  const displayUrl = includeDisplayUrl && typeof image.storage_path === "string"
    ? await appointmentImageStorageService.createSignedReadUrl(image.storage_path, SIGNED_DISPLAY_URL_TTL_SECONDS)
    : null;
  const serviceLabel = typeof appointment?.service_name === "string" && appointment.service_name.trim().length > 0
    ? appointment.service_name
    : null;
  const sourceLabel = image.image_source === "client" ? "Client upload" : "Stylist upload";

  return omitStoragePaths({
    ...image,
    thumbnail_url: thumbnailUrl,
    display_url: displayUrl,
    full_url: displayUrl,
    caption: typeof image.caption === "string" ? image.caption : null,
    source_label: sourceLabel,
    service_label: serviceLabel,
    appointment_id: typeof image.appointment_id === "string" ? image.appointment_id : null,
    appointment: appointment
      ? {
          appointment_id: appointment.id,
          appointment_date: appointment.appointment_date,
          service_name: appointment.service_name,
          status: appointment.status
        }
      : null
  });
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
    await assertAppointmentPhotosAllowed(userId);
    await appointmentsService.getOwned(userId, appointmentId);

    const { data, error } = await supabaseAdmin
      .from("appointment_images")
      .select(APPOINTMENT_IMAGE_LIST_FIELDS)
      .eq("user_id", userId)
      .eq("appointment_id", appointmentId)
      .eq("upload_status", "ready")
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });

    handleSupabaseError(error, "Unable to load appointment images");
    const images = (data ?? []) as unknown as RowList;
    return Promise.all(images.map((image) => normalizeImage(image, true, false, true)));
  },

  async prefetchThumbnails(
    userId: string,
    query: ThumbnailPrefetchQuery = {},
    now = new Date()
  ): Promise<ThumbnailPrefetchResult> {
    await assertAppointmentPhotosAllowed(userId);
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
      .select(APPOINTMENT_IMAGE_THUMBNAIL_FIELDS)
      .eq("user_id", userId)
      .in("appointment_id", appointmentIds)
      .eq("upload_status", "ready")
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true })
      .limit(imageQueryLimit);

    handleSupabaseError(imagesError, "Unable to load appointment image thumbnails for prefetch");
    const readyImages = (images ?? []) as unknown as RowList;

    const imagesByAppointment = new Map<string, RowList>();
    let imageCount = 0;

    for (const image of readyImages) {
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

      appointmentImages.push(await normalizeImage(image, true, false, true));
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

  async listClientVisualHistory(
    userId: string,
    clientId: string,
    query: ClientVisualHistoryQuery = {}
  ): Promise<ClientVisualHistoryResult> {
    await clientsService.assertOwned(userId, clientId);
    const [{ count, error: countError }, historyAllowed] = await Promise.all([
      supabaseAdmin
        .from("appointment_images")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("client_id", clientId)
        .eq("upload_status", "ready"),
      entitlementsService.isFeatureAllowed(userId, "appointmentPhotos")
    ]);

    logClientVisualHistoryError(countError, {
      userId,
      clientId,
      stage: "count"
    });
    handleSupabaseError(countError, "Unable to load client visual history count");
    const photoCount = count ?? 0;

    if (!historyAllowed) {
      return {
        data: [],
        photo_count: photoCount,
        history_available: false
      };
    }

    const limit = query.limit ?? 50;
    const includeDisplayUrls = query.include_display_urls ?? false;

    const { data: images, error: imagesError } = await supabaseAdmin
      .from("appointment_images")
      .select(CLIENT_VISUAL_HISTORY_FIELDS)
      .eq("user_id", userId)
      .eq("client_id", clientId)
      .eq("upload_status", "ready")
      .order("created_at", { ascending: false })
      .limit(limit);

    logClientVisualHistoryError(imagesError, {
      userId,
      clientId,
      stage: "images"
    });
    handleSupabaseError(imagesError, "Unable to load client visual history");
    const visualHistoryImages = (images ?? []) as unknown as RowList;

    const appointmentIds = [
      ...new Set(
        visualHistoryImages
          .map((image) => image.appointment_id)
          .filter((id): id is string => typeof id === "string")
      )
    ];

    const appointmentsById = new Map<string, Row>();
    if (appointmentIds.length > 0) {
      const { data: appointments, error: appointmentsError } = await supabaseAdmin
        .from("appointments")
        .select("id, appointment_date, service_name, status")
        .eq("user_id", userId)
        .eq("client_id", clientId)
        .in("id", appointmentIds);

      logClientVisualHistoryError(appointmentsError, {
        userId,
        clientId,
        stage: "appointment_context"
      });
      handleSupabaseError(appointmentsError, "Unable to load visual history appointment context");

      for (const appointment of appointments ?? []) {
        if (typeof appointment.id === "string") {
          appointmentsById.set(appointment.id, appointment);
        }
      }
    }

    const normalizedImages = await Promise.all(
      visualHistoryImages.map((image) =>
        normalizeImageForVisualHistory(
          image,
          typeof image.appointment_id === "string" ? appointmentsById.get(image.appointment_id) : undefined,
          includeDisplayUrls
        )
      )
    );

    return {
      data: normalizedImages,
      photo_count: photoCount,
      history_available: true
    };
  },

  async getClientAvatarUrl(userId: string, clientId: string, imageId: string | null | undefined): Promise<string | null> {
    if (!imageId) {
      return null;
    }

    const { data, error } = await supabaseAdmin
      .from("appointment_images")
      .select("id, user_id, client_id, thumbnail_path, upload_status")
      .eq("id", imageId)
      .eq("user_id", userId)
      .eq("client_id", clientId)
      .eq("upload_status", "ready")
      .maybeSingle();

    handleSupabaseError(error, "Unable to load client avatar image");
    const avatarImage = data as Row | null;
    if (!avatarImage || typeof avatarImage.thumbnail_path !== "string") {
      return null;
    }

    return createOptionalSignedReadUrl(avatarImage.thumbnail_path, SIGNED_THUMBNAIL_URL_TTL_SECONDS, avatarImage);
  },

  async createUploadIntent(userId: string, appointmentId: string, payload: UploadIntentPayload, now = new Date()): Promise<Row> {
    await assertAppointmentPhotosAllowed(userId);

    if (payload.content_type !== payload.display_content_type) {
      throw new ApiError(400, "Upload intent content_type must match display_content_type");
    }

    if (payload.input_size_bytes > APPOINTMENT_IMAGE_MAX_DISPLAY_BYTES) {
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
        max_file_size_bytes: APPOINTMENT_IMAGE_MAX_DISPLAY_BYTES,
        max_display_file_size_bytes: APPOINTMENT_IMAGE_MAX_DISPLAY_BYTES,
        max_thumbnail_file_size_bytes: APPOINTMENT_IMAGE_MAX_THUMBNAIL_BYTES,
        max_display_long_edge_px: APPOINTMENT_IMAGE_MAX_DISPLAY_LONG_EDGE,
        max_thumbnail_long_edge_px: APPOINTMENT_IMAGE_MAX_THUMBNAIL_LONG_EDGE,
        upload_expires_in_minutes: UPLOAD_INTENT_TTL_MINUTES
      }
    };
  },

  async finalize(userId: string, appointmentId: string, payload: FinalizePayload, now = new Date()): Promise<Row> {
    await assertAppointmentPhotosAllowed(userId);
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
      assertLongestEdgeWithinLimit(
        "Appointment image display",
        payload.width,
        payload.height,
        APPOINTMENT_IMAGE_MAX_DISPLAY_LONG_EDGE
      );
      assertLongestEdgeWithinLimit(
        "Appointment image thumbnail",
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
        width: payload.width,
        height: payload.height,
        thumbnail_width: payload.thumbnail_width,
        thumbnail_height: payload.thumbnail_height,
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
    await assertAppointmentPhotosAllowed(userId);
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
    await assertAppointmentPhotosAllowed(userId);
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
    await assertAppointmentPhotosAllowed(userId);
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
    await assertAppointmentPhotosAllowed(userId);
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
