import { Router } from "express";
import { paymentMethodsController } from "../controllers/paymentMethodsController";
import { asyncHandler } from "../lib/asyncHandler";
import { validate } from "../middleware/validate";
import { uuidParamSchema } from "../validators/common";
import {
  createPaymentMethodSchema,
  listPaymentMethodsQuerySchema,
  qrUploadIntentSchema,
  reorderPaymentMethodsSchema,
  updatePaymentMethodSchema
} from "../validators/paymentMethodsValidators";

export const paymentMethodsRouter = Router();

paymentMethodsRouter.get(
  "/",
  validate({ query: listPaymentMethodsQuerySchema }),
  asyncHandler(paymentMethodsController.list)
);
paymentMethodsRouter.post(
  "/qr-upload-intent",
  validate({ body: qrUploadIntentSchema }),
  asyncHandler(paymentMethodsController.createQrUploadIntent)
);
paymentMethodsRouter.post(
  "/reorder",
  validate({ body: reorderPaymentMethodsSchema }),
  asyncHandler(paymentMethodsController.reorder)
);
paymentMethodsRouter.post(
  "/",
  validate({ body: createPaymentMethodSchema }),
  asyncHandler(paymentMethodsController.create)
);
paymentMethodsRouter.patch(
  "/:id",
  validate({ params: uuidParamSchema, body: updatePaymentMethodSchema }),
  asyncHandler(paymentMethodsController.update)
);
paymentMethodsRouter.delete(
  "/:id",
  validate({ params: uuidParamSchema }),
  asyncHandler(paymentMethodsController.remove)
);
