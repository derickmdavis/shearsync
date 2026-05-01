import { Router } from "express";
import { settingsController } from "../controllers/settingsController";
import { asyncHandler } from "../lib/asyncHandler";
import { validate } from "../middleware/validate";
import {
  replaceAvailabilitySchema,
  updateBookingRulesSchema,
  updateBookingSettingsSchema,
  updateProfileSchema
} from "../validators/settingsValidators";

export const settingsRouter = Router();

settingsRouter.get("/profile", asyncHandler(settingsController.getProfile));
settingsRouter.patch(
  "/profile",
  validate({ body: updateProfileSchema }),
  asyncHandler(settingsController.updateProfile)
);
settingsRouter.get("/booking", asyncHandler(settingsController.getBooking));
settingsRouter.get("/availability", asyncHandler(settingsController.getAvailability));
settingsRouter.patch(
  "/booking",
  validate({ body: updateBookingSettingsSchema }),
  asyncHandler(settingsController.updateBooking)
);
settingsRouter.put(
  "/availability",
  validate({ body: replaceAvailabilitySchema }),
  asyncHandler(settingsController.replaceAvailability)
);
settingsRouter.get("/booking-rules", asyncHandler(settingsController.getBookingRules));
settingsRouter.patch(
  "/booking-rules",
  validate({ body: updateBookingRulesSchema }),
  asyncHandler(settingsController.updateBookingRules)
);
