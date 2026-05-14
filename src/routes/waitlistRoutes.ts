import { Router } from "express";
import { waitlistController } from "../controllers/waitlistController";
import { asyncHandler } from "../lib/asyncHandler";
import { validate } from "../middleware/validate";
import { uuidParamSchema } from "../validators/common";
import {
  createStylistWaitlistEntrySchema,
  listWaitlistQuerySchema,
  updateWaitlistEntrySchema
} from "../validators/waitlistValidators";

export const waitlistRouter = Router();

waitlistRouter.get("/", validate({ query: listWaitlistQuerySchema }), asyncHandler(waitlistController.list));
waitlistRouter.post("/", validate({ body: createStylistWaitlistEntrySchema }), asyncHandler(waitlistController.create));
waitlistRouter.get("/:id", validate({ params: uuidParamSchema }), asyncHandler(waitlistController.get));
waitlistRouter.patch(
  "/:id",
  validate({ params: uuidParamSchema, body: updateWaitlistEntrySchema }),
  asyncHandler(waitlistController.update)
);
waitlistRouter.delete("/:id", validate({ params: uuidParamSchema }), asyncHandler(waitlistController.delete));

