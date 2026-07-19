import { Router } from "express";
import { campaignTemplatesController } from "../controllers/campaignTemplatesController";
import { asyncHandler } from "../lib/asyncHandler";
import { validate } from "../middleware/validate";
import { listCampaignTemplatesQuerySchema } from "../validators/campaignDraftValidators";

export const campaignTemplateRouter = Router();
campaignTemplateRouter.get("/", validate({ query: listCampaignTemplatesQuerySchema }), asyncHandler(campaignTemplatesController.list));
