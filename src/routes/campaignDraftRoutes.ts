import { Router } from "express";
import { campaignDraftsController } from "../controllers/campaignDraftsController";
import { asyncHandler } from "../lib/asyncHandler";
import { validate } from "../middleware/validate";
import {
  campaignDraftIdParamSchema,
  createCampaignDraftSchema,
  previewCampaignDraftSchema,
  submitCampaignDraftSchema,
  validateCampaignDraftSchema,
  updateCampaignDraftSchema
} from "../validators/campaignDraftValidators";

export const campaignDraftRouter = Router();
campaignDraftRouter.post("/", validate({ body: createCampaignDraftSchema }), asyncHandler(campaignDraftsController.create));
campaignDraftRouter.post("/:id/preview", validate({ params: campaignDraftIdParamSchema, body: previewCampaignDraftSchema }), asyncHandler(campaignDraftsController.preview));
campaignDraftRouter.post("/:id/validate", validate({ params: campaignDraftIdParamSchema, body: validateCampaignDraftSchema }), asyncHandler(campaignDraftsController.validate));
campaignDraftRouter.post("/:id/schedule", validate({ params: campaignDraftIdParamSchema, body: submitCampaignDraftSchema }), asyncHandler(campaignDraftsController.schedule));
campaignDraftRouter.post("/:id/send", validate({ params: campaignDraftIdParamSchema, body: submitCampaignDraftSchema }), asyncHandler(campaignDraftsController.sendNow));
campaignDraftRouter.get("/:id", validate({ params: campaignDraftIdParamSchema }), asyncHandler(campaignDraftsController.get));
campaignDraftRouter.patch("/:id", validate({ params: campaignDraftIdParamSchema, body: updateCampaignDraftSchema }), asyncHandler(campaignDraftsController.update));
campaignDraftRouter.delete("/:id", validate({ params: campaignDraftIdParamSchema }), asyncHandler(campaignDraftsController.delete));
