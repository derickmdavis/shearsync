import { logger } from "../lib/logger";
import { accountDeletionProcessorService } from "../services/accountDeletionProcessorService";
import { jobRunsService } from "../services/jobRunsService";

const limit = Number.isFinite(Number(process.env.ACCOUNT_DELETION_PROCESS_LIMIT))
  ? Math.max(1, Math.min(100, Math.floor(Number(process.env.ACCOUNT_DELETION_PROCESS_LIMIT))))
  : 10;

const main = async (): Promise<void> => {
  const jobRun = await jobRunsService.startJobRun("account-deletion-worker", { limit });
  try {
    const result = await accountDeletionProcessorService.processDue({ limit });
    await jobRunsService.completeJobRun(String(jobRun.id), {
      recordsProcessed: result.processed,
      recordsSucceeded: result.completed + result.skipped,
      recordsFailed: result.failed
    });
    logger.info("account_deletion_processing_completed", { ...result });
  } catch (error) {
    await jobRunsService.failJobRun(String(jobRun.id), error);
    throw error;
  }
};

main().then(() => process.exit(0)).catch((error: unknown) => {
  logger.error("account_deletion_processing_failed", {
    errorMessage: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
