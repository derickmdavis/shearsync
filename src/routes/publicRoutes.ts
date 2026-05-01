import { Router } from "express";
import { publicController } from "../controllers/publicController";
import { asyncHandler } from "../lib/asyncHandler";
import { validate } from "../middleware/validate";
import { slugParamSchema } from "../validators/common";
import {
  createPublicBookingIntakeSchema,
  createPublicBookingSchema,
  getPublicAvailabilitySlotsSchema
} from "../validators/publicBookingValidators";

export const publicRouter = Router();

publicRouter.get("/stylists/:slug", validate({ params: slugParamSchema }), asyncHandler(publicController.getStylist));
publicRouter.get("/services/:slug", validate({ params: slugParamSchema }), asyncHandler(publicController.getServices));
publicRouter.get(
  "/availability/:slug",
  validate({ params: slugParamSchema }),
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
