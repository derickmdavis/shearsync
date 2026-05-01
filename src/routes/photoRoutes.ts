import { Router } from "express";
import { photosController } from "../controllers/photosController";
import { asyncHandler } from "../lib/asyncHandler";
import { validate } from "../middleware/validate";
import { createPhotoSchema } from "../validators/photoValidators";

export const photoRouter = Router();

photoRouter.post("/", validate({ body: createPhotoSchema }), asyncHandler(photosController.create));

