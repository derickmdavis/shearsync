import { appointmentEmailDeliveryService } from "../services/appointmentEmailDeliveryService";

const defaultLimit = 25;

const getProcessLimit = (): number => {
  const parsedLimit = Number(process.env.APPOINTMENT_EMAIL_PROCESS_LIMIT ?? defaultLimit);

  if (!Number.isFinite(parsedLimit) || parsedLimit < 1) {
    return defaultLimit;
  }

  return Math.floor(parsedLimit);
};

const main = async (): Promise<void> => {
  const result = await appointmentEmailDeliveryService.processQueuedAppointmentEmails({
    limit: getProcessLimit()
  });

  console.log(JSON.stringify({ appointmentEmailProcessing: result }));
};

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error("[APPOINTMENT_EMAIL_CRON] failed", error);
    process.exit(1);
  });
