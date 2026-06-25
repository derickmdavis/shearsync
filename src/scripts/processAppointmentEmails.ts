import { appointmentEmailDeliveryService } from "../services/appointmentEmailDeliveryService";
import { logger } from "../lib/logger";
import { jobRunsService } from "../services/jobRunsService";

const defaultLimit = 25;

const getProcessLimit = (): number => {
  const parsedLimit = Number(process.env.APPOINTMENT_EMAIL_PROCESS_LIMIT ?? defaultLimit);

  if (!Number.isFinite(parsedLimit) || parsedLimit < 1) {
    return defaultLimit;
  }

  return Math.floor(parsedLimit);
};

const main = async (): Promise<void> => {
  let jobRunId: string | null = null;

  try {
    const jobRun = await jobRunsService.startJobRun("appointment-emails-worker", {
      limit: getProcessLimit()
    });
    jobRunId = typeof jobRun.id === "string" ? jobRun.id : null;
  } catch (error) {
    logger.error("appointment_email_job_run_start_failed", {
      errorMessage: error instanceof Error ? error.message : String(error)
    });
  }

  const beforeMetrics = await appointmentEmailDeliveryService.getEmailQueueMetrics();
  logger.info("appointment_email_queue_metrics_before_processing", {
    ...beforeMetrics
  });

  try {
    const result = await appointmentEmailDeliveryService.processQueuedAppointmentEmails({
      limit: getProcessLimit()
    });
    const afterMetrics = await appointmentEmailDeliveryService.getEmailQueueMetrics();

    logger.info("appointment_email_processing_completed", {
      ...result,
      queue: afterMetrics
    });

    if (jobRunId) {
      try {
        await jobRunsService.completeJobRun(jobRunId, {
          recordsProcessed: result.processed,
          recordsSucceeded: result.sent + result.skipped,
          recordsFailed: result.failed
        });
      } catch (error) {
        logger.error("appointment_email_job_run_complete_failed", {
          jobRunId,
          errorMessage: error instanceof Error ? error.message : String(error)
        });
      }
    }
  } catch (error) {
    if (jobRunId) {
      try {
        await jobRunsService.failJobRun(jobRunId, error);
      } catch (jobRunError) {
        logger.error("appointment_email_job_run_fail_failed", {
          jobRunId,
          errorMessage: jobRunError instanceof Error ? jobRunError.message : String(jobRunError)
        });
      }
    }

    throw error;
  }
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
