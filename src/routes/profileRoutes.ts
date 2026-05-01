import { Router } from "express";
import { profileController } from "../controllers/profileController";
import { asyncHandler } from "../lib/asyncHandler";
import { validate } from "../middleware/validate";
import { profileOverviewQuerySchema } from "../validators/profileValidators";

export const profileRouter = Router();

profileRouter.get("/overview", validate({ query: profileOverviewQuerySchema }), asyncHandler(profileController.getOverview));
