import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type { Request, Response } from "express";

process.env.NODE_ENV = "test";
process.env.APP_ENV = "test";
process.env.AUTH_MODE = process.env.AUTH_MODE ?? "production";
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key";

const { installMockSupabase } =
  require("./helpers/mockSupabase") as typeof import("./helpers/mockSupabase");
const { logger } = require("../lib/logger") as typeof import("../lib/logger");
const { feedbackController } =
  require("../controllers/feedbackController") as typeof import("../controllers/feedbackController");
const { inAppFeedbackService } =
  require("../services/inAppFeedbackService") as typeof import("../services/inAppFeedbackService");
const { createInAppFeedbackSchema } =
  require("../validators/feedbackValidators") as typeof import("../validators/feedbackValidators");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const SPOOFED_USER_ID = "22222222-2222-4222-8222-222222222222";

const createMockResponse = () => {
  const captured: { statusCode: number; body: unknown } = { statusCode: 200, body: null };
  const res = {
    status(code: number) {
      captured.statusCode = code;
      return this;
    },
    json(body: unknown) {
      captured.body = body;
      return this;
    }
  } as Partial<Response> as Response;

  return { captured, res };
};

describe("in-app feedback service", () => {
  it("stores the supplied user's feedback with trimmed text and server-defined source", async () => {
    const db = installMockSupabase({ in_app_feedback: [] });

    try {
      const feedback = await inAppFeedbackService.createForUser(USER_ID, {
        rating: 3,
        feedbackText: "  I love the new client detail screen.  "
      });

      assert.equal(db.state.in_app_feedback.length, 1);
      assert.deepEqual(
        {
          user_id: db.state.in_app_feedback[0]?.user_id,
          rating: db.state.in_app_feedback[0]?.rating,
          feedback_text: db.state.in_app_feedback[0]?.feedback_text,
          source: db.state.in_app_feedback[0]?.source
        },
        {
          user_id: USER_ID,
          rating: 3,
          feedback_text: "I love the new client detail screen.",
          source: "mobile_app"
        }
      );
      assert.equal(feedback.rating, 3);
      assert.equal(feedback.feedbackText, "I love the new client detail screen.");
      assert.ok(feedback.createdAt);
      assert.notEqual(db.state.in_app_feedback[0]?.user_id, SPOOFED_USER_ID);
    } finally {
      db.restore();
    }
  });

  it("stores blank feedback text as null and logs no feedback content", async () => {
    const db = installMockSupabase({ in_app_feedback: [] });
    const logCalls: Array<{ event: string; fields: Record<string, unknown> | undefined }> = [];
    const logMock = mock.method(logger, "info", (event: string, fields?: Record<string, unknown>) => {
      logCalls.push({ event, fields });
    });

    try {
      const feedback = await inAppFeedbackService.createForUser(USER_ID, {
        rating: 1,
        feedbackText: "   "
      });

      assert.equal(db.state.in_app_feedback[0]?.feedback_text, null);
      assert.equal(feedback.feedbackText, null);
      assert.deepEqual(logCalls, [{
        event: "in_app_feedback_submitted",
        fields: {
          feedbackId: feedback.id,
          userId: USER_ID,
          rating: 1
        }
      }]);
    } finally {
      logMock.mock.restore();
      db.restore();
    }
  });

  it("accepts every supported rating and returns the database-generated creation time", async () => {
    const db = installMockSupabase({ in_app_feedback: [] });

    try {
      const submitted = await Promise.all([1, 2, 3].map((rating) =>
        inAppFeedbackService.createForUser(USER_ID, { rating })
      ));

      assert.deepEqual(db.state.in_app_feedback.map((row) => row.rating), [1, 2, 3]);
      assert.ok(submitted.every((feedback) => typeof feedback.createdAt === "string" && feedback.createdAt.length > 0));
    } finally {
      db.restore();
    }
  });

  it("creates feedback for an inactive authenticated account and returns 201", async () => {
    const db = installMockSupabase({
      users: [{ id: USER_ID, email: "owner@example.com", account_status: "inactive" }],
      in_app_feedback: []
    });
    const { captured, res } = createMockResponse();
    const req = {
      auth: { userId: USER_ID, email: "owner@example.com", source: "jwt" },
      body: { rating: 2, feedback: "  The calendar is hard to scroll.  " }
    } as Partial<Request> as Request;

    try {
      await feedbackController.create(req, res);

      assert.equal(captured.statusCode, 201);
      assert.deepEqual(captured.body, {
        data: {
          id: db.state.in_app_feedback[0]?.id,
          rating: 2,
          feedbackText: "The calendar is hard to scroll.",
          createdAt: db.state.in_app_feedback[0]?.created_at
        }
      });
      assert.equal(db.state.in_app_feedback[0]?.user_id, USER_ID);
    } finally {
      db.restore();
    }
  });

  it("requires authentication before feedback can be created", async () => {
    const { res } = createMockResponse();
    const req = { body: { rating: 2 } } as Partial<Request> as Request;

    await assert.rejects(
      () => feedbackController.create(req, res),
      /Authentication required/
    );
  });

  it("rejects invalid, oversized, and identity-spoofing request bodies", () => {
    for (const body of [
      { rating: 0 },
      { rating: 4 },
      { rating: 1.5 },
      { rating: "3" },
      {},
      { rating: 2, feedback: "x".repeat(4001) },
      { rating: 2, userId: SPOOFED_USER_ID },
      { rating: 2, accountId: SPOOFED_USER_ID }
    ]) {
      assert.equal(createInAppFeedbackSchema.safeParse(body).success, false);
    }
  });
});
