import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler";
import { schemaReadinessService } from "../services/schemaReadinessService";

export const healthRouter = Router();

healthRouter.get("/health", asyncHandler(async (_req, res) => {
  await schemaReadinessService.assertReady();
  res.status(200).json({ status: "ok" });
}));
