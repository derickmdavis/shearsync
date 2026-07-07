import type { Request, Response } from "express";
import { getAuthUserId, getRequiredParam } from "../lib/request";
import { clientRebookingPreferencesService } from "../services/clientRebookingPreferencesService";
import { clientsDetailService } from "../services/clientsDetailService";
import { clientsService } from "../services/clientsService";
import { referralLinksService, type ReferralSource } from "../services/referralLinksService";

export const clientsController = {
  async list(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const result = await clientsService.list(userId, req.query);
    res.json(result);
  },

  async create(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const client = await clientsService.create(userId, req.body);
    res.status(201).json({ data: client });
  },

  async getById(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const client = await clientsService.getById(userId, getRequiredParam(req, "id"));
    res.json({ data: client });
  },

  async getDetail(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const detail = await clientsDetailService.getDetail(userId, getRequiredParam(req, "id"));
    res.json({ data: detail });
  },

  async update(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const client = await clientsService.update(userId, getRequiredParam(req, "id"), req.body);
    res.json({ data: client });
  },

  async updateAvatar(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const clientId = getRequiredParam(req, "id");
    await clientsService.updateAvatar(userId, clientId, req.body.avatar_image_id);
    const detail = await clientsDetailService.getDetail(userId, clientId);
    res.json({ data: detail.identity });
  },

  async updateRebookingPreference(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const clientId = getRequiredParam(req, "id");
    await clientRebookingPreferencesService.updateForClient(userId, clientId, req.body);
    const detail = await clientsDetailService.getDetail(userId, clientId);
    res.json({ data: detail.rebooking_preference });
  },

  async remove(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    await clientsService.remove(userId, getRequiredParam(req, "id"));
    res.status(204).send();
  },

  async reactivate(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const client = await clientsService.reactivate(userId, getRequiredParam(req, "id"));
    res.json({ data: client });
  },

  async getReferralLink(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const link = await referralLinksService.getForClient(userId, getRequiredParam(req, "id"));
    res.json({ data: link });
  },

  async createReferralLink(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const link = await referralLinksService.getOrCreateForClient(userId, getRequiredParam(req, "id"), {
      source: typeof req.body.source === "string" ? req.body.source as ReferralSource : undefined
    });
    res.status(201).json({ data: link });
  },

  async getReferralStats(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const stats = await referralLinksService.getClientReferralStats(userId, getRequiredParam(req, "id"));
    res.json({ data: stats });
  }
};
