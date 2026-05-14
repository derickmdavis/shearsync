import { Router } from "express";
import { publicController } from "../controllers/publicController";
import { asyncHandler } from "../lib/asyncHandler";
import { validate } from "../middleware/validate";
import { publicAppointmentManagementTokenParamSchema, slugParamSchema } from "../validators/common";
import {
  getPublicAvailabilitySchema,
  createPublicBookingIntakeSchema,
  createPublicBookingSchema,
  getPublicServicesSchema,
  getPublicAvailabilitySlotsSchema,
  reschedulePublicAppointmentSchema
} from "../validators/publicBookingValidators";
import { createPublicWaitlistEntrySchema } from "../validators/waitlistValidators";

export const publicRouter = Router();

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
publicRouter.post("/bookings", validate({ body: createPublicBookingSchema }), asyncHandler(publicController.createBooking));
publicRouter.post(
  "/stylists/:slug/waitlist",
  validate({ params: slugParamSchema, body: createPublicWaitlistEntrySchema }),
  asyncHandler(publicController.createWaitlistEntry)
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
