import { logger } from "../lib/logger";
import { smsInboundEventRetentionService } from "../services/smsInboundEventRetentionService";

smsInboundEventRetentionService.cleanup()
  .then((result) => {
    logger.info("sms_inbound_event_retention_cleanup_completed", { ...result });
    process.exit(0);
  })
  .catch((error: unknown) => {
    logger.error("sms_inbound_event_retention_cleanup_failed", {
      errorMessage: error instanceof Error ? error.message : String(error)
    });
    process.exit(1);
  });
