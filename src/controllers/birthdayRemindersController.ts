import type { Request, Response } from "express";
import { getAuthUserId } from "../lib/request";
import { birthdayRemindersService } from "../services/birthdayRemindersService";

export const birthdayRemindersController = {
  async approve(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const reminder = await birthdayRemindersService.approveForUser(userId, req.params.id as string);
    res.json({ data: reminder });
  },

  async cancel(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const reminder = await birthdayRemindersService.cancelForUser(userId, req.params.id as string, req.body.reason);
    res.json({ data: reminder });
  }
};
