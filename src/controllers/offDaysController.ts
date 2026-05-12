import type { Request, Response } from "express";
import { getAuthUserId, getRequiredParam } from "../lib/request";
import { offDaysService } from "../services/offDaysService";

export const offDaysController = {
  async list(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const offDays = await offDaysService.listOffDays(userId, {
      startDate: req.query.startDate as string | undefined,
      endDate: req.query.endDate as string | undefined
    });
    res.json({ data: offDays });
  },

  async create(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const offDay = await offDaysService.createOffDay(userId, req.body);
    res.status(201).json({ data: offDay });
  },

  async bulkCreate(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const offDays = await offDaysService.createOffDays(userId, req.body.offDays);
    res.status(201).json({ data: offDays });
  },

  async update(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const offDay = await offDaysService.updateOffDay(userId, getRequiredParam(req, "id"), req.body);
    res.json({ data: offDay });
  },

  async delete(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    await offDaysService.deleteOffDay(userId, getRequiredParam(req, "id"));
    res.status(204).send();
  }
};
