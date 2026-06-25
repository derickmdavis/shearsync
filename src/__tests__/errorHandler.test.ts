import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ZodError, z } from "zod";
import type { Request, Response } from "express";

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = process.env.AUTH_MODE ?? "production";
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key";

const { ApiError } = require("../lib/errors") as typeof import("../lib/errors");
const { errorHandler } = require("../middleware/errorHandler") as typeof import("../middleware/errorHandler");

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

const runErrorHandler = (error: unknown) => {
  const { captured, res } = createMockResponse();
  errorHandler(error, {} as Request, res, () => undefined);
  return captured;
};

describe("error severity plumbing", () => {
  it("marks validation errors as warning", () => {
    const result = z.object({ name: z.string() }).safeParse({});
    assert.equal(result.success, false);

    const captured = runErrorHandler(result.error as ZodError);

    assert.equal(captured.statusCode, 400);
    assert.deepEqual(captured.locals.error, {
      code: "validation_failed",
      message: "Validation failed",
      severity: "warning"
    });
  });

  it("marks expected conflicts as warning and supports explicit critical errors", () => {
    const conflict = runErrorHandler(new ApiError(409, "Conflict"));
    assert.equal((conflict.locals.error as { severity?: string }).severity, "warning");

    const critical = runErrorHandler(new ApiError(500, "Invariant failed", undefined, { severity: "critical" }));
    assert.equal((critical.locals.error as { severity?: string }).severity, "critical");
  });

  it("marks unexpected server errors as error", () => {
    const captured = runErrorHandler(new Error("boom"));
    assert.equal(captured.statusCode, 500);
    assert.equal((captured.locals.error as { severity?: string }).severity, "error");
  });
});
