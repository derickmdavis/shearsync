import { Router } from "express";
import { activityController } from "../controllers/activityController";
import { asyncHandler } from "../lib/asyncHandler";
import { validate } from "../middleware/validate";
import {
  automationSettingParamSchema,
  listActivityQuerySchema,
  updateAutomationSettingSchema
} from "../validators/activityValidators";

export const activityRouter = Router();

activityRouter.get("/dashboard", asyncHandler(activityController.dashboard));
activityRouter.patch(
  "/automation/settings/:key",
  validate({ params: automationSettingParamSchema, body: updateAutomationSettingSchema }),
  asyncHandler(activityController.updateAutomationSetting)
);
activityRouter.get("/", validate({ query: listActivityQuerySchema }), asyncHandler(activityController.list));
activityRouter.get("/feed", validate({ query: listActivityQuerySchema }), asyncHandler(activityController.list));
