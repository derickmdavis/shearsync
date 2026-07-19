import { logger } from "../lib/logger";
import { campaignDeliveryWorkerService } from "../services/campaignDeliveryWorkerService";
import { jobRunsService } from "../services/jobRunsService";

const limit = Number.isFinite(Number(process.env.CAMPAIGN_DELIVERY_PROCESS_LIMIT))
  ? Math.max(1, Math.min(100, Math.floor(Number(process.env.CAMPAIGN_DELIVERY_PROCESS_LIMIT))))
  : 25;

const main = async (): Promise<void> => {
  const jobRun = await jobRunsService.startJobRun("campaign-delivery-worker", { limit });

  try {
    const result = await campaignDeliveryWorkerService.processDueCampaigns({ limit });
    await jobRunsService.completeJobRun(String(jobRun.id), {
      recordsProcessed: result.processed,
      recordsSucceeded: result.sent + result.skipped,
      recordsFailed: result.failed
    });
    logger.info("campaign_delivery_processing_completed", { ...result });
  } catch (error) {
    await jobRunsService.failJobRun(String(jobRun.id), error);
    throw error;
  }
};

main().then(() => process.exit(0)).catch((error: unknown) => {
  logger.error("campaign_delivery_processing_failed", {
    errorMessage: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
