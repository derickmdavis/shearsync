import { Router } from "express";
import { internalController } from "../controllers/internalController";
import { asyncHandler } from "../lib/asyncHandler";
import { requireInternalApiSecret } from "../middleware/internalAuth";
import { validate } from "../middleware/validate";
import { processAppointmentEmailsQuerySchema } from "../validators/internalValidators";

export const internalRouter = Router();

internalRouter.post(
  "/appointment-emails/process",
  requireInternalApiSecret,
  validate({ query: processAppointmentEmailsQuerySchema }),
  asyncHandler(internalController.processAppointmentEmails)
);
