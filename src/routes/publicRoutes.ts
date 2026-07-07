import { Router } from "express";
import { publicController } from "../controllers/publicController";
import { asyncHandler } from "../lib/asyncHandler";
import {
  appointmentManageMutationRateLimiter,
  appointmentManageReadRateLimiter,
  availabilityRateLimiter,
  bookingCreateRateLimiter,
  bookingIntakeRateLimiter,
  photoUploadRateLimiter,
  publicMutationRateLimiter,
  publicReadRateLimiter
} from "../middleware/rateLimit";
import { validate } from "../middleware/validate";
import {
  appointmentActionShortCodeParamSchema,
  publicAppointmentManagementTokenParamSchema,
  publicReferralQuerySchema,
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
  publicReadRateLimiter,
  validate({ params: referralCodeParamSchema, query: publicReferralQuerySchema }),
  asyncHandler(publicController.resolveReferral)
);
publicRouter.get(
  "/stylists/:slug",
  publicReadRateLimiter,
  validate({ params: slugParamSchema }),
  asyncHandler(publicController.getStylist)
);
publicRouter.get(
  "/services/:slug",
  publicReadRateLimiter,
  validate({ params: slugParamSchema, query: getPublicServicesSchema }),
  asyncHandler(publicController.getServices)
);
publicRouter.get(
  "/availability/:slug",
  publicReadRateLimiter,
  validate({ params: slugParamSchema, query: getPublicAvailabilitySchema }),
  asyncHandler(publicController.getAvailability)
);
publicRouter.get(
  "/availability/:slug/slots",
  availabilityRateLimiter,
  validate({ params: slugParamSchema, query: getPublicAvailabilitySlotsSchema }),
  asyncHandler(publicController.getAvailabilitySlots)
);
publicRouter.post(
  "/booking-intake",
  bookingIntakeRateLimiter,
  validate({ body: createPublicBookingIntakeSchema }),
  asyncHandler(publicController.createBookingIntake)
);
publicRouter.post("/early-access", publicMutationRateLimiter, asyncHandler(publicController.createEarlyAccessRequest));
publicRouter.post(
  "/bookings",
  bookingCreateRateLimiter,
  validate({ body: createPublicBookingSchema }),
  asyncHandler(publicController.createBooking)
);
publicRouter.post(
  "/appointment-reference-photos/upload-intent",
  photoUploadRateLimiter,
  validate({ body: publicReferencePhotoUploadIntentSchema }),
  asyncHandler(publicController.createReferencePhotoUploadIntent)
);
publicRouter.post(
  "/appointment-reference-photos",
  photoUploadRateLimiter,
  validate({ body: finalizePublicReferencePhotoSchema }),
  asyncHandler(publicController.finalizeReferencePhoto)
);
publicRouter.post(
  "/stylists/:slug/waitlist",
  publicMutationRateLimiter,
  validate({ params: slugParamSchema, body: createPublicWaitlistEntrySchema }),
  asyncHandler(publicController.createWaitlistEntry)
);
publicRouter.get(
  "/appointment-links/:shortCode",
  appointmentManageReadRateLimiter,
  validate({ params: appointmentActionShortCodeParamSchema }),
  asyncHandler(publicController.getAppointmentActionLink)
);
publicRouter.post(
  "/appointment-links/:shortCode/cancel",
  appointmentManageMutationRateLimiter,
  validate({ params: appointmentActionShortCodeParamSchema }),
  asyncHandler(publicController.cancelAppointmentActionLink)
);
publicRouter.post(
  "/appointment-links/:shortCode/reschedule",
  appointmentManageMutationRateLimiter,
  validate({ params: appointmentActionShortCodeParamSchema, body: reschedulePublicAppointmentActionLinkSchema }),
  asyncHandler(publicController.rescheduleAppointmentActionLink)
);
publicRouter.get(
  "/appointments/manage/:token",
  appointmentManageReadRateLimiter,
  validate({ params: publicAppointmentManagementTokenParamSchema }),
  asyncHandler(publicController.getManagedAppointment)
);
publicRouter.post(
  "/appointments/manage/:token/cancel",
  appointmentManageMutationRateLimiter,
  validate({ params: publicAppointmentManagementTokenParamSchema }),
  asyncHandler(publicController.cancelManagedAppointment)
);
publicRouter.post(
  "/appointments/manage/:token/reschedule",
  appointmentManageMutationRateLimiter,
  validate({ params: publicAppointmentManagementTokenParamSchema, body: reschedulePublicAppointmentSchema }),
  asyncHandler(publicController.rescheduleManagedAppointment)
);
