import { logger } from "../lib/logger";
import { accountAccessService } from "../services/accountAccessService";

accountAccessService.expireEndedAccounts()
  .then((result) => {
    logger.info("account_access_expiration_completed", result);
    process.exit(0);
  })
  .catch((error: unknown) => {
    logger.error("account_access_expiration_failed", {
      errorMessage: error instanceof Error ? error.message : String(error)
    });
    process.exit(1);
  });
