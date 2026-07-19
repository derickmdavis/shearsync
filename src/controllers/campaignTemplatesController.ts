import type { Request, Response } from "express";
import { campaignTemplatesService } from "../services/campaignTemplatesService";

export const campaignTemplatesController = {
  async list(req: Request, res: Response) {
    const query = req.query as unknown as {
      status: "active" | "inactive" | "all";
      limit: number;
      cursor?: string;
    };
    res.json(await campaignTemplatesService.list(query));
  }
};
