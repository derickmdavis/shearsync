import { Router } from "express";
import { dashboardController } from "../controllers/dashboardController";
import { asyncHandler } from "../lib/asyncHandler";

export const dashboardRouter = Router();

dashboardRouter.get("/", asyncHandler(dashboardController.getSummary));

