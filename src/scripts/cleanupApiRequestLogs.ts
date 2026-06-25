import { logger } from "../lib/logger";
import { apiRequestLogRetentionService } from "../services/apiRequestLogRetentionService";

const main = async (): Promise<void> => {
  const result = await apiRequestLogRetentionService.cleanup();
  logger.info("api_request_logs_cleanup_completed", { ...result });
};

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    logger.error("api_request_logs_cleanup_failed", {
      errorMessage: error instanceof Error ? error.message : String(error)
    });
    process.exit(1);
  });
