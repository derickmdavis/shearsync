import { Router } from "express";
import { appContentController } from "../controllers/appContentController";
import { asyncHandler } from "../lib/asyncHandler";
import { validate } from "../middleware/validate";
import { appContentBundleQuerySchema } from "../validators/appContentValidators";

export const appContentRouter = Router();

appContentRouter.get("/", validate({ query: appContentBundleQuerySchema }), asyncHandler(appContentController.getPublishedBundle));
