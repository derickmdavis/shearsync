import type { Request, Response } from "express";
import rateLimit, { ipKeyGenerator, type Store } from "express-rate-limit";
import { createClient, type RedisClientType } from "redis";
import { env } from "../config/env";
import { RedisRateLimitStore } from "./redisRateLimitStore";

const minutes = (value: number): number => value * 60 * 1000;

const defaultTooManyRequestsResponse = {
  error: {
    message: "Too many requests. Please try again shortly."
  }
};

const manageLinkTooManyRequestsResponse = {
  valid: false,
  reason: "unavailable",
  message: "This appointment link is invalid or expired. Please contact your stylist."
};

const sendJson = (res: Response, statusCode: number, payload: unknown): void => {
  res.status(statusCode).json(payload);
};

let rateLimitRedisClient: RedisClientType | undefined;
let rateLimitRedisConnection: Promise<RedisClientType> | undefined;

const getRateLimitRedisClient = async (): Promise<RedisClientType> => {
  if (!rateLimitRedisClient) {
    rateLimitRedisClient = createClient({ url: env.REDIS_URL });
    rateLimitRedisClient.on("error", (error) => {
      console.error("Rate-limit Redis client error", error);
    });
  }

  if (rateLimitRedisClient.isOpen) {
    return rateLimitRedisClient;
  }

  if (!rateLimitRedisConnection) {
    rateLimitRedisConnection = rateLimitRedisClient
      .connect()
      .then(() => rateLimitRedisClient!)
      .finally(() => {
        rateLimitRedisConnection = undefined;
      });
  }

  return rateLimitRedisConnection;
};

export type PublicRateLimitPolicy =
  | "public_read"
  | "availability"
  | "booking_intake"
  | "booking_create"
  | "public_mutation"
  | "photo_upload"
  | "manage_read"
  | "manage_mutation";

export type AuthenticatedRateLimitPolicy = "feedback_submit";

interface PublicRateLimiterOptions {
  policy: PublicRateLimitPolicy;
  windowMs: number;
  limit: number;
  manageLinkResponse?: boolean;
}

interface AuthenticatedRateLimiterOptions {
  policy: AuthenticatedRateLimitPolicy;
  windowMs: number;
  limit: number;
}

const createRateLimitStore = (windowMs: number): Store | undefined => {
  if (env.NODE_ENV !== "production") {
    return undefined;
  }

  // Production configuration is validated in config/env before this module is used.
  return new RedisRateLimitStore({
    getClient: getRateLimitRedisClient,
    prefix: "shearsync:rate-limit:",
    windowMs
  });
};

export const createPublicRateLimiter = ({
  policy,
  windowMs,
  limit,
  manageLinkResponse = false
}: PublicRateLimiterOptions) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skipSuccessfulRequests: false,
    passOnStoreError: false,
    store: createRateLimitStore(windowMs),
    keyGenerator: (req: Request) => [
      policy,
      ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? "unknown")
    ].join(":"),
    handler: (_req, res) => {
      sendJson(
        res,
        429,
        manageLinkResponse ? manageLinkTooManyRequestsResponse : defaultTooManyRequestsResponse
      );
    }
  });

export const createAuthenticatedRateLimiter = ({
  policy,
  windowMs,
  limit
}: AuthenticatedRateLimiterOptions) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skipSuccessfulRequests: false,
    passOnStoreError: false,
    store: createRateLimitStore(windowMs),
    keyGenerator: (req: Request) => [policy, req.auth?.userId ?? "missing-auth"].join(":"),
    handler: (_req, res) => {
      sendJson(res, 429, defaultTooManyRequestsResponse);
    }
  });

export const publicReadRateLimiter = createPublicRateLimiter({
  policy: "public_read",
  windowMs: minutes(15),
  limit: 120
});

export const availabilityRateLimiter = createPublicRateLimiter({
  policy: "availability",
  windowMs: minutes(5),
  limit: 30
});

export const bookingIntakeRateLimiter = createPublicRateLimiter({
  policy: "booking_intake",
  windowMs: minutes(15),
  limit: 20
});

export const bookingCreateRateLimiter = createPublicRateLimiter({
  policy: "booking_create",
  windowMs: minutes(15),
  limit: 5
});

export const publicMutationRateLimiter = createPublicRateLimiter({
  policy: "public_mutation",
  windowMs: minutes(15),
  limit: 10
});

export const photoUploadRateLimiter = createPublicRateLimiter({
  policy: "photo_upload",
  windowMs: minutes(15),
  limit: 10
});

export const appointmentManageReadRateLimiter = createPublicRateLimiter({
  policy: "manage_read",
  windowMs: minutes(15),
  limit: 20,
  manageLinkResponse: true
});

export const appointmentManageMutationRateLimiter = createPublicRateLimiter({
  policy: "manage_mutation",
  windowMs: minutes(15),
  limit: 5,
  manageLinkResponse: true
});

export const feedbackSubmissionRateLimiter = createAuthenticatedRateLimiter({
  policy: "feedback_submit",
  windowMs: minutes(60),
  limit: 10
});
