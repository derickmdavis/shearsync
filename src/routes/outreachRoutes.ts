import { Router } from "express";
import { outreachController } from "../controllers/outreachController";
import { asyncHandler } from "../lib/asyncHandler";
import { validate } from "../middleware/validate";
import {
  cancelScheduledOutreachSchema,
  listScheduledOutreachQuerySchema,
  scheduledOutreachIdParamSchema
} from "../validators/outreachScheduledSendsValidators";

export const outreachRouter = Router();

outreachRouter.get("/config", asyncHandler(outreachController.getConfig));

outreachRouter.get(
  "/automations",
  asyncHandler(outreachController.getAutomations)
);

outreachRouter.get(
  "/scheduled-sends",
  validate({ query: listScheduledOutreachQuerySchema }),
  asyncHandler(outreachController.listScheduledSends)
);

outreachRouter.post(
  "/scheduled-sends/:id/cancel",
  validate({ params: scheduledOutreachIdParamSchema, body: cancelScheduledOutreachSchema }),
  asyncHandler(outreachController.cancelScheduledSend)
);
