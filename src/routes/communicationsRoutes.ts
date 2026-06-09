import { Router } from "express";
import { communicationsController } from "../controllers/communicationsController";
import { asyncHandler } from "../lib/asyncHandler";
import { validate } from "../middleware/validate";
import { publicAppointmentManagementTokenParamSchema } from "../validators/common";

export const communicationsRouter = Router();

communicationsRouter.get(
  "/unsubscribe/:token",
  validate({ params: publicAppointmentManagementTokenParamSchema }),
  asyncHandler(communicationsController.unsubscribe)
);
communicationsRouter.post("/sms/inbound", asyncHandler(communicationsController.inboundSms));
