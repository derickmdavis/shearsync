import type { Request, Response } from "express";
import { env } from "../config/env";
import { campaignDeliveryAnalyticsService } from "../services/campaignDeliveryAnalyticsService";

export const webhooksController = {
  async receiveResend(req: Request, res: Response) {
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    const eventId = req.header("svix-id") ?? "";
    campaignDeliveryAnalyticsService.assertValidResendWebhook(rawBody, {
      id: eventId,
      timestamp: req.header("svix-timestamp") ?? undefined,
      signature: req.header("svix-signature") ?? undefined
    }, env.RESEND_WEBHOOK_SECRET);
    const result = await campaignDeliveryAnalyticsService.recordResendWebhook(req.body, eventId);
    res.status(202).json({ data: result });
  }
};
