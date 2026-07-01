import type { Request, Response } from "express";
import { getAuthUserId, getRequiredParam } from "../lib/request";
import { appointmentImagesService } from "../services/appointmentImagesService";

export const appointmentImagesController = {
  async prefetchThumbnails(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const result = await appointmentImagesService.prefetchThumbnails(userId, req.query);
    res.json({ data: result.appointments, meta: result.meta });
  },

  async listClientVisualHistory(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const result = await appointmentImagesService.listClientVisualHistory(
      userId,
      getRequiredParam(req, "id"),
      req.query
    );
    res.json(result);
  },

  async list(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const images = await appointmentImagesService.list(userId, getRequiredParam(req, "id"));
    res.json({ data: images });
  },

  async createUploadIntent(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const intent = await appointmentImagesService.createUploadIntent(userId, getRequiredParam(req, "id"), req.body);
    res.status(201).json({ data: intent });
  },

  async finalize(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const image = await appointmentImagesService.finalize(userId, getRequiredParam(req, "id"), req.body);
    res.status(201).json({ data: image });
  },

  async getDisplayUrl(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const result = await appointmentImagesService.getDisplayUrl(
      userId,
      getRequiredParam(req, "id"),
      getRequiredParam(req, "imageId")
    );
    res.json({ data: result });
  },

  async update(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const image = await appointmentImagesService.update(
      userId,
      getRequiredParam(req, "id"),
      getRequiredParam(req, "imageId"),
      req.body
    );
    res.json({ data: image });
  },

  async remove(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    await appointmentImagesService.remove(
      userId,
      getRequiredParam(req, "id"),
      getRequiredParam(req, "imageId")
    );
    res.status(204).send();
  },

  async reorder(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const images = await appointmentImagesService.reorder(
      userId,
      getRequiredParam(req, "id"),
      req.body.image_ids as string[]
    );
    res.json({ data: images });
  }
};
