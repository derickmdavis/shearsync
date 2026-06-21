import { Router } from "express";
import { thankYouEmailsController } from "../controllers/thankYouEmailsController";
import { asyncHandler } from "../lib/asyncHandler";
import { validate } from "../middleware/validate";
import {
  cancelThankYouEmailSchema,
  createThankYouEmailSchema,
  listThankYouEmailsQuerySchema,
  thankYouEmailIdParamSchema
} from "../validators/thankYouEmailValidators";

export const thankYouEmailRouter = Router();

thankYouEmailRouter.get(
  "/",
  validate({ query: listThankYouEmailsQuerySchema }),
  asyncHandler(thankYouEmailsController.list)
);
thankYouEmailRouter.post(
  "/",
  validate({ body: createThankYouEmailSchema }),
  asyncHandler(thankYouEmailsController.create)
);
thankYouEmailRouter.post(
  "/:id/approve",
  validate({ params: thankYouEmailIdParamSchema }),
  asyncHandler(thankYouEmailsController.approve)
);
thankYouEmailRouter.post(
  "/:id/cancel",
  validate({ params: thankYouEmailIdParamSchema, body: cancelThankYouEmailSchema }),
  asyncHandler(thankYouEmailsController.cancel)
);
