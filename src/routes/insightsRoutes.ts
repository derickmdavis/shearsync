import { Router } from "express";
import { insightsController } from "../controllers/insightsController";
import { asyncHandler } from "../lib/asyncHandler";
import { validate } from "../middleware/validate";
import { insightsQuerySchema } from "../validators/insightsValidators";

export const insightsRouter = Router();

insightsRouter.get("/", validate({ query: insightsQuerySchema }), asyncHandler(insightsController.get));
