import type { Request, Response } from "express";
import { getAuthUserId } from "../lib/request";
import { entitlementsService } from "../services/entitlementsService";

export const accountController = {
  async getPlan(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const plan = await entitlementsService.getEntitlementsForUser(userId);
    res.json({ data: plan });
  },

  async updatePlan(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const plan = await entitlementsService.updatePlanForUser(userId, {
      tier: req.body.tier,
      status: req.body.status
    });
    res.json({ data: plan });
  }
};
