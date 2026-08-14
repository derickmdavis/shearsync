import { Router } from "express";
import { communicationsController } from "../controllers/communicationsController";
import { asyncHandler } from "../lib/asyncHandler";
import { validate } from "../middleware/validate";
import { publicAppointmentManagementTokenParamSchema } from "../validators/common";
import { requireValidTwilioWebhook } from "../middleware/twilioWebhook";

export const communicationsRouter = Router();

communicationsRouter.get(
  "/unsubscribe/:token",
  validate({ params: publicAppointmentManagementTokenParamSchema }),
  asyncHandler(communicationsController.unsubscribe)
);
communicationsRouter.post("/sms/inbound", requireValidTwilioWebhook, asyncHandler(communicationsController.inboundSms));
communicationsRouter.post("/sms/status", requireValidTwilioWebhook, asyncHandler(communicationsController.smsStatus));
