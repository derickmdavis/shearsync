import { timingSafeEqual } from "crypto";
import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env";
import { ApiError } from "../lib/errors";

const getSecretBuffer = (value: string): Buffer => Buffer.from(value, "utf8");

const secretsMatch = (provided: string, expected: string): boolean => {
  const providedBuffer = getSecretBuffer(provided);
  const expectedBuffer = getSecretBuffer(expected);

  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(providedBuffer, expectedBuffer);
};

export const requireInternalApiSecret = (req: Request, _res: Response, next: NextFunction): void => {
  if (!env.INTERNAL_API_SECRET) {
    next(new ApiError(503, "Internal API secret is not configured"));
    return;
  }

  const providedSecret = req.header("x-internal-api-secret");

  if (!providedSecret || !secretsMatch(providedSecret, env.INTERNAL_API_SECRET)) {
    next(new ApiError(401, "Invalid internal API secret"));
    return;
  }

  next();
};
