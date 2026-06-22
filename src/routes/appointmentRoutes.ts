import { Router } from "express";
import { appointmentImagesController } from "../controllers/appointmentImagesController";
import { appointmentPaymentsController } from "../controllers/appointmentPaymentsController";
import { appointmentsController } from "../controllers/appointmentsController";
import { asyncHandler } from "../lib/asyncHandler";
import { validate } from "../middleware/validate";
import {
  appointmentImageParamsSchema,
  appointmentImageThumbnailPrefetchQuerySchema,
  appointmentImageUploadIntentSchema,
  finalizeAppointmentImageSchema,
  reorderAppointmentImagesSchema,
  updateAppointmentImageSchema
} from "../validators/appointmentImageValidators";
import {
  markAppointmentPaidSchema,
  updateAppointmentPaymentSchema
} from "../validators/appointmentPaymentsValidators";
import {
  createAppointmentSchema,
  getInternalAppointmentContextSchema,
  pendingAppointmentDecisionSchema,
  updateAppointmentSchema
} from "../validators/appointmentValidators";
import { uuidParamSchema } from "../validators/common";

export const appointmentRouter = Router();

const appointmentIdParamSchema = uuidParamSchema.transform(({ id }) => ({ appointmentId: id }));

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
appointmentRouter.get(
  "/images/thumbnail-prefetch",
  validate({ query: appointmentImageThumbnailPrefetchQuerySchema }),
  asyncHandler(appointmentImagesController.prefetchThumbnails)
);
appointmentRouter.get(
  "/:id/images",
  validate({ params: uuidParamSchema }),
  asyncHandler(appointmentImagesController.list)
);
appointmentRouter.post(
  "/:id/images/upload-intent",
  validate({ params: uuidParamSchema, body: appointmentImageUploadIntentSchema }),
  asyncHandler(appointmentImagesController.createUploadIntent)
);
appointmentRouter.post(
  "/:id/images",
  validate({ params: uuidParamSchema, body: finalizeAppointmentImageSchema }),
  asyncHandler(appointmentImagesController.finalize)
);
appointmentRouter.post(
  "/:id/images/reorder",
  validate({ params: uuidParamSchema, body: reorderAppointmentImagesSchema }),
  asyncHandler(appointmentImagesController.reorder)
);
appointmentRouter.get(
  "/:id/images/:imageId/display-url",
  validate({ params: appointmentImageParamsSchema }),
  asyncHandler(appointmentImagesController.getDisplayUrl)
);
appointmentRouter.patch(
  "/:id/images/:imageId",
  validate({ params: appointmentImageParamsSchema, body: updateAppointmentImageSchema }),
  asyncHandler(appointmentImagesController.update)
);
appointmentRouter.delete(
  "/:id/images/:imageId",
  validate({ params: appointmentImageParamsSchema }),
  asyncHandler(appointmentImagesController.remove)
);
appointmentRouter.get(
  "/:id/payment",
  validate({ params: appointmentIdParamSchema }),
  asyncHandler(appointmentPaymentsController.get)
);
appointmentRouter.post(
  "/:id/payment/mark-paid",
  validate({ params: appointmentIdParamSchema, body: markAppointmentPaidSchema }),
  asyncHandler(appointmentPaymentsController.markPaid)
);
appointmentRouter.post(
  "/:id/payment/mark-unpaid",
  validate({ params: appointmentIdParamSchema }),
  asyncHandler(appointmentPaymentsController.markUnpaid)
);
appointmentRouter.patch(
  "/:id/payment",
  validate({ params: appointmentIdParamSchema, body: updateAppointmentPaymentSchema }),
  asyncHandler(appointmentPaymentsController.update)
);
appointmentRouter.get("/:id", validate({ params: uuidParamSchema }), asyncHandler(appointmentsController.getById));
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
