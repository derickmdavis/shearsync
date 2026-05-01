import type { Request, Response } from "express";
import { getAuthUserId } from "../lib/request";
import { activityEventsService } from "../services/activityEventsService";

export const activityController = {
  async list(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const response = await activityEventsService.getFeed(userId, {
      limit: Number(req.query.limit),
      cursor: req.query.cursor as string | undefined,
      activity_type: req.query.activity_type as
        | "booking_created"
        | "appointment_cancelled"
        | "appointment_rescheduled"
        | "reminder_sent"
        | undefined,
      start_date: req.query.start_date as string | undefined,
      end_date: req.query.end_date as string | undefined
    });

    res.json({ data: response });
  }
};
