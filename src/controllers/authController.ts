import type { Request, Response } from "express";
import { getCurrentUser } from "../lib/request";

export const authController = {
  async getMe(req: Request, res: Response) {
    const profile = await getCurrentUser(req);

    res.json({
      auth: req.auth,
      auth_user: req.user,
      profile
    });
  }
};
