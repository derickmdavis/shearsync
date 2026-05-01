import { Router } from "express";
import { clientActionsController } from "../controllers/clientActionsController";
import { asyncHandler } from "../lib/asyncHandler";

export const clientActionsRouter = Router();

clientActionsRouter.get("/", asyncHandler(clientActionsController.getSummary));
