import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NextFunction, Request, Response } from "express";

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = process.env.AUTH_MODE ?? "production";
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key";

const { installMockSupabase } = require("./helpers/mockSupabase") as typeof import("./helpers/mockSupabase");
const { accountController } = require("../controllers/accountController") as typeof import("../controllers/accountController");
const { errorHandler } = require("../middleware/errorHandler") as typeof import("../middleware/errorHandler");
const { validate } = require("../middleware/validate") as typeof import("../middleware/validate");
const { requestAccountDeletionSchema } =
  require("../validators/accountValidators") as typeof import("../validators/accountValidators");

const userId = "11111111-1111-1111-1111-111111111111";
const otherUserId = "22222222-2222-2222-2222-222222222222";

interface MockResponse {
  statusCode: number;
  body: unknown;
}

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
    },
    send(payload?: unknown) {
      response.body = payload ?? null;
      return this;
    }
  } as Partial<Response> as Response;

  return { response, res };
};

const createMockRequest = (overrides: Partial<Request> = {}): Request =>
  ({
    auth: { userId, email: "maya@example.com", source: "dev" },
    body: {},
    params: {},
    query: {},
    ip: "127.0.0.1",
    headers: {},
    header(name: string) {
      const key = name.toLowerCase();
      return typeof this.headers[key] === "string" ? (this.headers[key] as string) : undefined;
    },
    ...overrides
  }) as Request;

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

const installAccountDeletionMockSupabase = () =>
  installMockSupabase({
    users: [
      {
        id: userId,
        email: "maya@example.com",
        timezone: "America/Denver"
      },
      {
        id: otherUserId,
        email: "other@example.com",
        timezone: "America/Denver"
      }
    ],
    stylists: [
      {
        id: "33333333-3333-4333-8333-333333333333",
        user_id: userId,
        slug: "maya",
        display_name: "Maya",
        booking_enabled: true
      },
      {
        id: "44444444-4444-4444-8444-444444444444",
        user_id: otherUserId,
        slug: "other",
        display_name: "Other",
        booking_enabled: true
      }
    ],
    account_deletion_requests: [],
    account_deletion_audit_events: [],
    rebook_nudges: [
      {
        id: "55555555-5555-4555-8555-555555555555",
        user_id: userId,
        status: "queued"
      }
    ],
    birthday_reminders: [
      {
        id: "66666666-6666-4666-8666-666666666666",
        user_id: userId,
        status: "queued"
      }
    ],
    appointment_email_events: [
      {
        id: "77777777-7777-4777-8777-777777777777",
        user_id: userId,
        status: "queued"
      }
    ]
  });

describe("Account deletion requests", () => {
  it("creates a pending deletion request and disables public booking", async () => {
    const supabase = installAccountDeletionMockSupabase();

    try {
      const body = requestAccountDeletionSchema.parse({
        confirmation: "DELETE",
        reason: "No longer need the app",
        clientRequestId: "client-request-1"
      });
      const response = await runWithErrorHandler(
        (request, res) => accountController.requestDeletion(request, res),
        createMockRequest({
          body,
          headers: { "user-agent": "node-test" }
        })
      );

      assert.equal(response.statusCode, 202);
      const payload = response.body as {
        data: {
          status: string;
          requestId: string;
          publicBookingDisabled: boolean;
          message: string;
        };
      };
      assert.equal(payload.data.status, "pending");
      assert.equal(typeof payload.data.requestId, "string");
      assert.equal(payload.data.publicBookingDisabled, true);
      assert.equal(payload.data.message, "Your account deletion request has been received.");

      assert.equal(supabase.state.account_deletion_requests.length, 1);
      assert.equal(supabase.state.account_deletion_requests[0].user_id, userId);
      assert.equal(supabase.state.account_deletion_requests[0].reason, "No longer need the app");
      assert.equal(supabase.state.stylists.find((stylist) => stylist.user_id === userId)?.booking_enabled, false);
      assert.equal(supabase.state.stylists.find((stylist) => stylist.user_id === otherUserId)?.booking_enabled, true);
      assert.equal(supabase.state.rebook_nudges[0].status, "cancelled");
      assert.equal(supabase.state.birthday_reminders[0].status, "cancelled");
      assert.equal(supabase.state.appointment_email_events[0].status, "skipped");
      assert.equal(supabase.state.account_deletion_audit_events.length, 1);
    } finally {
      supabase.restore();
    }
  });

  it("returns an existing active deletion request idempotently", async () => {
    const supabase = installAccountDeletionMockSupabase();

    try {
      supabase.state.account_deletion_requests.push({
        id: "88888888-8888-4888-8888-888888888888",
        user_id: userId,
        status: "pending",
        requested_at: "2026-06-20T18:30:00.000Z",
        scheduled_deletion_at: "2026-06-27T18:30:00.000Z",
        completed_at: null
      });

      const response = await runWithErrorHandler(
        (request, res) => accountController.requestDeletion(request, res),
        createMockRequest({
          body: requestAccountDeletionSchema.parse({ confirmation: "DELETE" })
        })
      );

      assert.equal(response.statusCode, 202);
      assert.equal(supabase.state.account_deletion_requests.length, 1);
      assert.deepEqual((response.body as { data: { requestId: string; message: string } }).data, {
        requestId: "88888888-8888-4888-8888-888888888888",
        status: "pending",
        requestedAt: "2026-06-20T18:30:00.000Z",
        scheduledDeletionAt: "2026-06-27T18:30:00.000Z",
        completedAt: null,
        publicBookingDisabled: true,
        message: "Your account deletion request has already been received."
      });
      assert.equal(supabase.state.stylists.find((stylist) => stylist.user_id === userId)?.booking_enabled, false);
      assert.equal(supabase.state.account_deletion_audit_events.length, 1);
      assert.equal(supabase.state.account_deletion_audit_events[0].event_type, "duplicate_request");
    } finally {
      supabase.restore();
    }
  });

  it("reports no deletion request when none exists", async () => {
    const supabase = installAccountDeletionMockSupabase();

    try {
      const response = await runWithErrorHandler(
        (request, res) => accountController.getDeletionRequest(request, res),
        createMockRequest()
      );

      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.body, {
        data: {
          status: "none",
          requestId: null,
          requestedAt: null,
          scheduledDeletionAt: null,
          completedAt: null
        }
      });
    } finally {
      supabase.restore();
    }
  });

  it("validates the destructive confirmation string", async () => {
    const response = await runWithErrorHandler(
      (request, res, next) =>
        validate({ body: requestAccountDeletionSchema })(request, res, (error) => {
          if (error) {
            next(error);
          }
        }),
      createMockRequest({
        body: {
          confirmation: "delete"
        }
      })
    );

    assert.equal(response.statusCode, 400);
  });
});
