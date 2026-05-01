import type { Request, Response } from "express";
import { getAuthUserId } from "../lib/request";
import { calendarService } from "../services/calendarService";

export const calendarController = {
  async getDay(req: Request, res: Response) {
    const date = req.query.date as string;
    const userId = await getAuthUserId(req);
    const day = await calendarService.getDay(userId, date);
    res.json(day);
  }
};
