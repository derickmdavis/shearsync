import { Router } from "express";
import { activityController } from "../controllers/activityController";
import { asyncHandler } from "../lib/asyncHandler";
import { validate } from "../middleware/validate";
import { listActivityQuerySchema } from "../validators/activityValidators";

export const activityRouter = Router();

activityRouter.get("/", validate({ query: listActivityQuerySchema }), asyncHandler(activityController.list));
