import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

process.env.NODE_ENV = "test";
process.env.APP_ENV = "test";
process.env.AUTH_MODE = process.env.AUTH_MODE ?? "production";
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key";

const { installMockSupabase } =
  require("./helpers/mockSupabase") as typeof import("./helpers/mockSupabase");
const { apiRequestLogsService, getApiRequestLogSeverity } =
  require("../services/apiRequestLogsService") as typeof import("../services/apiRequestLogsService");
const { apiRequestLogRetentionService } =
  require("../services/apiRequestLogRetentionService") as typeof import("../services/apiRequestLogRetentionService");

describe("API request logs", () => {
  it("records successful requests as info without query tokens", async () => {
    const db = installMockSupabase({ api_request_logs: [] });

    try {
      await apiRequestLogsService.record({
        requestId: "request-1",
        method: "get",
        path: "/api/dashboard?token=secret&tab=home",
        routePattern: "/api/dashboard",
        statusCode: 200,
        durationMs: 12.4,
        accountUserId: "11111111-1111-4111-8111-111111111111",
        metadata: {
          signed_url: "https://example.supabase.co/object/sign/file.png?token=secret"
        }
      });

      assert.equal(db.state.api_request_logs.length, 1);
      assert.equal(db.state.api_request_logs[0]?.environment, "test");
      assert.equal(db.state.api_request_logs[0]?.method, "GET");
      assert.equal(db.state.api_request_logs[0]?.path, "/api/dashboard");
      assert.equal(db.state.api_request_logs[0]?.severity, "info");
      assert.deepEqual(db.state.api_request_logs[0]?.metadata, {
        signed_url: "[redacted]"
      });
    } finally {
      db.restore();
    }
  });

  it("maps validation and server errors to warning and error severities", () => {
    assert.equal(getApiRequestLogSeverity(400), "warning");
    assert.equal(getApiRequestLogSeverity(404), "warning");
    assert.equal(getApiRequestLogSeverity(500), "error");
    assert.equal(getApiRequestLogSeverity(503, "critical"), "critical");
  });

  it("skips noisy health and asset routes", async () => {
    const db = installMockSupabase({ api_request_logs: [] });

    try {
      await apiRequestLogsService.record({
        requestId: "request-health",
        method: "GET",
        path: "/health",
        statusCode: 200,
        durationMs: 1
      });
      await apiRequestLogsService.record({
        requestId: "request-asset",
        method: "GET",
        path: "/assets/app.js",
        statusCode: 200,
        durationMs: 1
      });

      assert.equal(db.state.api_request_logs.length, 0);
    } finally {
      db.restore();
    }
  });

  it("cleans up only old logs for the current environment and records a job run", async () => {
    mock.timers.enable({ apis: ["Date"], now: new Date("2026-06-24T12:00:00.000Z") });
    const db = installMockSupabase({
      api_request_logs: [
        {
          id: "old-test",
          environment: "test",
          created_at: "2026-05-01T00:00:00.000Z"
        },
        {
          id: "new-test",
          environment: "test",
          created_at: "2026-06-20T00:00:00.000Z"
        },
        {
          id: "old-production",
          environment: "production",
          created_at: "2026-05-01T00:00:00.000Z"
        }
      ],
      job_runs: []
    });

    try {
      const result = await apiRequestLogRetentionService.cleanup(30);

      assert.equal(result.deleted, 1);
      assert.deepEqual(
        db.state.api_request_logs.map((row) => row.id).sort(),
        ["new-test", "old-production"]
      );
      assert.equal(db.state.job_runs.length, 1);
      assert.equal(db.state.job_runs[0]?.job_name, "api-request-logs-cleanup");
      assert.equal(db.state.job_runs[0]?.status, "completed");
      assert.equal(db.state.job_runs[0]?.records_succeeded, 1);
    } finally {
      mock.timers.reset();
      db.restore();
    }
  });
});
