import { Router } from "express";
import { campaignsController } from "../controllers/campaignsController";
import { asyncHandler } from "../lib/asyncHandler";
import { validate } from "../middleware/validate";
import { cancelCampaignSchema, campaignIdParamSchema, estimateCampaignAudienceSchema, listCampaignsQuerySchema } from "../validators/campaignAudienceValidators";

export const campaignRouter = Router();
campaignRouter.post(
  "/audience/estimate",
  validate({ body: estimateCampaignAudienceSchema }),
  asyncHandler(campaignsController.estimateAudience)
);
campaignRouter.get("/", validate({ query: listCampaignsQuerySchema }), asyncHandler(campaignsController.list));
campaignRouter.get("/:id", validate({ params: campaignIdParamSchema }), asyncHandler(campaignsController.get));
campaignRouter.post("/:id/cancel", validate({ params: campaignIdParamSchema, body: cancelCampaignSchema }), asyncHandler(campaignsController.cancel));
