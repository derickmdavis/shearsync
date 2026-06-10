import type { Request, Response } from "express";
import { getAuthUserId } from "../lib/request";
import { rebookNudgesService } from "../services/rebookNudgesService";

export const rebookNudgesController = {
  async list(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const query = req.query as unknown as {
      status?: Parameters<typeof rebookNudgesService.listForUser>[1]["status"];
      limit: number;
      cursor?: string;
    };
    const response = await rebookNudgesService.listForUser(userId, {
      status: query.status,
      limit: query.limit,
      cursor: query.cursor
    });

    res.json({
      data: response.data,
      next_cursor: response.next_cursor
    });
  },

  async create(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const nudge = await rebookNudgesService.queueManualForUser(userId, {
      clientId: req.body.client_id,
      rebookIntervalDays: req.body.rebook_interval_days,
      approvalRequired: req.body.approval_required
    });

    res.status(201).json({ data: nudge });
  },

  async approve(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const nudge = await rebookNudgesService.approveForUser(userId, req.params.id as string);
    res.json({ data: nudge });
  },

  async cancel(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const nudge = await rebookNudgesService.cancelForUser(userId, req.params.id as string, req.body.reason);
    res.json({ data: nudge });
  }
};
