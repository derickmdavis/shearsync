import type { Request, Response } from "express";
import { getAuthUserId } from "../lib/request";
import { accountDeletionService } from "../services/accountDeletionService";
import { accountAccessService } from "../services/accountAccessService";

export const accountController = {
  async getAccess(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    res.json({ data: await accountAccessService.getAccountAccess(userId) });
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
