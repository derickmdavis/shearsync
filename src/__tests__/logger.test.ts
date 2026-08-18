import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it, mock } from "node:test";
import type { NextFunction, Request, Response } from "express";
import type { ApiRequestLogInput } from "../services/apiRequestLogsService";

process.env.NODE_ENV = "test";

const { logger, requestObservability } = require("../lib/logger") as typeof import("../lib/logger");
const { apiRequestLogsService } = require("../services/apiRequestLogsService") as typeof import("../services/apiRequestLogsService");

const observe = (request: Partial<Request>) => {
  const response = Object.assign(new EventEmitter(), {
    locals: {},
    statusCode: 200,
    setHeader() { return undefined; }
  }) as unknown as Response;
  requestObservability(request as Request, response, (() => undefined) as NextFunction);
  (response as unknown as EventEmitter).emit("finish");
};

describe("request observability", () => {
  it("stores only a redacted route path and never a capability URL or query token", () => {
    const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const records: ApiRequestLogInput[] = [];
    const info = mock.method(logger, "info", (event: string, fields?: Record<string, unknown>) => { logs.push({ event, fields }); });
    const record = mock.method(apiRequestLogsService, "record", async (input: ApiRequestLogInput) => { records.push(input); return null; });
    const capabilityToken = "capability-token-that-must-not-be-logged";
    const queryToken = "query-token-that-must-not-be-logged";
    try {
      observe({
        method: "GET",
        baseUrl: "/api/communications",
        route: { path: "/unsubscribe/:token" },
        originalUrl: `/api/communications/unsubscribe/${capabilityToken}?next=/preferences&token=${queryToken}`,
        url: `/unsubscribe/${capabilityToken}?token=${queryToken}`,
        path: `/api/communications/unsubscribe/${capabilityToken}`,
        header: () => undefined
      });
      assert.equal(logs.length, 1);
      assert.equal(logs[0]?.event, "http_request_completed");
      assert.equal(logs[0]?.fields?.route, "/api/communications/unsubscribe/:token");
      assert.equal(logs[0]?.fields?.path, "/api/communications/unsubscribe/[redacted]");
      assert.equal(records.length, 1);
      assert.equal(records[0]?.routePattern, "/api/communications/unsubscribe/:token");
      assert.equal(records[0]?.path, "/api/communications/unsubscribe/[redacted]");
      const serialized = JSON.stringify({ logs, records });
      assert.ok(!serialized.includes(capabilityToken));
      assert.ok(!serialized.includes(queryToken));
    } finally {
      record.mock.restore();
      info.mock.restore();
    }
  });

  it("redacts every unmatched path segment instead of falling back to a raw URL", () => {
    const records: ApiRequestLogInput[] = [];
    const record = mock.method(apiRequestLogsService, "record", async (input: ApiRequestLogInput) => { records.push(input); return null; });
    try {
      observe({
        method: "GET",
        originalUrl: "/appointments/manage/secret-token?access_token=query-secret",
        url: "/appointments/manage/secret-token?access_token=query-secret",
        path: "/appointments/manage/secret-token",
        header: () => undefined
      });
      assert.equal(records[0]?.routePattern, null);
      assert.equal(records[0]?.path, "/[redacted]/[redacted]/[redacted]");
    } finally {
      record.mock.restore();
    }
  });
});
