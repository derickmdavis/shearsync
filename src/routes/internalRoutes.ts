import { Router } from "express";
import { internalController } from "../controllers/internalController";
import { asyncHandler } from "../lib/asyncHandler";
import { requireInternalApiSecret } from "../middleware/internalAuth";
import { validate } from "../middleware/validate";
import {
  cleanupAppointmentImagesQuerySchema,
  processAppointmentEmailsQuerySchema,
  processBirthdayRemindersQuerySchema,
  processRebookNudgesQuerySchema,
  processThankYouEmailsQuerySchema,
  purgeDeletedClientsQuerySchema,
  queueAppointmentRemindersQuerySchema,
  queueBirthdayRemindersQuerySchema,
  queueRebookNudgesQuerySchema,
  queueThankYouEmailsQuerySchema
} from "../validators/internalValidators";

export const internalRouter = Router();

internalRouter.post(
  "/appointment-reminders/queue",
  requireInternalApiSecret,
  validate({ query: queueAppointmentRemindersQuerySchema }),
  asyncHandler(internalController.queueAppointmentReminders)
);
internalRouter.post(
  "/appointment-emails/process",
  requireInternalApiSecret,
  validate({ query: processAppointmentEmailsQuerySchema }),
  asyncHandler(internalController.processAppointmentEmails)
);
internalRouter.post(
  "/rebook-nudges/queue",
  requireInternalApiSecret,
  validate({ query: queueRebookNudgesQuerySchema }),
  asyncHandler(internalController.queueRebookNudges)
);
internalRouter.post(
  "/rebook-nudges/process",
  requireInternalApiSecret,
  validate({ query: processRebookNudgesQuerySchema }),
  asyncHandler(internalController.processRebookNudges)
);
internalRouter.post(
  "/birthday-reminders/queue",
  requireInternalApiSecret,
  validate({ query: queueBirthdayRemindersQuerySchema }),
  asyncHandler(internalController.queueBirthdayReminders)
);
internalRouter.post(
  "/birthday-reminders/process",
  requireInternalApiSecret,
  validate({ query: processBirthdayRemindersQuerySchema }),
  asyncHandler(internalController.processBirthdayReminders)
);
internalRouter.post(
  "/thank-you-emails/queue",
  requireInternalApiSecret,
  validate({ query: queueThankYouEmailsQuerySchema }),
  asyncHandler(internalController.queueThankYouEmails)
);
internalRouter.post(
  "/thank-you-emails/process",
  requireInternalApiSecret,
  validate({ query: processThankYouEmailsQuerySchema }),
  asyncHandler(internalController.processThankYouEmails)
);
internalRouter.post(
  "/clients/purge",
  requireInternalApiSecret,
  validate({ query: purgeDeletedClientsQuerySchema }),
  asyncHandler(internalController.purgeDeletedClients)
);
internalRouter.post(
  "/appointment-images/cleanup",
  requireInternalApiSecret,
  validate({ query: cleanupAppointmentImagesQuerySchema }),
  asyncHandler(internalController.cleanupAppointmentImages)
);
internalRouter.post(
  "/api-request-logs/cleanup",
  requireInternalApiSecret,
  asyncHandler(internalController.cleanupApiRequestLogs)
);
