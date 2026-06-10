import type { Request, Response } from "express";
import { appointmentEmailDeliveryService } from "../services/appointmentEmailDeliveryService";
import { rebookNudgesService } from "../services/rebookNudgesService";

export const internalController = {
  async processAppointmentEmails(req: Request, res: Response) {
    const query = req.query as {
      limit?: number;
      allow_noop?: boolean;
    };
    const result = await appointmentEmailDeliveryService.processQueuedAppointmentEmails({
      limit: typeof query.limit === "number" ? query.limit : undefined,
      allowNoopProvider: query.allow_noop === true
    });

    res.json({ data: result });
  },

  async queueRebookNudges(req: Request, res: Response) {
    const query = req.query as { limit?: number };
    const result = await rebookNudgesService.queueDueNudges(new Date(), query.limit);
    res.json({ data: result });
  },

  async processRebookNudges(req: Request, res: Response) {
    const query = req.query as { limit?: number };
    const result = await rebookNudgesService.processQueuedNudgeEmails(new Date(), query.limit);
    res.json({ data: result });
  }
};
