import { Router } from "express";
import { feedbackController } from "../controllers/feedbackController";
import { asyncHandler } from "../lib/asyncHandler";
import { feedbackSubmissionRateLimiter } from "../middleware/rateLimit";
import { validate } from "../middleware/validate";
import { createInAppFeedbackSchema } from "../validators/feedbackValidators";

export const feedbackRouter = Router();

feedbackRouter.post(
  "/",
  feedbackSubmissionRateLimiter,
  validate({ body: createInAppFeedbackSchema }),
  asyncHandler(feedbackController.create)
);
