import { Router } from "express";
import { appointmentsController } from "../controllers/appointmentsController";
import { asyncHandler } from "../lib/asyncHandler";
import { validate } from "../middleware/validate";
import {
  createAppointmentSchema,
  getInternalAppointmentContextSchema,
  pendingAppointmentDecisionSchema,
  updateAppointmentSchema
} from "../validators/appointmentValidators";
import { uuidParamSchema } from "../validators/common";

export const appointmentRouter = Router();

appointmentRouter.get(
  "/internal-context",
  validate({ query: getInternalAppointmentContextSchema }),
  asyncHandler(appointmentsController.getInternalContext)
);
appointmentRouter.get(
  "/:id/activity",
  validate({ params: uuidParamSchema }),
  asyncHandler(appointmentsController.listActivity)
);
appointmentRouter.post("/", validate({ body: createAppointmentSchema }), asyncHandler(appointmentsController.create));
appointmentRouter.patch(
  "/:id",
  validate({ params: uuidParamSchema, body: updateAppointmentSchema }),
  asyncHandler(appointmentsController.update)
);
appointmentRouter.patch(
  "/:id/decision",
  validate({ params: uuidParamSchema, body: pendingAppointmentDecisionSchema }),
  asyncHandler(appointmentsController.applyPendingDecision)
);
