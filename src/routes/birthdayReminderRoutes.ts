import { Router } from "express";
import { birthdayRemindersController } from "../controllers/birthdayRemindersController";
import { asyncHandler } from "../lib/asyncHandler";
import { validate } from "../middleware/validate";
import {
  birthdayReminderIdParamSchema,
  cancelBirthdayReminderSchema
} from "../validators/birthdayReminderValidators";

export const birthdayReminderRouter = Router();

birthdayReminderRouter.post(
  "/:id/approve",
  validate({ params: birthdayReminderIdParamSchema }),
  asyncHandler(birthdayRemindersController.approve)
);

birthdayReminderRouter.post(
  "/:id/cancel",
  validate({ params: birthdayReminderIdParamSchema, body: cancelBirthdayReminderSchema }),
  asyncHandler(birthdayRemindersController.cancel)
);
