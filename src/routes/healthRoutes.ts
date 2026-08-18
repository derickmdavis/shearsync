import { Router, type Request, type Response } from "express";
import { asyncHandler } from "../lib/asyncHandler";
import { schemaReadinessService } from "../services/schemaReadinessService";

export const healthRouter = Router();

export const livenessHandler = (_req: Request, res: Response): void => {
  res.status(200).json({ status: "ok" });
};

export const readinessHandler = async (_req: Request, res: Response): Promise<void> => {
  const readiness = await schemaReadinessService.assertReadyCached();
  res.status(200).json({ status: "ok", ...readiness });
};

healthRouter.get("/health", livenessHandler);
healthRouter.get("/health/ready", asyncHandler(readinessHandler));
