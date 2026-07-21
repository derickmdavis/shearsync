import { Router } from "express";
import { settingsController } from "../controllers/settingsController";
import { asyncHandler } from "../lib/asyncHandler";
import { validate } from "../middleware/validate";
import {
  appointmentEmailTemplateParamSchema,
  previewAppointmentEmailTemplateSchema,
  updateBirthdayReminderSettingsSchema,
  previewRebookNudgeSettingsSchema,
  previewThankYouEmailSettingsSchema,
  replaceAvailabilitySchema,
  updateRebookNudgeSettingsSchema,
  updateThankYouEmailSettingsSchema,
  updateReferralProgramSettingsSchema,
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
settingsRouter.get("/email-templates", asyncHandler(settingsController.getAppointmentEmailTemplates));
settingsRouter.patch(
  "/email-confirmations/:emailType",
  validate({ params: appointmentEmailTemplateParamSchema, body: updateAppointmentEmailTemplateSchema }),
  asyncHandler(settingsController.updateAppointmentEmailTemplate)
);
settingsRouter.patch(
  "/email-templates/:emailType",
  validate({ params: appointmentEmailTemplateParamSchema, body: updateAppointmentEmailTemplateSchema }),
  asyncHandler(settingsController.updateAppointmentEmailTemplate)
);
settingsRouter.delete(
  "/email-confirmations/:emailType",
  validate({ params: appointmentEmailTemplateParamSchema }),
  asyncHandler(settingsController.resetAppointmentEmailTemplate)
);
settingsRouter.delete(
  "/email-templates/:emailType",
  validate({ params: appointmentEmailTemplateParamSchema }),
  asyncHandler(settingsController.resetAppointmentEmailTemplate)
);
settingsRouter.post(
  "/email-confirmations/:emailType/preview",
  validate({ params: appointmentEmailTemplateParamSchema, body: previewAppointmentEmailTemplateSchema }),
  asyncHandler(settingsController.previewAppointmentEmailTemplate)
);
settingsRouter.post(
  "/email-templates/:emailType/preview",
  validate({ params: appointmentEmailTemplateParamSchema, body: previewAppointmentEmailTemplateSchema }),
  asyncHandler(settingsController.previewAppointmentEmailTemplate)
);
settingsRouter.get("/rebook-nudges", asyncHandler(settingsController.getRebookNudgeSettings));
settingsRouter.patch(
  "/rebook-nudges",
  validate({ body: updateRebookNudgeSettingsSchema }),
  asyncHandler(settingsController.updateRebookNudgeSettings)
);
settingsRouter.post(
  "/rebook-nudges/preview",
  validate({ body: previewRebookNudgeSettingsSchema }),
  asyncHandler(settingsController.previewRebookNudgeSettings)
);
settingsRouter.get("/birthday-reminders", asyncHandler(settingsController.getBirthdayReminderSettings));
settingsRouter.patch(
  "/birthday-reminders",
  validate({ body: updateBirthdayReminderSettingsSchema }),
  asyncHandler(settingsController.updateBirthdayReminderSettings)
);
settingsRouter.get("/thank-you-emails", asyncHandler(settingsController.getThankYouEmailSettings));
settingsRouter.patch(
  "/thank-you-emails",
  validate({ body: updateThankYouEmailSettingsSchema }),
  asyncHandler(settingsController.updateThankYouEmailSettings)
);
settingsRouter.get("/referrals", asyncHandler(settingsController.getReferralProgramSettings));
settingsRouter.patch(
  "/referrals",
  validate({ body: updateReferralProgramSettingsSchema }),
  asyncHandler(settingsController.updateReferralProgramSettings)
);
settingsRouter.post(
  "/thank-you-emails/preview",
  validate({ body: previewThankYouEmailSettingsSchema }),
  asyncHandler(settingsController.previewThankYouEmailSettings)
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
