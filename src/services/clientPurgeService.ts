import { supabaseAdmin } from "../lib/supabase";
import { appointmentImageStorageService } from "./appointmentImageStorageService";
import type { Row } from "./db";
import { handleSupabaseError } from "./db";

const DEFAULT_PURGE_LIMIT = 50;

export type ClientPurgeResult = {
  scanned: number;
  purged: number;
  skipped: number;
  storageDeleted: number;
  storageDeleteFailed: number;
  clientIds: string[];
};

type PurgeOptions = {
  limit?: number;
};

const isEligibleClientRow = (row: Row): row is Row & { id: string; user_id: string } =>
  typeof row.id === "string" && typeof row.user_id === "string" && typeof row.deleted_at === "string";

const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

const cleanupClientAppointmentImages = async (userId: string, clientId: string): Promise<{
  deleted: number;
  failed: number;
}> => {
  const { data: images, error } = await supabaseAdmin
    .from("appointment_images")
    .select("id, storage_path, thumbnail_path")
    .eq("user_id", userId)
    .eq("client_id", clientId);

  handleSupabaseError(error, "Unable to load client appointment images for purge");

  let deleted = 0;
  let failed = 0;

  for (const image of images ?? []) {
    const cleanup = await appointmentImageStorageService.deleteObjectsSafely(
      {
        storagePath: isString(image.storage_path) ? image.storage_path : undefined,
        thumbnailPath: isString(image.thumbnail_path) ? image.thumbnail_path : undefined
      },
      "deleted client purge"
    );

    deleted += cleanup.deletedPaths.length;
    failed += cleanup.failedPaths.length;
  }

  return { deleted, failed };
};

export const clientPurgeService = {
  async purgeExpiredDeletedClients(now = new Date(), options: PurgeOptions = {}): Promise<ClientPurgeResult> {
    const nowIso = now.toISOString();
    const limit = options.limit ?? DEFAULT_PURGE_LIMIT;
    const { data: candidates, error } = await supabaseAdmin
      .from("clients")
      .select("id, user_id, deleted_at, purge_after")
      .lte("purge_after", nowIso)
      .not("deleted_at", "is", null)
      .order("purge_after", { ascending: true })
      .limit(limit);

    handleSupabaseError(error, "Unable to load clients eligible for purge");

    const result: ClientPurgeResult = {
      scanned: candidates?.length ?? 0,
      purged: 0,
      skipped: 0,
      storageDeleted: 0,
      storageDeleteFailed: 0,
      clientIds: []
    };

    for (const candidate of candidates ?? []) {
      if (!isEligibleClientRow(candidate)) {
        result.skipped += 1;
        continue;
      }

      const imageCleanup = await cleanupClientAppointmentImages(candidate.user_id, candidate.id);
      result.storageDeleted += imageCleanup.deleted;
      result.storageDeleteFailed += imageCleanup.failed;

      if (imageCleanup.failed > 0) {
        result.skipped += 1;
        continue;
      }

      const { data: deletedClient, error: deleteError } = await supabaseAdmin
        .from("clients")
        .delete()
        .eq("id", candidate.id)
        .eq("user_id", candidate.user_id)
        .lte("purge_after", nowIso)
        .not("deleted_at", "is", null)
        .select("id")
        .maybeSingle();

      handleSupabaseError(deleteError, "Unable to purge deleted client");

      if (deletedClient) {
        result.purged += 1;
        result.clientIds.push(candidate.id);
      } else {
        result.skipped += 1;
      }
    }

    return result;
  }
};
