import { supabaseAdmin } from "../lib/supabase";
import {
  AppointmentImageStorageObject,
  appointmentImageStorageService
} from "./appointmentImageStorageService";
import type { Row } from "./db";
import { handleSupabaseError } from "./db";

const DEFAULT_CLEANUP_LIMIT = 100;
const DEFAULT_ORPHAN_SCAN_LIMIT = 500;
const STORAGE_LIST_PAGE_SIZE = 100;

export type ExpiredPendingUploadCleanupResult = {
  scanned: number;
  expired: number;
  storageDeleted: number;
  storageDeleteFailed: number;
  imageIds: string[];
  failedImageIds: string[];
};

export type OrphanStorageCleanupResult = {
  scanned: number;
  orphaned: number;
  deleted: number;
  failed: number;
  dryRun: boolean;
  orphanPaths: string[];
  failedPaths: string[];
};

type CleanupOptions = {
  limit?: number;
};

type OrphanCleanupOptions = CleanupOptions & {
  dryRun?: boolean;
  prefix?: string;
};

const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

const getImagePaths = (row: Row): { storagePath?: string; thumbnailPath?: string } => ({
  storagePath: isString(row.storage_path) ? row.storage_path : undefined,
  thumbnailPath: isString(row.thumbnail_path) ? row.thumbnail_path : undefined
});

const chunk = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
};

const scanStorageObjects = async (
  prefix: string,
  maxObjects: number,
  collected: AppointmentImageStorageObject[] = []
): Promise<AppointmentImageStorageObject[]> => {
  let offset = 0;

  while (collected.length < maxObjects) {
    const page = await appointmentImageStorageService.listObjects(prefix, {
      limit: Math.min(STORAGE_LIST_PAGE_SIZE, maxObjects - collected.length),
      offset
    });

    if (page.length === 0) {
      break;
    }

    for (const object of page) {
      if (object.isFolder) {
        await scanStorageObjects(object.path, maxObjects, collected);
      } else {
        collected.push(object);
      }

      if (collected.length >= maxObjects) {
        break;
      }
    }

    if (page.length < STORAGE_LIST_PAGE_SIZE) {
      break;
    }

    offset += page.length;
  }

  return collected;
};

const loadKnownStoragePaths = async (paths: string[]): Promise<Set<string>> => {
  const knownPaths = new Set<string>();

  for (const pathChunk of chunk(paths, 50)) {
    const [displayResult, thumbnailResult] = await Promise.all([
      supabaseAdmin
        .from("appointment_images")
        .select("storage_path")
        .in("storage_path", pathChunk),
      supabaseAdmin
        .from("appointment_images")
        .select("thumbnail_path")
        .in("thumbnail_path", pathChunk)
    ]);

    handleSupabaseError(displayResult.error, "Unable to match appointment image Storage paths");
    handleSupabaseError(thumbnailResult.error, "Unable to match appointment image thumbnail Storage paths");

    for (const row of displayResult.data ?? []) {
      if (isString(row.storage_path)) {
        knownPaths.add(row.storage_path);
      }
    }

    for (const row of thumbnailResult.data ?? []) {
      if (isString(row.thumbnail_path)) {
        knownPaths.add(row.thumbnail_path);
      }
    }
  }

  return knownPaths;
};

export const appointmentImageCleanupService = {
  async cleanupExpiredPendingUploads(now = new Date(), options: CleanupOptions = {}): Promise<ExpiredPendingUploadCleanupResult> {
    const limit = options.limit ?? DEFAULT_CLEANUP_LIMIT;
    const { data, error } = await supabaseAdmin
      .from("appointment_images")
      .select("id, storage_path, thumbnail_path")
      .eq("upload_status", "pending")
      .lte("upload_expires_at", now.toISOString())
      .order("upload_expires_at", { ascending: true })
      .limit(limit);

    handleSupabaseError(error, "Unable to load expired pending appointment images");

    const result: ExpiredPendingUploadCleanupResult = {
      scanned: data?.length ?? 0,
      expired: 0,
      storageDeleted: 0,
      storageDeleteFailed: 0,
      imageIds: [],
      failedImageIds: []
    };

    for (const image of data ?? []) {
      const cleanup = await appointmentImageStorageService.deleteObjectsSafely(
        getImagePaths(image),
        "expired pending upload"
      );

      result.storageDeleted += cleanup.deletedPaths.length;
      result.storageDeleteFailed += cleanup.failedPaths.length;

      if (cleanup.failedPaths.length > 0) {
        result.failedImageIds.push(String(image.id));
        continue;
      }

      const { data: updated, error: updateError } = await supabaseAdmin
        .from("appointment_images")
        .update({ upload_status: "expired" })
        .eq("id", image.id)
        .eq("upload_status", "pending")
        .select("id")
        .maybeSingle();

      handleSupabaseError(updateError, "Unable to mark appointment image upload expired");

      if (updated) {
        result.expired += 1;
        result.imageIds.push(String(image.id));
      }
    }

    return result;
  },

  async cleanupOrphanedStorageObjects(options: OrphanCleanupOptions = {}): Promise<OrphanStorageCleanupResult> {
    const limit = options.limit ?? DEFAULT_ORPHAN_SCAN_LIMIT;
    const dryRun = options.dryRun ?? true;
    const objects = await scanStorageObjects(options.prefix ?? "users", limit);
    const paths = objects.map((object) => object.path);
    const knownPaths = await loadKnownStoragePaths(paths);
    const orphanPaths = paths.filter((path) => !knownPaths.has(path));
    const result: OrphanStorageCleanupResult = {
      scanned: paths.length,
      orphaned: orphanPaths.length,
      deleted: 0,
      failed: 0,
      dryRun,
      orphanPaths,
      failedPaths: []
    };

    if (dryRun) {
      return result;
    }

    for (const orphanPath of orphanPaths) {
      const cleanup = await appointmentImageStorageService.deleteObjectsSafely(
        { storagePath: orphanPath },
        "orphan object"
      );

      if (cleanup.failedPaths.length > 0) {
        result.failed += cleanup.failedPaths.length;
        result.failedPaths.push(...cleanup.failedPaths);
      } else {
        result.deleted += cleanup.deletedPaths.length;
      }
    }

    return result;
  }
};
