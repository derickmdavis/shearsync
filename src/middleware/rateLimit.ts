import type { Request, Response } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";

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

export type PublicRateLimitPolicy =
  | "public_read"
  | "availability"
  | "booking_intake"
  | "booking_create"
  | "public_mutation"
  | "photo_upload"
  | "manage_read"
  | "manage_mutation";

interface PublicRateLimiterOptions {
  policy: PublicRateLimitPolicy;
  windowMs: number;
  limit: number;
  manageLinkResponse?: boolean;
}

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
