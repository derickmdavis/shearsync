import { Router } from "express";
import { settingsController } from "../controllers/settingsController";
import { asyncHandler } from "../lib/asyncHandler";
import { validate } from "../middleware/validate";
import {
  appointmentEmailTemplateParamSchema,
  previewAppointmentEmailTemplateSchema,
  replaceAvailabilitySchema,
  updateAppointmentEmailTemplateSchema,
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
settingsRouter.get("/email-confirmations", asyncHandler(settingsController.getAppointmentEmailTemplates));
settingsRouter.patch(
  "/email-confirmations/:emailType",
  validate({ params: appointmentEmailTemplateParamSchema, body: updateAppointmentEmailTemplateSchema }),
  asyncHandler(settingsController.updateAppointmentEmailTemplate)
);
settingsRouter.delete(
  "/email-confirmations/:emailType",
  validate({ params: appointmentEmailTemplateParamSchema }),
  asyncHandler(settingsController.resetAppointmentEmailTemplate)
);
settingsRouter.post(
  "/email-confirmations/:emailType/preview",
  validate({ params: appointmentEmailTemplateParamSchema, body: previewAppointmentEmailTemplateSchema }),
  asyncHandler(settingsController.previewAppointmentEmailTemplate)
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
