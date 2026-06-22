import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NextFunction, Request, Response } from "express";

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = process.env.AUTH_MODE ?? "production";
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key";
process.env.SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET ?? "test-public-booking-secret";

const { installMockSupabase } = require("./helpers/mockSupabase") as typeof import("./helpers/mockSupabase");
const { publicController } = require("../controllers/publicController") as typeof import("../controllers/publicController");
const { errorHandler } = require("../middleware/errorHandler") as typeof import("../middleware/errorHandler");

interface MockResponse {
  statusCode: number;
  body: unknown;
}

const createMockRequest = (overrides: Partial<Request> = {}): Request =>
  ({
    body: {},
    params: {},
    query: {},
    headers: {},
    ...overrides
  }) as Request;

const createMockResponse = () => {
  const response: MockResponse = {
    statusCode: 200,
    body: null
  };

  const res = {
    status(code: number) {
      response.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      response.body = payload;
      return this;
    }
  } as Partial<Response> as Response;

  return { response, res };
};

const runWithErrorHandler = async (
  callback: (req: Request, res: Response, next: NextFunction) => Promise<void> | void,
  req: Request
): Promise<MockResponse> => {
  const { response, res } = createMockResponse();

  const next: NextFunction = (error?: unknown) => {
    if (error) {
      errorHandler(error as Error, req, res, () => undefined);
    }
  };

  try {
    await callback(req, res, next);
  } catch (error) {
    errorHandler(error as Error, req, res, () => undefined);
  }

  return response;
};

describe("early access public endpoint", () => {
  it("creates an early access request with normalized email", async () => {
    const supabase = installMockSupabase({
      early_access_requests: []
    });

    try {
      const req = createMockRequest({
        body: {
          fullName: "  Katie Johnson  ",
          email: "  Katie@Example.COM ",
          source: "homepage_waitlist",
          utmSource: "instagram",
          utmMedium: "bio",
          utmCampaign: "beta_launch"
        }
      });

      const response = await runWithErrorHandler(
        (request, res) => publicController.createEarlyAccessRequest(request, res),
        req
      );

      assert.equal(response.statusCode, 201);
      assert.deepEqual(response.body, {
        success: true,
        message: "You're on the list."
      });
      assert.equal(supabase.state.early_access_requests.length, 1);
      assert.equal(supabase.state.early_access_requests[0].full_name, "Katie Johnson");
      assert.equal(supabase.state.early_access_requests[0].email, "katie@example.com");
      assert.equal(supabase.state.early_access_requests[0].phone, null);
      assert.equal(supabase.state.early_access_requests[0].status, "new");
      assert.equal(supabase.state.early_access_requests[0].source, "homepage_waitlist");
      assert.equal(supabase.state.early_access_requests[0].utm_source, "instagram");
      assert.equal(supabase.state.early_access_requests[0].utm_medium, "bio");
      assert.equal(supabase.state.early_access_requests[0].utm_campaign, "beta_launch");
    } finally {
      supabase.restore();
    }
  });

  it("updates duplicate emails without revealing the duplicate", async () => {
    const createdAt = "2026-06-01T12:00:00.000Z";
    const supabase = installMockSupabase({
      early_access_requests: [
        {
          id: "early-access-1",
          full_name: "Katie",
          email: "KATIE@EXAMPLE.COM",
          phone: "555-111-2222",
          status: "new",
          source: "homepage_waitlist",
          utm_source: "instagram",
          created_at: createdAt,
          updated_at: createdAt
        }
      ]
    });

    try {
      const req = createMockRequest({
        body: {
          full_name: "Katie Johnson",
          email: "katie@example.com",
          source: "footer_waitlist"
        }
      });

      const response = await runWithErrorHandler(
        (request, res) => publicController.createEarlyAccessRequest(request, res),
        req
      );

      assert.equal(response.statusCode, 201);
      assert.deepEqual(response.body, {
        success: true,
        message: "You're on the list."
      });
      assert.equal(supabase.state.early_access_requests.length, 1);
      assert.equal(supabase.state.early_access_requests[0].created_at, createdAt);
      assert.equal(supabase.state.early_access_requests[0].full_name, "Katie Johnson");
      assert.equal(supabase.state.early_access_requests[0].email, "katie@example.com");
      assert.equal(supabase.state.early_access_requests[0].phone, "555-111-2222");
      assert.equal(supabase.state.early_access_requests[0].source, "footer_waitlist");
      assert.equal(supabase.state.early_access_requests[0].utm_source, "instagram");
    } finally {
      supabase.restore();
    }
  });

  it("rejects invalid input with a friendly response", async () => {
    const supabase = installMockSupabase({
      early_access_requests: []
    });

    try {
      const req = createMockRequest({
        body: {
          fullName: "Katie Johnson",
          email: "not-an-email"
        }
      });

      const response = await runWithErrorHandler(
        (request, res) => publicController.createEarlyAccessRequest(request, res),
        req
      );

      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.body, {
        success: false,
        message: "Please enter a valid email address."
      });
      assert.equal(supabase.state.early_access_requests.length, 0);
    } finally {
      supabase.restore();
    }
  });
});
