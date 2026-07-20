import type { Request, Response } from "express";
import { getAuthUserId } from "../lib/request";
import { insightsService } from "../services/insightsService";
import type { InsightsQuery } from "../validators/insightsValidators";

export const insightsController = {
  async get(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    res.setHeader("Cache-Control", "private, max-age=30, stale-while-revalidate=60");
    const response = await insightsService.getForUser(userId, req.query as unknown as InsightsQuery);
    res.json({ data: response });
  }
};
