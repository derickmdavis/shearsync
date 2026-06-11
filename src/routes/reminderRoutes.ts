import { Router } from "express";
import { remindersController } from "../controllers/remindersController";
import { asyncHandler } from "../lib/asyncHandler";
import { validate } from "../middleware/validate";
import { uuidParamSchema } from "../validators/common";
import { birthdayRemindersQuerySchema, createReminderSchema, updateReminderSchema } from "../validators/reminderValidators";

export const reminderRouter = Router();

reminderRouter.get("/", asyncHandler(remindersController.list));
reminderRouter.get(
  "/birthdays",
  validate({ query: birthdayRemindersQuerySchema }),
  asyncHandler(remindersController.listBirthdays)
);
reminderRouter.post("/", validate({ body: createReminderSchema }), asyncHandler(remindersController.create));
reminderRouter.patch(
  "/:id",
  validate({ params: uuidParamSchema, body: updateReminderSchema }),
  asyncHandler(remindersController.update)
);
