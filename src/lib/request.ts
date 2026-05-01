import type { Request } from "express";
import { ApiError } from "./errors";
import { usersService } from "../services/usersService";
import type { Row } from "../services/db";

export const getRequiredParam = (req: Request, name: string): string => {
  const value = req.params[name];

  if (typeof value !== "string") {
    throw new ApiError(400, `Missing required route parameter: ${name}`);
  }

  return value;
};

export const getAuthUserId = async (req: Request): Promise<string> => {
  const userId = req.auth?.userId ?? req.user?.id;

  if (!userId) {
    throw new ApiError(401, "Authentication required");
  }

  await usersService.ensureAuthUser(userId, req.auth?.email ?? req.user?.email);
  return userId;
};

export const getCurrentUser = async (req: Request): Promise<Row> => {
  const userId = req.auth?.userId ?? req.user?.id;

  if (!userId) {
    throw new ApiError(401, "Authentication required");
  }

  const user =
    await usersService.ensureAuthUser(userId, req.auth?.email ?? req.user?.email)
    ?? await usersService.getById(userId);

  if (!user) {
    throw new ApiError(404, "Authenticated user not found");
  }

  return user;
};
