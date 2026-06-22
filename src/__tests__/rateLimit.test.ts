import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NextFunction, Request, Response } from "express";
import { createPublicRateLimiter } from "../middleware/rateLimit";

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = process.env.AUTH_MODE ?? "production";
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key";

const { app: apiApp } = require("../app") as typeof import("../app");

interface CapturedResponse {
  statusCode: number;
  body: unknown;
  headers: Map<string, string | number | readonly string[]>;
}

const createMockRequest = (ip: string): Request => ({
  ip,
  socket: {
    remoteAddress: ip
  },
  app: {
    get(name: string) {
      return name === "trust proxy" ? 1 : undefined;
    }
  },
  headers: {}
}) as unknown as Request;

const createMockResponse = (): { captured: CapturedResponse; res: Response } => {
  const captured: CapturedResponse = {
    statusCode: 200,
    body: null,
    headers: new Map()
  };

  const res = {
    status(code: number) {
      captured.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      captured.body = payload;
      return this;
    },
    setHeader(name: string, value: string | number | readonly string[]) {
      captured.headers.set(name.toLowerCase(), value);
      return this;
    },
    append(name: string, value: string | number | readonly string[]) {
      const key = name.toLowerCase();
      const existing = captured.headers.get(key);
      captured.headers.set(key, existing ? `${existing}, ${value}` : value);
      return this;
    },
    getHeader(name: string) {
      return captured.headers.get(name.toLowerCase());
    },
    removeHeader(name: string) {
      captured.headers.delete(name.toLowerCase());
    },
    headersSent: false
  } as unknown as Response;

  return { captured, res };
};

const runLimiter = async (
  limiter: ReturnType<typeof createPublicRateLimiter>,
  ip = "203.0.113.10"
): Promise<CapturedResponse> => {
  const req = createMockRequest(ip);
  const { captured, res } = createMockResponse();

  await new Promise<void>((resolve, reject) => {
    const next: NextFunction = (error?: unknown) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    };

    Promise.resolve(limiter(req, res, next))
      .then(() => {
        if (captured.statusCode !== 200) {
          resolve();
        }
      })
      .catch(reject);
  });

  return captured;
};

describe("public rate limiters", () => {
  it("configures the API to trust one upstream proxy for client IP resolution", () => {
    assert.equal(apiApp.get("trust proxy"), 1);
  });

  it("returns a generic 429 error when a public API policy is exceeded", async () => {
    const limiter = createPublicRateLimiter({
        policy: "availability",
        windowMs: 60_000,
        limit: 1
      });

    const firstResponse = await runLimiter(limiter);
    const secondResponse = await runLimiter(limiter);

    assert.equal(firstResponse.statusCode, 200);
    assert.equal(secondResponse.statusCode, 429);
    assert.deepEqual(secondResponse.body, {
      error: {
        message: "Too many requests. Please try again shortly."
      }
    });
    assert.equal(typeof secondResponse.headers.get("ratelimit-policy"), "string");
  });

  it("returns a generic appointment-link response when a manage-link policy is exceeded", async () => {
    const limiter = createPublicRateLimiter({
        policy: "manage_read",
        windowMs: 60_000,
        limit: 1,
        manageLinkResponse: true
      });

    const firstResponse = await runLimiter(limiter);
    const secondResponse = await runLimiter(limiter);

    assert.equal(firstResponse.statusCode, 200);
    assert.equal(secondResponse.statusCode, 429);
    assert.deepEqual(secondResponse.body, {
      valid: false,
      reason: "unavailable",
      message: "This appointment link is invalid or expired. Please contact your stylist."
    });
  });
});
