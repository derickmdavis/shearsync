import type { Request, Response } from "express";
import { getAuthUserId } from "../lib/request";
import { inAppFeedbackService } from "../services/inAppFeedbackService";

export const feedbackController = {
  async create(req: Request, res: Response) {
    const feedback = await inAppFeedbackService.createForUser(await getAuthUserId(req), {
      rating: req.body.rating,
      feedbackText: req.body.feedback
    });

    res.status(201).json({ data: feedback });
  }
};
