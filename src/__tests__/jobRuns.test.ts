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
const { jobRunsService } =
  require("../services/jobRunsService") as typeof import("../services/jobRunsService");

describe("job runs service", () => {
  it("starts and completes a job run with environment, duration, stats, and safe metadata", async () => {
    const db = installMockSupabase({ job_runs: [] });
    const timers = mock.timers;
    timers.enable({ apis: ["Date"], now: new Date("2026-06-24T10:00:00.000Z") });

    try {
      const started = await jobRunsService.startJobRun("appointment-emails-worker", {
        limit: 10,
        signed_url: "https://example.supabase.co/object/sign/file.png?token=secret"
      });

      timers.setTime(new Date("2026-06-24T10:00:03.000Z").getTime());

      const completed = await jobRunsService.completeJobRun(String(started.id), {
        recordsProcessed: 4,
        recordsSucceeded: 3,
        recordsFailed: 1
      });

      assert.equal(completed.environment, "test");
      assert.equal(completed.status, "completed");
      assert.equal(completed.duration_ms, 3000);
      assert.equal(completed.records_processed, 4);
      assert.equal(completed.records_succeeded, 3);
      assert.equal(completed.records_failed, 1);
      assert.deepEqual(completed.metadata, {
        limit: 10,
        signed_url: "[redacted]"
      });
    } finally {
      timers.reset();
      db.restore();
    }
  });

  it("marks failed jobs with bounded safe error details", async () => {
    const db = installMockSupabase({
      job_runs: [
        {
          id: "job-1",
          environment: "test",
          job_name: "appointment-emails-worker",
          status: "started",
          started_at: "2026-06-24T10:00:00.000Z",
          created_at: "2026-06-24T10:00:00.000Z"
        }
      ]
    });

    try {
      const error = Object.assign(new Error("x".repeat(700)), { code: "provider_down" });
      const failed = await jobRunsService.failJobRun("job-1", error, {
        recordsProcessed: 2,
        recordsSucceeded: 1,
        recordsFailed: 1
      });

      assert.equal(failed.status, "failed");
      assert.equal(failed.error_code, "provider_down");
      assert.equal(failed.error_message, "x".repeat(500));
      assert.equal(failed.records_failed, 1);
    } finally {
      db.restore();
    }
  });

  it("records skipped jobs and returns health metrics", async () => {
    const db = installMockSupabase({
      job_runs: [
        {
          id: "completed-old",
          environment: "test",
          job_name: "birthday-reminder-worker",
          status: "completed",
          finished_at: "2026-06-24T09:00:00.000Z",
          created_at: "2026-06-24T09:00:00.000Z"
        },
        {
          id: "completed-new",
          environment: "test",
          job_name: "appointment-emails-worker",
          status: "completed",
          finished_at: "2026-06-24T11:00:00.000Z",
          created_at: "2026-06-24T11:00:00.000Z"
        },
        {
          id: "failed-1",
          environment: "test",
          job_name: "appointment-emails-worker",
          status: "failed",
          created_at: "2026-06-24T12:00:00.000Z"
        },
        {
          id: "failed-production",
          environment: "production",
          job_name: "appointment-emails-worker",
          status: "failed",
          created_at: "2026-06-24T12:00:00.000Z"
        }
      ]
    });

    try {
      const skipped = await jobRunsService.skipJobRun("api-request-logs-cleanup", "disabled for local run", {
        reason: "manual"
      });
      const lastSuccessful = await jobRunsService.getLastSuccessfulJobRun();
      const failedCount = await jobRunsService.getFailedJobsCount({
        start: "2026-06-24T00:00:00.000Z",
        end: "2026-06-25T00:00:00.000Z"
      });

      assert.equal(skipped.status, "skipped");
      assert.equal(skipped.error_message, "disabled for local run");
      assert.equal(lastSuccessful?.id, "completed-new");
      assert.equal(failedCount, 1);
    } finally {
      db.restore();
    }
  });

  it("rejects unknown job names", async () => {
    const db = installMockSupabase({ job_runs: [] });

    try {
      await assert.rejects(
        () => jobRunsService.startJobRun("unknown-worker"),
        /Unknown job name/
      );
    } finally {
      db.restore();
    }
  });
});
