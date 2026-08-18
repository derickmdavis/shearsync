import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import type { Response } from "express";

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = process.env.AUTH_MODE ?? "production";
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key";

const { livenessHandler, readinessHandler } =
  require("../routes/healthRoutes") as typeof import("../routes/healthRoutes");
const { schemaReadinessService } =
  require("../services/schemaReadinessService") as typeof import("../services/schemaReadinessService");

const createResponse = (): { response: Response; body: unknown; statusCode: number } => {
  const captured = { body: null as unknown, statusCode: 200 };
  const response = {
    status(statusCode: number) {
      captured.statusCode = statusCode;
      return this;
    },
    json(body: unknown) {
      captured.body = body;
      return this;
    }
  } as unknown as Response;

  return {
    response,
    get body() {
      return captured.body;
    },
    get statusCode() {
      return captured.statusCode;
    }
  };
};

describe("health routes", () => {
  afterEach(() => {
    mock.restoreAll();
    schemaReadinessService.clearCachedReadiness();
  });

  it("keeps liveness process-only and does not run schema readiness", () => {
    const readinessMock = mock.method(schemaReadinessService, "assertReady", async () => undefined);
    const captured = createResponse();

    livenessHandler({} as never, captured.response);

    assert.equal(readinessMock.mock.callCount(), 0);
    assert.equal(captured.statusCode, 200);
    assert.deepEqual(captured.body, { status: "ok" });
  });

  it("caches deep readiness checks and returns their check time", async () => {
    const readinessMock = mock.method(schemaReadinessService, "assertReady", async () => undefined);
    const first = createResponse();
    const second = createResponse();

    await readinessHandler({} as never, first.response);
    await readinessHandler({} as never, second.response);

    assert.equal(readinessMock.mock.callCount(), 1);
    assert.equal(first.statusCode, 200);
    assert.deepEqual(first.body, second.body);
    assert.match((first.body as { checkedAt: string }).checkedAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  it("caches a failed readiness result instead of repeatedly probing an unhealthy dependency", async () => {
    const error = new Error("database unavailable");
    const readinessMock = mock.method(schemaReadinessService, "assertReady", async () => {
      throw error;
    });

    await assert.rejects(() => readinessHandler({} as never, createResponse().response), error);
    await assert.rejects(() => readinessHandler({} as never, createResponse().response), error);

    assert.equal(readinessMock.mock.callCount(), 1);
  });
});
