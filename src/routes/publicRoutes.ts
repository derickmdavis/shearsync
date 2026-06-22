import { Router } from "express";
import { publicController } from "../controllers/publicController";
import { asyncHandler } from "../lib/asyncHandler";
import { validate } from "../middleware/validate";
import {
  appointmentActionShortCodeParamSchema,
  publicAppointmentManagementTokenParamSchema,
  referralCodeParamSchema,
  slugParamSchema
} from "../validators/common";
import {
  finalizePublicReferencePhotoSchema,
  publicReferencePhotoUploadIntentSchema
} from "../validators/appointmentImageValidators";
import {
  getPublicAvailabilitySchema,
  createPublicBookingIntakeSchema,
  createPublicBookingSchema,
  getPublicServicesSchema,
  getPublicAvailabilitySlotsSchema,
  reschedulePublicAppointmentActionLinkSchema,
  reschedulePublicAppointmentSchema
} from "../validators/publicBookingValidators";
import { createPublicWaitlistEntrySchema } from "../validators/waitlistValidators";

export const publicRouter = Router();

publicRouter.get(
  "/referrals/:referralCode",
  validate({ params: referralCodeParamSchema }),
  asyncHandler(publicController.resolveReferral)
);
publicRouter.get("/stylists/:slug", validate({ params: slugParamSchema }), asyncHandler(publicController.getStylist));
publicRouter.get(
  "/services/:slug",
  validate({ params: slugParamSchema, query: getPublicServicesSchema }),
  asyncHandler(publicController.getServices)
);
publicRouter.get(
  "/availability/:slug",
  validate({ params: slugParamSchema, query: getPublicAvailabilitySchema }),
  asyncHandler(publicController.getAvailability)
);
publicRouter.get(
  "/availability/:slug/slots",
  validate({ params: slugParamSchema, query: getPublicAvailabilitySlotsSchema }),
  asyncHandler(publicController.getAvailabilitySlots)
);
publicRouter.post(
  "/booking-intake",
  validate({ body: createPublicBookingIntakeSchema }),
  asyncHandler(publicController.createBookingIntake)
);
publicRouter.post("/early-access", asyncHandler(publicController.createEarlyAccessRequest));
publicRouter.post("/bookings", validate({ body: createPublicBookingSchema }), asyncHandler(publicController.createBooking));
publicRouter.post(
  "/appointment-reference-photos/upload-intent",
  validate({ body: publicReferencePhotoUploadIntentSchema }),
  asyncHandler(publicController.createReferencePhotoUploadIntent)
);
publicRouter.post(
  "/appointment-reference-photos",
  validate({ body: finalizePublicReferencePhotoSchema }),
  asyncHandler(publicController.finalizeReferencePhoto)
);
publicRouter.post(
  "/stylists/:slug/waitlist",
  validate({ params: slugParamSchema, body: createPublicWaitlistEntrySchema }),
  asyncHandler(publicController.createWaitlistEntry)
);
publicRouter.get(
  "/appointment-links/:shortCode",
  validate({ params: appointmentActionShortCodeParamSchema }),
  asyncHandler(publicController.getAppointmentActionLink)
);
publicRouter.post(
  "/appointment-links/:shortCode/cancel",
  validate({ params: appointmentActionShortCodeParamSchema }),
  asyncHandler(publicController.cancelAppointmentActionLink)
);
publicRouter.post(
  "/appointment-links/:shortCode/reschedule",
  validate({ params: appointmentActionShortCodeParamSchema, body: reschedulePublicAppointmentActionLinkSchema }),
  asyncHandler(publicController.rescheduleAppointmentActionLink)
);
publicRouter.get(
  "/appointments/manage/:token",
  validate({ params: publicAppointmentManagementTokenParamSchema }),
  asyncHandler(publicController.getManagedAppointment)
);
publicRouter.post(
  "/appointments/manage/:token/cancel",
  validate({ params: publicAppointmentManagementTokenParamSchema }),
  asyncHandler(publicController.cancelManagedAppointment)
);
publicRouter.post(
  "/appointments/manage/:token/reschedule",
  validate({ params: publicAppointmentManagementTokenParamSchema, body: reschedulePublicAppointmentSchema }),
  asyncHandler(publicController.rescheduleManagedAppointment)
);
