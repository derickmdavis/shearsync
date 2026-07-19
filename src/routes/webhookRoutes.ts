import { Router } from "express";
import { webhooksController } from "../controllers/webhooksController";
import { asyncHandler } from "../lib/asyncHandler";

export const webhookRouter = Router();
webhookRouter.post("/resend", asyncHandler(webhooksController.receiveResend));
