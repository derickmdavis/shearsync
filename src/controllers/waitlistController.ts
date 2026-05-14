import type { Request, Response } from "express";
import { getAuthUserId, getRequiredParam } from "../lib/request";
import { waitlistService } from "../services/waitlistService";

export const waitlistController = {
  async list(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const featureAvailable = await waitlistService.canUseWaitlistForUser(userId);

    if (!featureAvailable) {
      res.json({
        data: [],
        meta: {
          featureAvailable: false,
          requiredPlan: "pro"
        }
      });
      return;
    }

    const entries = await waitlistService.listWaitlistEntries(userId, {
      status: req.query.status as never,
      startDate: req.query.startDate as string | undefined,
      endDate: req.query.endDate as string | undefined,
      serviceId: req.query.serviceId as string | undefined,
      limit: req.query.limit as number | undefined
    });

    res.json({
      data: entries,
      meta: {
        featureAvailable: true
      }
    });
  },

  async get(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const entry = await waitlistService.getWaitlistEntry(userId, getRequiredParam(req, "id"));
    res.json({ data: entry });
  },

  async create(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const entry = await waitlistService.createStylistWaitlistEntry(userId, req.body);
    res.status(201).json({ data: entry });
  },

  async update(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const entry = await waitlistService.updateWaitlistEntry(userId, getRequiredParam(req, "id"), req.body);
    res.json({ data: entry });
  },

  async delete(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    await waitlistService.deleteWaitlistEntry(userId, getRequiredParam(req, "id"));
    res.status(204).send();
  }
};

