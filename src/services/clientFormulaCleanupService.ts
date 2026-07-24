import { supabaseAdmin } from "../lib/supabase";
import { appointmentImageStorageService } from "./appointmentImageStorageService";
import { handleSupabaseError, type Row } from "./db";

export const clientFormulaCleanupService = {
  async purgeExpiredArchivedFormulas(now = new Date(), limit = 50) {
    const { data: formulas, error } = await supabaseAdmin.from("client_formulas").select("id, user_id, client_id").not("deleted_at", "is", null).lte("purge_after", now.toISOString()).order("purge_after", { ascending: true }).limit(limit);
    handleSupabaseError(error, "Unable to load formulas eligible for purge");
    const result = { scanned: formulas?.length ?? 0, purged: 0, skipped: 0, storage_deleted: 0, storage_delete_failed: 0, formula_ids: [] as string[] };
    for (const formula of (formulas ?? []) as Row[]) {
      const { data: images, error: imagesError } = await supabaseAdmin.from("client_formula_images").select("storage_path, thumbnail_path").eq("formula_id", formula.id);
      handleSupabaseError(imagesError, "Unable to load formula assets for purge");
      let failed = false;
      for (const image of images ?? []) {
        const cleanup = await appointmentImageStorageService.deleteObjectsSafely({ storagePath: typeof image.storage_path === "string" ? image.storage_path : undefined, thumbnailPath: typeof image.thumbnail_path === "string" ? image.thumbnail_path : undefined }, "archived formula purge");
        result.storage_deleted += cleanup.deletedPaths.length; result.storage_delete_failed += cleanup.failedPaths.length; failed ||= cleanup.failedPaths.length > 0;
      }
      if (failed) { result.skipped += 1; continue; }
      const { data: deleted, error: deleteError } = await supabaseAdmin.from("client_formulas").delete().eq("id", formula.id).eq("user_id", formula.user_id).not("deleted_at", "is", null).lte("purge_after", now.toISOString()).select("id").maybeSingle();
      handleSupabaseError(deleteError, "Unable to purge archived formula");
      if (deleted) { result.purged += 1; result.formula_ids.push(String(formula.id)); } else result.skipped += 1;
    }
    return result;
  }
};
