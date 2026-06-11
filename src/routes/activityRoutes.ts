import { Router } from "express";
import { activityController } from "../controllers/activityController";
import { asyncHandler } from "../lib/asyncHandler";
import { validate } from "../middleware/validate";
import {
  automationSettingParamSchema,
  birthdayReminderParamSchema,
  listBirthdayRemindersQuerySchema,
  listActivityQuerySchema,
  recentCancellationsQuerySchema,
  updateAutomationSettingSchema
} from "../validators/activityValidators";

export const activityRouter = Router();

activityRouter.get("/dashboard", asyncHandler(activityController.dashboard));
activityRouter.get(
  "/cancellations",
  validate({ query: recentCancellationsQuerySchema }),
  asyncHandler(activityController.recentCancellations)
);
activityRouter.get(
  "/birthday-reminders",
  validate({ query: listBirthdayRemindersQuerySchema }),
  asyncHandler(activityController.listBirthdayReminders)
);
activityRouter.delete(
  "/birthday-reminders/:reminder_id",
  validate({ params: birthdayReminderParamSchema }),
  asyncHandler(activityController.cancelBirthdayReminder)
);
activityRouter.patch(
  "/automation/settings/:key",
  validate({ params: automationSettingParamSchema, body: updateAutomationSettingSchema }),
  asyncHandler(activityController.updateAutomationSetting)
);
activityRouter.get("/", validate({ query: listActivityQuerySchema }), asyncHandler(activityController.list));
activityRouter.get("/feed", validate({ query: listActivityQuerySchema }), asyncHandler(activityController.list));
