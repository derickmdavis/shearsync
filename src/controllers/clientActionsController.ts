import type { Request, Response } from "express";
import { getAuthUserId } from "../lib/request";
import { clientActionsService } from "../services/clientActionsService";

export const clientActionsController = {
  async getSummary(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const summary = await clientActionsService.getSummary(userId);
    res.json({ data: summary });
  }
};
