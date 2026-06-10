import { Router } from "express";
import { rebookNudgesController } from "../controllers/rebookNudgesController";
import { asyncHandler } from "../lib/asyncHandler";
import { validate } from "../middleware/validate";
import {
  cancelRebookNudgeSchema,
  createRebookNudgeSchema,
  listRebookNudgesQuerySchema,
  rebookNudgeIdParamSchema
} from "../validators/rebookNudgeValidators";

export const rebookNudgeRouter = Router();

rebookNudgeRouter.get(
  "/",
  validate({ query: listRebookNudgesQuerySchema }),
  asyncHandler(rebookNudgesController.list)
);
rebookNudgeRouter.post(
  "/",
  validate({ body: createRebookNudgeSchema }),
  asyncHandler(rebookNudgesController.create)
);
rebookNudgeRouter.post(
  "/:id/approve",
  validate({ params: rebookNudgeIdParamSchema }),
  asyncHandler(rebookNudgesController.approve)
);
rebookNudgeRouter.post(
  "/:id/cancel",
  validate({ params: rebookNudgeIdParamSchema, body: cancelRebookNudgeSchema }),
  asyncHandler(rebookNudgesController.cancel)
);
