import type { Request, Response } from "express";
import { getAuthUserId, getRequiredParam } from "../lib/request";
import { remindersService } from "../services/remindersService";

export const remindersController = {
  async list(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const reminders = await remindersService.list(userId);
    res.json({ data: reminders });
  },

  async create(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const reminder = await remindersService.create(userId, req.body);
    res.status(201).json({ data: reminder });
  },

  async update(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const reminder = await remindersService.update(userId, getRequiredParam(req, "id"), req.body);
    res.json({ data: reminder });
  }
};
