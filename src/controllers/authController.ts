import type { Request, Response } from "express";
import { getAuthUserId, getCurrentUser } from "../lib/request";
import { recordProductTelemetry } from "../services/productTelemetry";

export const authController = {
  async getMe(req: Request, res: Response) {
    const profile = await getCurrentUser(req);

    res.json({
      auth: req.auth,
      auth_user: req.user,
      profile
    });
  },

  async recordAppOpen(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    await recordProductTelemetry({
      accountUserId: userId,
      actorUserId: userId,
      eventType: "user_opened_app",
      eventSource: "frontend",
      sessionId: typeof req.body?.session_id === "string" ? req.body.session_id : null,
      anonymousId: typeof req.body?.anonymous_id === "string" ? req.body.anonymous_id : null,
      metadata: {
        source: "app_open",
        platform: typeof req.body?.platform === "string" ? req.body.platform : null
      }
    });

    res.status(202).json({ data: { recorded: true } });
  }
};
