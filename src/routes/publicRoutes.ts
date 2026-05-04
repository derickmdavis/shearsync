import { Router } from "express";
import { publicController } from "../controllers/publicController";
import { asyncHandler } from "../lib/asyncHandler";
import { validate } from "../middleware/validate";
import { slugParamSchema } from "../validators/common";
import {
  getPublicAvailabilitySchema,
  createPublicBookingIntakeSchema,
  createPublicBookingSchema,
  getPublicServicesSchema,
  getPublicAvailabilitySlotsSchema
} from "../validators/publicBookingValidators";

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
