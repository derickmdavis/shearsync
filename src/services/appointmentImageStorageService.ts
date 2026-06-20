import { ApiError } from "../lib/errors";
import { supabaseAdmin } from "../lib/supabase";

export const APPOINTMENT_IMAGES_BUCKET = "appointment-images";
export const APPOINTMENT_IMAGE_ALLOWED_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const APPOINTMENT_IMAGE_MAX_DISPLAY_BYTES = 2 * 1024 * 1024;
export const APPOINTMENT_IMAGE_MAX_THUMBNAIL_BYTES = 300 * 1024;
export const APPOINTMENT_IMAGE_MAX_DISPLAY_LONG_EDGE = 1600;
export const APPOINTMENT_IMAGE_MAX_THUMBNAIL_LONG_EDGE = 400;

export type AppointmentImageContentType = (typeof APPOINTMENT_IMAGE_ALLOWED_CONTENT_TYPES)[number];

export type AppointmentImagePaths = {
  storagePath: string;
  thumbnailPath: string;
};

export type SignedUploadUrl = {
  signedUrl: string;
  token: string;
  path: string;
};

export type SignedAppointmentImageUploadUrls = {
  display: SignedUploadUrl;
  thumbnail: SignedUploadUrl;
};

export type VerifiedStorageObject = {
  exists: boolean;
  path: string;
  contentType: string | null;
  sizeBytes: number | null;
};

export type AppointmentImageStorageObject = {
  path: string;
  name: string;
  isFolder: boolean;
};

type GeneratePathsInput = {
  userId: string;
  clientId?: string | null;
  appointmentId: string;
  imageId: string;
  displayContentType: string;
  thumbnailContentType?: string | null;
};

type VerifyObjectOptions = {
  expectedContentType?: string;
  expectedSizeBytes?: number;
  maxSizeBytes?: number;
};

type StorageErrorShape = {
  message?: string;
  statusCode?: string | number;
  error?: string;
};

const EXTENSIONS_BY_CONTENT_TYPE: Record<AppointmentImageContentType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp"
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isAllowedContentType = (contentType: string): contentType is AppointmentImageContentType =>
  APPOINTMENT_IMAGE_ALLOWED_CONTENT_TYPES.includes(contentType as AppointmentImageContentType);

const requireAllowedContentType = (contentType: string): AppointmentImageContentType => {
  if (!isAllowedContentType(contentType)) {
    throw new ApiError(400, "Unsupported appointment image content type");
  }

  return contentType;
};

const requireSafeId = (name: string, value: string): string => {
  if (!UUID_PATTERN.test(value)) {
    throw new ApiError(400, `Invalid ${name}`);
  }

  return value;
};

const toStorageApiErrorDetails = (error: StorageErrorShape | null) =>
  error
    ? {
        message: error.message,
        statusCode: error.statusCode,
        error: error.error
      }
    : undefined;

const isMissingObjectError = (error: StorageErrorShape | null): boolean => {
  const statusCode = typeof error?.statusCode === "number" ? String(error.statusCode) : error?.statusCode;
  return statusCode === "404" || /not found/i.test(error?.message ?? "");
};

