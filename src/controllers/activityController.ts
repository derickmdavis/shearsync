import type { Request, Response } from "express";
import type { ActivityCategory, ActivityType } from "../lib/activityTypes";
import { getAuthUserId, getRequiredParam } from "../lib/request";
import { activityDashboardService } from "../services/activityDashboardService";
import { activityEventsService } from "../services/activityEventsService";
import { birthdayRemindersService } from "../services/birthdayRemindersService";
import { referralLinksService, type ActivityReferralStatsRange } from "../services/referralLinksService";

export const activityController = {
  async dashboard(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const response = await activityDashboardService.getDashboard(userId);
    res.json({ data: response });
  },

  async list(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const response = await activityEventsService.getFeed(userId, {
      limit: Number(req.query.limit),
      cursor: req.query.cursor as string | undefined,
      category: req.query.category as ActivityCategory | undefined,
      activity_type: req.query.activity_type as ActivityType | undefined,
      start_date: req.query.start_date as string | undefined,
      end_date: req.query.end_date as string | undefined
    });

    res.json({ data: response });
  },

  async recentCancellations(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const response = await activityEventsService.getRecentCancellations(userId, {
      windowHours: Number(req.query.window_hours)
    });

    res.json({ data: response });
  },

  async referralStats(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const response = await referralLinksService.getActivityReferralStats(userId, {
      range: req.query.range as ActivityReferralStatsRange | undefined
    });

    res.json({ data: response });
  },

  async listBirthdayReminders(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const query = req.query as unknown as { limit: number; cursor?: string; status?: "pending_approval" | "queued" };
    const response = await birthdayRemindersService.listForUser(userId, {
      limit: query.limit,
      cursor: query.cursor,
      status: query.status
    });

    res.json({
      data: response.data,
      next_cursor: response.next_cursor
    });
  },

  async cancelBirthdayReminder(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const reminder = await birthdayRemindersService.cancelForUser(
      userId,
      getRequiredParam(req, "reminder_id"),
      "User chose not to send this year's birthday email"
    );

    res.json({ data: reminder });
  },

  async updateAutomationSetting(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const setting = await activityDashboardService.updateAutomationSetting(
      userId,
      req.params.key as string,
      Boolean(req.body.enabled)
    );

    res.json({ data: setting });
  }
};
