import type { Request, Response } from "express";
import { getAuthUserId } from "../lib/request";
import { campaignAudienceEstimateService } from "../services/campaignAudienceEstimateService";
import { campaignSubmissionService } from "../services/campaignSubmissionService";
import { campaignsService } from "../services/campaignsService";
import { getRequiredParam } from "../lib/request";

export const campaignsController = {
  async estimateAudience(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    res.json(await campaignAudienceEstimateService.estimateForUser(userId, req.body.audience));
  },
  async list(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    res.json(await campaignsService.listForUser(userId, req.query as never));
  },
  async get(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    res.json({ data: await campaignsService.getForUser(userId, getRequiredParam(req, "id")) });
  },
  async cancel(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    res.json({ data: await campaignSubmissionService.cancelForUser(userId, getRequiredParam(req, "id"), req.body.reason) });
  }
};
