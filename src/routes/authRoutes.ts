import { Router } from "express";
import { authController } from "../controllers/authController";
import { asyncHandler } from "../lib/asyncHandler";

export const authRouter = Router();

authRouter.get("/me", asyncHandler(authController.getMe));
authRouter.post("/me/open", asyncHandler(authController.recordAppOpen));
