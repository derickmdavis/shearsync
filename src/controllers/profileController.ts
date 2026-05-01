import type { Request, Response } from "express";
import { getAuthUserId } from "../lib/request";
import { profileOverviewService } from "../services/profileOverviewService";

export const profileController = {
  async getOverview(req: Request, res: Response) {
    const performancePeriod = req.query.performancePeriod === "month" ? "month" : "week";
    const userId = await getAuthUserId(req);
    const overview = await profileOverviewService.getOverview(userId, performancePeriod);
    res.json({ data: overview });
  }
};
