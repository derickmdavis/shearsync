import type { Request, Response } from "express";
import { getAuthUserId, getRequiredParam } from "../lib/request";
import { campaignDraftsService } from "../services/campaignDraftsService";
import { campaignPreviewValidationService } from "../services/campaignPreviewValidationService";
import { campaignSubmissionService } from "../services/campaignSubmissionService";
import { ApiError } from "../lib/errors";
import { entitlementsService } from "../services/entitlementsService";

const getIdempotencyKey = (req: Request): string => {
  const key = req.header("Idempotency-Key")?.trim();
  if (!key || key.length > 200) {
    throw new ApiError(400, "Idempotency-Key header is required and must be at most 200 characters");
  }
  return key;
};

export const campaignDraftsController = {
  async create(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    await entitlementsService.assertFeatureAllowed(userId, "emailCampaigns");
    res.status(201).json({ data: await campaignDraftsService.createForUser(userId, req.body.template_id) });
  },
  async get(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    res.json({ data: await campaignDraftsService.getForUser(userId, getRequiredParam(req, "id")) });
  },
  async update(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    await entitlementsService.assertFeatureAllowed(userId, "emailCampaigns");
    res.json({ data: await campaignDraftsService.updateForUser(userId, getRequiredParam(req, "id"), req.body) });
  },
  async preview(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    await entitlementsService.assertFeatureAllowed(userId, "emailCampaigns");
    res.json({ data: await campaignPreviewValidationService.previewForUser(userId, getRequiredParam(req, "id"), req.body.first_name) });
  },
  async validate(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    await entitlementsService.assertFeatureAllowed(userId, "emailCampaigns");
    res.json({ data: await campaignPreviewValidationService.validateForUser(userId, getRequiredParam(req, "id"), req.body.revision) });
  },
  async schedule(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    await entitlementsService.assertFeatureAllowed(userId, "emailCampaigns");
    res.json({ data: await campaignSubmissionService.submitForUser({
      userId,
      campaignId: getRequiredParam(req, "id"),
      revision: req.body.revision,
      validationToken: req.body.validation_token,
      idempotencyKey: getIdempotencyKey(req),
      expectedSendMode: "scheduled"
    }) });
  },
  async sendNow(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    await entitlementsService.assertFeatureAllowed(userId, "emailCampaigns");
    res.json({ data: await campaignSubmissionService.submitForUser({
      userId,
      campaignId: getRequiredParam(req, "id"),
      revision: req.body.revision,
      validationToken: req.body.validation_token,
      idempotencyKey: getIdempotencyKey(req),
      expectedSendMode: "now"
    }) });
  },
  async delete(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    await campaignDraftsService.deleteForUser(userId, getRequiredParam(req, "id"));
    res.status(204).send();
  }
};
