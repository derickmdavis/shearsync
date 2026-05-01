import type { Request, Response } from "express";
import { getAuthUserId, getRequiredParam } from "../lib/request";
import { photosService } from "../services/photosService";

export const photosController = {
  async listByClient(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const photos = await photosService.listByClient(userId, getRequiredParam(req, "id"));
    res.json({ data: photos });
  },

  async create(req: Request, res: Response) {
    const userId = await getAuthUserId(req);
    const photo = await photosService.create(userId, req.body);
    res.status(201).json({
      data: photo,
      upload: {
        storage_provider: "supabase",
        expected_file_path: photo.file_path,
        status: "metadata_recorded"
      }
    });
  }
};
