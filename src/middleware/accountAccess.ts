import type { NextFunction, Request, Response } from "express";
import { getAuthUserId } from "../lib/request";
import { accountAccessService } from "../services/accountAccessService";

export const requireActiveAccount = async (req: Request, _res: Response, next: NextFunction) => {
  try {
    await accountAccessService.assertAccountActive(await getAuthUserId(req));
    next();
  } catch (error) {
    next(error);
  }
};
