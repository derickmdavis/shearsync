import type { Request, Response } from "express";
import { getAuthUserId, getRequiredParam } from "../lib/request";
import { clientFormulasService } from "../services/clientFormulasService";

export const clientFormulasController = {
  async list(req: Request, res: Response) { const userId = await getAuthUserId(req); const result = await clientFormulasService.list(userId, getRequiredParam(req, "id"), req.query); res.json(result); },
  async create(req: Request, res: Response) { const userId = await getAuthUserId(req); const data = await clientFormulasService.create(userId, getRequiredParam(req, "id"), req.body); res.status(201).json({ data }); },
  async get(req: Request, res: Response) { const userId = await getAuthUserId(req); res.json({ data: await clientFormulasService.detail(userId, getRequiredParam(req, "id"), getRequiredParam(req, "formulaId")) }); },
  async update(req: Request, res: Response) { const userId = await getAuthUserId(req); res.json({ data: await clientFormulasService.update(userId, getRequiredParam(req, "id"), getRequiredParam(req, "formulaId"), req.body) }); },
  async duplicate(req: Request, res: Response) { const userId = await getAuthUserId(req); const data = await clientFormulasService.duplicate(userId, getRequiredParam(req, "id"), getRequiredParam(req, "formulaId")); res.status(201).json({ data }); },
  async remove(req: Request, res: Response) { const userId = await getAuthUserId(req); await clientFormulasService.remove(userId, getRequiredParam(req, "id"), getRequiredParam(req, "formulaId")); res.status(204).send(); },
  async uploadIntent(req: Request, res: Response) { const userId = await getAuthUserId(req); const data = await clientFormulasService.createUploadIntent(userId, getRequiredParam(req, "id"), getRequiredParam(req, "formulaId"), req.body); res.status(201).json({ data }); },
  async finalize(req: Request, res: Response) { const userId = await getAuthUserId(req); const data = await clientFormulasService.finalizeUpload(userId, getRequiredParam(req, "id"), getRequiredParam(req, "formulaId"), req.body); res.status(201).json({ data }); },
  async attachPhoto(req: Request, res: Response) { const userId = await getAuthUserId(req); const data = await clientFormulasService.attachPhoto(userId, getRequiredParam(req, "id"), getRequiredParam(req, "formulaId"), req.body); res.status(201).json({ data }); },
  async removePhoto(req: Request, res: Response) { const userId = await getAuthUserId(req); await clientFormulasService.removePhoto(userId, getRequiredParam(req, "id"), getRequiredParam(req, "formulaId"), getRequiredParam(req, "photoId")); res.status(204).send(); },
  async reorderPhotos(req: Request, res: Response) { const userId = await getAuthUserId(req); res.json({ data: await clientFormulasService.reorderPhotos(userId, getRequiredParam(req, "id"), getRequiredParam(req, "formulaId"), req.body.photo_ids) }); }
};
