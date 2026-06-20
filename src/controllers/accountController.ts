import type { Request, Response } from "express";
import { getAuthUserId } from "../lib/request";
import { accountDeletionService } from "../services/accountDeletionService";
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
  },

  async getDeletionRequest(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const status = await accountDeletionService.getStatus(userId);
    res.json({ data: status });
  },

  async requestDeletion(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const deletionRequest = await accountDeletionService.requestDeletion(
      userId,
      {
        reason: req.body.reason,
        clientRequestId: req.body.clientRequestId
      },
      {
        ipAddress: req.ip,
        userAgent: req.header("user-agent"),
        authSource: req.auth?.source
      }
    );

    res.status(202).json({ data: deletionRequest });
  }
};
