import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type { NextFunction, Request, Response } from "express";

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = process.env.AUTH_MODE ?? "production";
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key";

const { env } = require("../config/env") as typeof import("../config/env");
const { installMockSupabase } =
  require("./helpers/mockSupabase") as typeof import("./helpers/mockSupabase");
const { internalController } =
  require("../controllers/internalController") as typeof import("../controllers/internalController");
const { requireInternalApiSecret } =
  require("../middleware/internalAuth") as typeof import("../middleware/internalAuth");
const { errorHandler } = require("../middleware/errorHandler") as typeof import("../middleware/errorHandler");
const { supabaseAdmin } = require("../lib/supabase") as typeof import("../lib/supabase");

const USER_ID = "11111111-1111-1111-1111-111111111111";

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
    body: {},
    params: {},
    query: {},
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

const withInternalApiSecret = async <T>(secret: string | undefined, callback: () => Promise<T>): Promise<T> => {
  const previousSecret = env.INTERNAL_API_SECRET;
  env.INTERNAL_API_SECRET = secret;

  try {
    return await callback();
  } finally {
    env.INTERNAL_API_SECRET = previousSecret;
  }
};

const installStorageMock = (options: { removeError?: unknown } = {}) => {
  const calls = {
    remove: [] as string[][]
  };
  const fromMock = mock.method(supabaseAdmin.storage, "from", () => ({
    remove: async (paths: string[]) => {
      calls.remove.push(paths);

      if (options.removeError) {
        return { data: null, error: options.removeError };
      }

      return { data: [], error: null };
    }
  }));

  return {
    calls,
    restore: () => fromMock.mock.restore()
  };
};

describe("Client purge", () => {
  it("hard-deletes only expired soft-deleted clients through the protected internal trigger", async () => {
    mock.timers.enable({ apis: ["Date"], now: new Date("2026-07-20T12:00:00.000Z") });
    const supabase = installMockSupabase({
      clients: [
        {
          id: "client-expired",
          user_id: USER_ID,
          first_name: "Ava",
          last_name: "Martinez",
          deleted_at: "2026-06-16T12:00:00.000Z",
          deleted_reason: "user_deleted",
          purge_after: "2026-07-16T12:00:00.000Z"
        },
        {
          id: "client-retained",
          user_id: USER_ID,
          first_name: "Noah",
          last_name: "Kim",
          deleted_at: "2026-07-01T12:00:00.000Z",
          deleted_reason: "user_deleted",
          purge_after: "2026-07-31T12:00:00.000Z"
        },
        {
          id: "client-active",
          user_id: USER_ID,
          first_name: "Maya",
          last_name: "Lopez",
          deleted_at: null,
          deleted_reason: null,
          purge_after: null
        }
      ]
    });

    try {
      await withInternalApiSecret("test-internal-secret-value", async () => {
        const req = createMockRequest({
          headers: { "x-internal-api-secret": "test-internal-secret-value" },
          query: { limit: "10" } as never
        });
        const response = await runWithErrorHandler(async (request, res, next) => {
          let middlewareError: unknown;
          requireInternalApiSecret(request, res, (error?: unknown) => {
            if (error) {
              middlewareError = error;
            }
          });

          if (middlewareError) {
            next(middlewareError);
            return;
          }

          await internalController.purgeDeletedClients(request, res);
        }, req);

        assert.equal(response.statusCode, 200);
        assert.deepEqual(response.body, {
          data: {
            scanned: 1,
            purged: 1,
            skipped: 0,
            storageDeleted: 0,
            storageDeleteFailed: 0,
            clientIds: ["client-expired"]
          }
        });
        assert.deepEqual(
          supabase.state.clients.map((client) => client.id),
          ["client-retained", "client-active"]
        );
      });
    } finally {
      supabase.restore();
      mock.timers.reset();
    }
  });

  it("deletes appointment image Storage objects before hard-deleting a client", async () => {
    mock.timers.enable({ apis: ["Date"], now: new Date("2026-07-20T12:00:00.000Z") });
    const supabase = installMockSupabase({
      clients: [
        {
          id: "client-expired",
          user_id: USER_ID,
          first_name: "Ava",
          last_name: "Martinez",
          deleted_at: "2026-06-16T12:00:00.000Z",
          deleted_reason: "user_deleted",
          purge_after: "2026-07-16T12:00:00.000Z"
        }
      ],
      appointment_images: [
        {
          id: "image-one",
          user_id: USER_ID,
          client_id: "client-expired",
          storage_path: "users/client-expired/image.jpg",
          thumbnail_path: "users/client-expired/image_thumb.jpg"
        }
      ]
    });
    const storage = installStorageMock();

    try {
      const result = await internalController.purgeDeletedClients(
        createMockRequest({ query: { limit: 10 } as never }),
        createMockResponse().res
      );

      assert.equal(result, undefined);
      assert.deepEqual(storage.calls.remove, [["users/client-expired/image.jpg", "users/client-expired/image_thumb.jpg"]]);
      assert.deepEqual(supabase.state.clients, []);
    } finally {
      storage.restore();
      supabase.restore();
      mock.timers.reset();
    }
  });

  it("skips client hard delete when appointment image Storage cleanup fails", async () => {
    mock.timers.enable({ apis: ["Date"], now: new Date("2026-07-20T12:00:00.000Z") });
    const supabase = installMockSupabase({
      clients: [
        {
          id: "client-expired",
          user_id: USER_ID,
          first_name: "Ava",
          last_name: "Martinez",
          deleted_at: "2026-06-16T12:00:00.000Z",
          deleted_reason: "user_deleted",
          purge_after: "2026-07-16T12:00:00.000Z"
        }
      ],
      appointment_images: [
        {
          id: "image-one",
          user_id: USER_ID,
          client_id: "client-expired",
          storage_path: "users/client-expired/image.jpg",
          thumbnail_path: "users/client-expired/image_thumb.jpg"
        }
      ]
    });
    const storage = installStorageMock({
      removeError: {
        message: "Storage unavailable",
        statusCode: "500"
      }
    });

    try {
      const { response, res } = createMockResponse();
      await internalController.purgeDeletedClients(createMockRequest({ query: { limit: 10 } as never }), res);

      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.body, {
        data: {
          scanned: 1,
          purged: 0,
          skipped: 1,
          storageDeleted: 0,
          storageDeleteFailed: 2,
          clientIds: []
        }
      });
      assert.deepEqual(supabase.state.clients.map((client) => client.id), ["client-expired"]);
    } finally {
      storage.restore();
      supabase.restore();
      mock.timers.reset();
    }
  });

  it("does not run the purge without the internal API secret", async () => {
    await withInternalApiSecret("test-internal-secret-value", async () => {
      const response = await runWithErrorHandler(
        (request, res, next) => requireInternalApiSecret(request, res, next),
        createMockRequest({ headers: { "x-internal-api-secret": "wrong-secret" } })
      );

      assert.equal(response.statusCode, 401);
      assert.deepEqual(response.body, {
        error: {
          message: "Invalid internal API secret",
          details: undefined
        }
      });
    });
  });
});
