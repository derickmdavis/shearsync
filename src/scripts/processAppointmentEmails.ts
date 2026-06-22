import { appointmentEmailDeliveryService } from "../services/appointmentEmailDeliveryService";
import { logger } from "../lib/logger";

const defaultLimit = 25;

const getProcessLimit = (): number => {
  const parsedLimit = Number(process.env.APPOINTMENT_EMAIL_PROCESS_LIMIT ?? defaultLimit);

  if (!Number.isFinite(parsedLimit) || parsedLimit < 1) {
    return defaultLimit;
  }

  return Math.floor(parsedLimit);
};

const main = async (): Promise<void> => {
  const beforeMetrics = await appointmentEmailDeliveryService.getEmailQueueMetrics();
  logger.info("appointment_email_queue_metrics_before_processing", {
    ...beforeMetrics
  });

  const result = await appointmentEmailDeliveryService.processQueuedAppointmentEmails({
    limit: getProcessLimit()
  });
  const afterMetrics = await appointmentEmailDeliveryService.getEmailQueueMetrics();

  logger.info("appointment_email_processing_completed", {
    ...result,
    queue: afterMetrics
  });
};

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    logger.error("appointment_email_processing_failed", {
      errorMessage: error instanceof Error ? error.message : String(error)
    });
    process.exit(1);
  });
