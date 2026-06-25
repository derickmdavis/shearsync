import { env, getAppEnvironment } from "../config/env";
import { supabaseAdmin } from "../lib/supabase";
import { handleSupabaseError } from "./db";
import { jobRunsService } from "./jobRunsService";

export interface ApiRequestLogCleanupResult {
  retentionDays: number;
  cutoff: string;
  deleted: number;
}

export const apiRequestLogRetentionService = {
  async cleanup(retentionDays = env.API_REQUEST_LOG_RETENTION_DAYS): Promise<ApiRequestLogCleanupResult> {
    const normalizedRetentionDays = Math.max(1, Math.floor(retentionDays));
    const cutoff = new Date(Date.now() - normalizedRetentionDays * 24 * 60 * 60 * 1000).toISOString();
    let jobRunId: string | null = null;

    try {
      const jobRun = await jobRunsService.startJobRun("api-request-logs-cleanup", {
        retention_days: normalizedRetentionDays,
        cutoff
      });
      jobRunId = typeof jobRun.id === "string" ? jobRun.id : null;
    } catch (error) {
      if (process.env.NODE_ENV !== "test") {
        console.warn("[API_REQUEST_LOGS] cleanup job start failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    try {
      const { data, error } = await supabaseAdmin
        .from("api_request_logs")
        .delete()
        .eq("environment", getAppEnvironment())
        .lt("created_at", cutoff)
        .select("id");

      handleSupabaseError(error, "Unable to cleanup API request logs");

      const deleted = Array.isArray(data) ? data.length : 0;
      if (jobRunId) {
        try {
          await jobRunsService.completeJobRun(jobRunId, {
            recordsProcessed: deleted,
            recordsSucceeded: deleted,
            recordsFailed: 0
          });
        } catch (error) {
          if (process.env.NODE_ENV !== "test") {
            console.warn("[API_REQUEST_LOGS] cleanup job completion failed", {
              jobRunId,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }
      }

      return {
        retentionDays: normalizedRetentionDays,
        cutoff,
        deleted
      };
    } catch (error) {
      if (jobRunId) {
        try {
          await jobRunsService.failJobRun(jobRunId, error);
        } catch (jobRunError) {
          if (process.env.NODE_ENV !== "test") {
            console.warn("[API_REQUEST_LOGS] cleanup job failure logging failed", {
              jobRunId,
              error: jobRunError instanceof Error ? jobRunError.message : String(jobRunError)
            });
          }
        }
      }

      throw error;
    }
  }
};
