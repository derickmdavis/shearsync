import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NextFunction, Request, Response } from "express";

process.env.NODE_ENV = "test";
process.env.APP_ENV = "test";
process.env.AUTH_MODE = process.env.AUTH_MODE ?? "production";
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key";

const { installMockSupabase } =
  require("./helpers/mockSupabase") as typeof import("./helpers/mockSupabase");
const { requireAdmin } = require("../middleware/adminAuth") as typeof import("../middleware/adminAuth");
const { errorHandler } = require("../middleware/errorHandler") as typeof import("../middleware/errorHandler");

const ADMIN_USER_ID = "11111111-1111-4111-8111-111111111111";
const NORMAL_USER_ID = "22222222-2222-4222-8222-222222222222";

const createMockRequest = (email?: string, userId = NORMAL_USER_ID): Request =>
  ({
    auth: {
      userId,
      email,
      source: "jwt"
    },
    body: {},
    params: {},
    query: {}
  }) as Request;

const createMockResponse = () => {
  const captured = {
    statusCode: 200,
    body: null as unknown,
    locals: {} as Record<string, unknown>
  };

  const res = {
    locals: captured.locals,
    status(code: number) {
      captured.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      captured.body = payload;
      return this;
    }
  } as Partial<Response> as Response;

  return { captured, res };
};

const runRequireAdmin = async (req: Request) => {
  const { captured, res } = createMockResponse();
  let allowed = false;
  const next: NextFunction = (error?: unknown) => {
    if (error) {
      errorHandler(error as Error, req, res, () => undefined);
      return;
    }

    allowed = true;
  };

  await requireAdmin(req, res, next);
  return { allowed, captured };
};

describe("admin auth", () => {
  it("allows active admin users by authenticated email", async () => {
    const db = installMockSupabase({
      admin_users: [
        {
          id: "admin-row",
          email: "admin@example.com",
          is_active: true
        }
      ]
    });

    try {
      const req = createMockRequest("Admin@Example.com", ADMIN_USER_ID);
      const result = await runRequireAdmin(req);

      assert.equal(result.allowed, true);
      assert.deepEqual(req.admin, {
        email: "admin@example.com",
        userId: ADMIN_USER_ID
      });
    } finally {
      db.restore();
    }
  });

  it("rejects normal and inactive users", async () => {
    const db = installMockSupabase({
      admin_users: [
        {
          id: "inactive-admin-row",
          email: "inactive@example.com",
          is_active: false
        }
      ]
    });

    try {
      const normal = await runRequireAdmin(createMockRequest("stylist@example.com"));
      const inactive = await runRequireAdmin(createMockRequest("inactive@example.com"));

      assert.equal(normal.allowed, false);
      assert.equal(normal.captured.statusCode, 403);
      assert.equal(inactive.allowed, false);
      assert.equal(inactive.captured.statusCode, 403);
    } finally {
      db.restore();
    }
  });

  it("rejects authenticated users without an email", async () => {
    const db = installMockSupabase({ admin_users: [] });

    try {
      const result = await runRequireAdmin(createMockRequest(undefined));

      assert.equal(result.allowed, false);
      assert.equal(result.captured.statusCode, 403);
    } finally {
      db.restore();
    }
  });
});