const logStorageFailure = (label: string, error: unknown): void => {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[APPOINTMENT_IMAGE_STORAGE] ${label}`, { message });
};

const getObjectContentType = (data: Record<string, unknown>): string | null => {
  const metadata = typeof data.metadata === "object" && data.metadata !== null
    ? (data.metadata as Record<string, unknown>)
    : {};
  const contentType = data.contentType ?? data.content_type ?? metadata.mimetype ?? metadata.contentType;

  return typeof contentType === "string" ? contentType : null;
};

const getObjectSize = (data: Record<string, unknown>): number | null => {
  const metadata = typeof data.metadata === "object" && data.metadata !== null
    ? (data.metadata as Record<string, unknown>)
    : {};
  const size = data.size ?? metadata.size ?? metadata.contentLength;

  return typeof size === "number" && Number.isFinite(size) ? size : null;
};

const assertObjectMatches = (object: VerifiedStorageObject, options: VerifyObjectOptions): void => {
  if (!object.exists) {
    return;
  }

  if (options.expectedContentType && object.contentType !== options.expectedContentType) {
    throw new ApiError(400, "Appointment image object content type does not match expected metadata");
  }

  if (options.expectedSizeBytes !== undefined && object.sizeBytes !== options.expectedSizeBytes) {
    throw new ApiError(400, "Appointment image object size does not match expected metadata");
  }

  if (options.maxSizeBytes !== undefined && object.sizeBytes !== null && object.sizeBytes > options.maxSizeBytes) {
    throw new ApiError(400, "Appointment image object exceeds maximum size");
  }
};

export const appointmentImageStorageService = {
  bucket: APPOINTMENT_IMAGES_BUCKET,

  getExtensionForContentType(contentType: string): string {
    return EXTENSIONS_BY_CONTENT_TYPE[requireAllowedContentType(contentType)];
  },

  generatePaths(input: GeneratePathsInput): AppointmentImagePaths {
    const userId = requireSafeId("user ID", input.userId);
    const appointmentId = requireSafeId("appointment ID", input.appointmentId);
    const imageId = requireSafeId("image ID", input.imageId);
    const displayExtension = this.getExtensionForContentType(input.displayContentType);
    const thumbnailExtension = this.getExtensionForContentType(input.thumbnailContentType ?? input.displayContentType);
    const basePath = input.clientId
      ? `users/${userId}/clients/${requireSafeId("client ID", input.clientId)}/appointments/${appointmentId}`
      : `users/${userId}/appointments/${appointmentId}`;

    return {
      storagePath: `${basePath}/${imageId}.${displayExtension}`,
      thumbnailPath: `${basePath}/${imageId}_thumb.${thumbnailExtension}`
    };
  },

  assertPathMatches(input: GeneratePathsInput & AppointmentImagePaths): void {
    const expected = this.generatePaths(input);

    if (input.storagePath !== expected.storagePath || input.thumbnailPath !== expected.thumbnailPath) {
      throw new ApiError(400, "Appointment image storage path does not match server-generated path");
    }
  },

  async createSignedUploadUrls(paths: AppointmentImagePaths): Promise<SignedAppointmentImageUploadUrls> {
    const bucket = supabaseAdmin.storage.from(APPOINTMENT_IMAGES_BUCKET);
    const [displayResult, thumbnailResult] = await Promise.all([
      bucket.createSignedUploadUrl(paths.storagePath),
      bucket.createSignedUploadUrl(paths.thumbnailPath)
    ]);

    if (displayResult.error) {
      logStorageFailure("signed display upload URL failed", displayResult.error);
      throw new ApiError(500, "Unable to create appointment image upload URL", toStorageApiErrorDetails(displayResult.error));
    }

    if (thumbnailResult.error) {
      logStorageFailure("signed thumbnail upload URL failed", thumbnailResult.error);
      throw new ApiError(
        500,
        "Unable to create appointment image thumbnail upload URL",
        toStorageApiErrorDetails(thumbnailResult.error)
      );
    }

    return {
      display: displayResult.data,
      thumbnail: thumbnailResult.data
    };
  },

  async createSignedReadUrl(path: string, expiresInSeconds = 300): Promise<string> {
    const { data, error } = await supabaseAdmin
      .storage
      .from(APPOINTMENT_IMAGES_BUCKET)
      .createSignedUrl(path, expiresInSeconds);

    if (error) {
      logStorageFailure("signed read URL failed", error);
      throw new ApiError(500, "Unable to create appointment image read URL", toStorageApiErrorDetails(error));
    }

    return data.signedUrl;
  },

  async verifyObject(path: string, options: VerifyObjectOptions = {}): Promise<VerifiedStorageObject> {
    const { data, error } = await supabaseAdmin.storage.from(APPOINTMENT_IMAGES_BUCKET).info(path);

    if (error) {
      if (isMissingObjectError(error)) {
        return {
          exists: false,
          path,
          contentType: null,
          sizeBytes: null
        };
      }

      throw new ApiError(500, "Unable to verify appointment image object", toStorageApiErrorDetails(error));
    }

    const object = {
      exists: true,
      path,
      contentType: getObjectContentType(data as Record<string, unknown>),
      sizeBytes: getObjectSize(data as Record<string, unknown>)
    };

    assertObjectMatches(object, options);
    return object;
  },

  async verifyObjects(paths: AppointmentImagePaths, options: {
    display?: VerifyObjectOptions;
    thumbnail?: VerifyObjectOptions;
  } = {}): Promise<{ display: VerifiedStorageObject; thumbnail: VerifiedStorageObject }> {
    const [display, thumbnail] = await Promise.all([
      this.verifyObject(paths.storagePath, options.display),
      this.verifyObject(paths.thumbnailPath, options.thumbnail)
    ]);

    return { display, thumbnail };
  },

  async deleteObjects(paths: Partial<AppointmentImagePaths>): Promise<string[]> {
    const pathsToDelete = [paths.storagePath, paths.thumbnailPath].filter((path): path is string => Boolean(path));

    if (pathsToDelete.length === 0) {
      return [];
    }

    const { error } = await supabaseAdmin.storage.from(APPOINTMENT_IMAGES_BUCKET).remove(pathsToDelete);

    if (error && !isMissingObjectError(error)) {
      throw new ApiError(500, "Unable to delete appointment image objects", toStorageApiErrorDetails(error));
    }

    return pathsToDelete;
  },

  async deleteObjectsSafely(paths: Partial<AppointmentImagePaths>, label = "cleanup"): Promise<{
    deletedPaths: string[];
    failedPaths: string[];
    error?: string;
  }> {
    try {
      const deletedPaths = await this.deleteObjects(paths);
      return {
        deletedPaths,
        failedPaths: []
      };
    } catch (error) {
      logStorageFailure(`${label} delete failed`, error);
      return {
        deletedPaths: [],
        failedPaths: [paths.storagePath, paths.thumbnailPath].filter((path): path is string => Boolean(path)),
        error: error instanceof Error ? error.message : String(error)
      };
    }
  },

  async listObjects(prefix = "", options: { limit?: number; offset?: number } = {}): Promise<AppointmentImageStorageObject[]> {
    const { data, error } = await supabaseAdmin
      .storage
      .from(APPOINTMENT_IMAGES_BUCKET)
      .list(prefix, {
        limit: options.limit ?? 100,
        offset: options.offset ?? 0,
        sortBy: { column: "name", order: "asc" }
      });

    if (error) {
      throw new ApiError(500, "Unable to list appointment image Storage objects", toStorageApiErrorDetails(error));
    }

    return (data ?? []).map((item) => {
      const record = item as unknown as Record<string, unknown>;
      const name = String(record.name ?? "");
      const normalizedPrefix = prefix.replace(/\/$/, "");
      const path = normalizedPrefix ? `${normalizedPrefix}/${name}` : name;

      return {
        path,
        name,
        isFolder: record.id === null || record.id === undefined && !record.metadata
      };
    });
  }
};
