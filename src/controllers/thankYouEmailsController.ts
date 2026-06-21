import type { Request, Response } from "express";
import { getAuthUserId } from "../lib/request";
import { thankYouEmailsService } from "../services/thankYouEmailsService";

export const thankYouEmailsController = {
  async list(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const query = req.query as unknown as {
      status?: Parameters<typeof thankYouEmailsService.listForUser>[1]["status"];
      limit: number;
      cursor?: string;
    };
    const response = await thankYouEmailsService.listForUser(userId, {
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
    const thankYouEmail = await thankYouEmailsService.queueManualForUser(userId, {
      appointmentId: req.body.appointment_id,
      approvalRequired: req.body.approval_required
    });

    res.status(201).json({ data: thankYouEmail });
  },

  async approve(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const thankYouEmail = await thankYouEmailsService.approveForUser(userId, req.params.id as string);
    res.json({ data: thankYouEmail });
  },

  async cancel(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const thankYouEmail = await thankYouEmailsService.cancelForUser(userId, req.params.id as string, req.body.reason);
    res.json({ data: thankYouEmail });
  }
};
