import type { Request, Response } from "express";
import { getAuthUserId, getRequiredParam } from "../lib/request";
import { paymentMethodsService } from "../services/paymentMethodsService";

export const paymentMethodsController = {
  async list(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const methods = await paymentMethodsService.list(userId, (req.query as { include_inactive?: boolean }).include_inactive === true);
    res.json({ data: methods });
  },

  async create(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const method = await paymentMethodsService.create(userId, req.body);
    res.status(201).json({ data: method });
  },

  async update(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const method = await paymentMethodsService.update(userId, getRequiredParam(req, "id"), req.body);
    res.json({ data: method });
  },

  async remove(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const method = await paymentMethodsService.remove(userId, getRequiredParam(req, "id"));
    res.json({ data: method });
  },

  async reorder(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const methods = await paymentMethodsService.reorder(userId, req.body.items);
    res.json({ data: methods });
  },

  async createQrUploadIntent(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const intent = await paymentMethodsService.createQrUploadIntent(userId, req.body);
    res.status(201).json({ data: intent });
  }
};
