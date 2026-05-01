import type { Request, Response } from "express";
import { getAuthUserId, getRequiredParam } from "../lib/request";
import { servicesService } from "../services/servicesService";

export const servicesController = {
  async list(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const services = await servicesService.listByUserId(userId);
    res.json({ data: services });
  },

  async create(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const service = await servicesService.create(userId, req.body);
    res.status(201).json({ data: service });
  },

  async update(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const service = await servicesService.update(userId, getRequiredParam(req, "id"), req.body);
    res.json({ data: service });
  },

  async delete(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    await servicesService.delete(userId, getRequiredParam(req, "id"));
    res.status(204).send();
  },

  async reorder(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const services = await servicesService.reorder(userId, req.body.serviceIds);
    res.json({ data: services });
  }
};
