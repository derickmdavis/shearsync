import { Router } from "express";
import { internalController } from "../controllers/internalController";
import { asyncHandler } from "../lib/asyncHandler";
import { requireInternalApiSecret } from "../middleware/internalAuth";
import { validate } from "../middleware/validate";
import {
  processAppointmentEmailsQuerySchema,
  processBirthdayRemindersQuerySchema,
  processRebookNudgesQuerySchema,
  queueBirthdayRemindersQuerySchema,
  queueRebookNudgesQuerySchema
} from "../validators/internalValidators";

export const internalRouter = Router();

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
