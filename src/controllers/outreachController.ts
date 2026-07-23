import type { Request, Response } from "express";
import type { ScheduledOutreachKind, ScheduledOutreachStatus } from "../lib/outreachContracts";
import { getAuthUserId, getRequiredParam } from "../lib/request";
import { outreachScheduledSendsService } from "../services/outreachScheduledSendsService";
import { outreachAutomationsService } from "../services/outreachAutomationsService";
import { businessTimeZoneService } from "../services/businessTimeZoneService";
import {
  CAMPAIGN_LINK_TYPES,
  CAMPAIGN_MAXIMUM_SCHEDULE_HORIZON_MONTHS,
  CAMPAIGN_MESSAGE_MAX_LENGTH,
  CAMPAIGN_MINIMUM_SCHEDULE_LEAD_MINUTES,
  CAMPAIGN_MISSING_FIRST_NAME_FALLBACK,
  CAMPAIGN_NAME_MAX_LENGTH,
  CAMPAIGN_PERSONALIZATION_TOKENS,
  CAMPAIGN_SUBJECT_MAX_LENGTH
} from "../lib/outreachContracts";

export const outreachController = {
  async getConfig(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    res.json({
      campaign: {
        name_max_length: CAMPAIGN_NAME_MAX_LENGTH,
        subject_max_length: CAMPAIGN_SUBJECT_MAX_LENGTH,
        message_max_length: CAMPAIGN_MESSAGE_MAX_LENGTH,
        supported_tokens: [...CAMPAIGN_PERSONALIZATION_TOKENS],
        missing_first_name_fallback: CAMPAIGN_MISSING_FIRST_NAME_FALLBACK,
        link_types: [...CAMPAIGN_LINK_TYPES],
        minimum_schedule_lead_minutes: CAMPAIGN_MINIMUM_SCHEDULE_LEAD_MINUTES,
        maximum_schedule_horizon_months: CAMPAIGN_MAXIMUM_SCHEDULE_HORIZON_MONTHS,
        cancellation_cutoff: "before_sending",
        timezone: await businessTimeZoneService.getForUser(userId)
      }
    });
  },

  async getAutomations(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    res.json(await outreachAutomationsService.getForUser(userId));
  },

  async listScheduledSends(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const query = req.query as unknown as {
      status: ScheduledOutreachStatus;
      kind?: ScheduledOutreachKind[];
      window?: "today_tomorrow";
      limit: number;
      cursor?: string;
    };
    const response = await outreachScheduledSendsService.listForUser(userId, {
      status: query.status,
      kinds: query.kind,
      window: query.window,
      limit: query.limit,
      cursor: query.cursor
    });

    res.json(response);
  },

  async cancelScheduledSend(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const response = await outreachScheduledSendsService.cancelForUser(
      userId,
      getRequiredParam(req, "id"),
      req.body.reason
    );

    res.json({ data: response });
  }
};
