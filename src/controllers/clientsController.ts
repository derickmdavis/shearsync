import type { Request, Response } from "express";
import { getAuthUserId, getRequiredParam } from "../lib/request";
import { clientsService } from "../services/clientsService";

export const clientsController = {
  async list(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const clients = await clientsService.list(userId);
    res.json({ data: clients });
  },

  async create(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const client = await clientsService.create(userId, req.body);
    res.status(201).json({ data: client });
  },

  async getById(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const client = await clientsService.getById(userId, getRequiredParam(req, "id"));
    res.json({ data: client });
  },

  async update(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const client = await clientsService.update(userId, getRequiredParam(req, "id"), req.body);
    res.json({ data: client });
  },

  async remove(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    await clientsService.remove(userId, getRequiredParam(req, "id"));
    res.status(204).send();
  }
};
