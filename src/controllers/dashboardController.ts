import type { Request, Response } from "express";
import { getAuthUserId } from "../lib/request";
import { dashboardService } from "../services/dashboardService";

export const dashboardController = {
  async getSummary(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const summary = await dashboardService.getSummary(userId);
    res.json({ data: summary });
  }
};
