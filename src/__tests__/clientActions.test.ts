import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type { NextFunction, Request, Response } from "express";

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = process.env.AUTH_MODE ?? "production";
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key";

const { installMockSupabase } = require("./helpers/mockSupabase") as typeof import("./helpers/mockSupabase");
const { clientActionsController } =
  require("../controllers/clientActionsController") as typeof import("../controllers/clientActionsController");
const { errorHandler } = require("../middleware/errorHandler") as typeof import("../middleware/errorHandler");

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

describe("Client actions handler", () => {
  it("returns pending-approval and rebook actions with frontend-ready previews", async () => {
    mock.timers.enable({ apis: ["Date"], now: new Date("2026-04-30T12:00:00.000Z") });
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          timezone: "UTC"
        }
      ],
      clients: [
        {
          id: "client-1",
          user_id: userId,
          first_name: "Jane",
          last_name: "Doe"
        },
        {
          id: "client-2",
          user_id: userId,
          first_name: "Taylor",
          last_name: "Banks"
        },
        {
          id: "client-3",
          user_id: userId,
          first_name: "Morgan",
          last_name: "Reed"
        },
        {
          id: "client-4",
          user_id: userId,
          first_name: "Avery",
          last_name: "Cole"
        },
        {
          id: "client-5",
          user_id: userId,
          first_name: "Jordan",
          last_name: "Parks"
        },
        {
          id: "client-6",
          user_id: userId,
          first_name: "Riley",
          last_name: "Stone"
        },
        {
          id: "client-7",
          user_id: userId,
          first_name: "Casey",
          last_name: "Lane"
        }
      ],
      appointments: [
        {
          id: "appt-1",
          user_id: userId,
          client_id: "client-2",
          appointment_date: "2026-05-10T09:00:00.000Z",
          service_name: "Silk Press",
          status: "pending"
        },
        {
          id: "appt-2",
          user_id: userId,
          client_id: "client-1",
          appointment_date: "2026-05-08T09:00:00.000Z",
          service_name: "Consultation",
          status: "pending"
        },
        {
          id: "appt-3",
          user_id: userId,
          client_id: "client-3",
          appointment_date: "2025-11-20T09:00:00.000Z",
          service_name: "Color Refresh",
          status: "completed"
        },
        {
          id: "appt-4",
          user_id: userId,
          client_id: "client-4",
          appointment_date: "2026-01-30T09:00:00.000Z",
          service_name: "Trim",
          status: "completed"
        },
        {
          id: "appt-5",
          user_id: userId,
          client_id: "client-5",
          appointment_date: "2026-02-01T09:00:00.000Z",
          service_name: "Silk Press",
          status: "completed"
        },
        {
          id: "appt-6",
          user_id: userId,
          client_id: "client-6",
          appointment_date: "2026-01-15T09:00:00.000Z",
          service_name: "Loc Retwist",
          status: "completed"
        },
        {
          id: "appt-7",
          user_id: userId,
          client_id: "client-6",
          appointment_date: "2026-05-12T09:00:00.000Z",
          service_name: "Loc Retwist",
          status: "scheduled"
        },
        {
          id: "appt-8",
          user_id: userId,
          client_id: "client-7",
          appointment_date: "2026-01-15T09:00:00.000Z",
          service_name: "Blowout",
          status: "completed"
        },
        {
          id: "appt-9",
          user_id: userId,
          client_id: "client-7",
          appointment_date: "2026-04-30T18:00:00.000Z",
          service_name: "Blowout",
          status: "scheduled"
        },
        {
          id: "appt-10",
          user_id: userId,
          client_id: "client-2",
          appointment_date: "2026-05-12T09:00:00.000Z",
          service_name: "Trim",
          status: "scheduled"
        },
        {
          id: "appt-11",
          user_id: userId,
          client_id: "client-1",
          appointment_date: "2025-10-29T09:00:00.000Z",
          service_name: "Bob Cut",
          status: "completed"
        },
        {
          id: "appt-12",
          user_id: otherUserId,
          client_id: "client-foreign",
          appointment_date: "2026-05-07T09:00:00.000Z",
          service_name: "Foreign Service",
          status: "pending"
        }
      ]
    });

    try {
      const req = createMockRequest({ user: { id: userId } as Request["user"] });
      const response = await runWithErrorHandler((request, res) => clientActionsController.getSummary(request, res), req);

      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.body, {
        data: {
          items: [
            {
              id: "pending-appointment-approvals",
              type: "pending_appointment_approvals",
              label: "Appointments requiring approval",
              priority: "high",
              count: 2,
              preview: [
                {
                  appointment_id: "appt-2",
                  client_id: "client-1",
                  client_name: "Jane Doe",
                  appointment_date: "2026-05-08T09:00:00.000Z",
                  service_name: "Consultation",
                  status: "pending"
                },
                {
                  appointment_id: "appt-1",
                  client_id: "client-2",
                  client_name: "Taylor Banks",
                  appointment_date: "2026-05-10T09:00:00.000Z",
                  service_name: "Silk Press",
                  status: "pending"
                }
              ]
            },
            {
              id: "clients-requiring-rebook",
              type: "clients_requiring_rebook",
              label: "Clients requiring rebook",
              priority: "medium",
              count: 2,
              preview: [
                {
                  client_id: "client-3",
                  client_name: "Morgan Reed",
                  last_appointment_date: "2025-11-20T09:00:00.000Z",
                  last_service_name: "Color Refresh"
                },
                {
                  client_id: "client-4",
                  client_name: "Avery Cole",
                  last_appointment_date: "2026-01-30T09:00:00.000Z",
                  last_service_name: "Trim"
                }
              ]
            }
          ]
        }
      });
    } finally {
      supabase.restore();
      mock.timers.reset();
    }
  });

  it("returns an empty actions list when no pending approvals or rebook candidates exist", async () => {
    mock.timers.enable({ apis: ["Date"], now: new Date("2026-04-30T12:00:00.000Z") });
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          timezone: "UTC"
        }
      ],
      clients: [],
      appointments: [
        {
          id: "appt-1",
          user_id: userId,
          client_id: "client-1",
          appointment_date: "2026-05-10T09:00:00.000Z",
          service_name: "Silk Press",
          status: "scheduled"
        }
      ]
    });

    try {
      const req = createMockRequest({ user: { id: userId } as Request["user"] });
      const response = await runWithErrorHandler((request, res) => clientActionsController.getSummary(request, res), req);

      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.body, {
        data: {
          items: []
        }
      });
    } finally {
      supabase.restore();
      mock.timers.reset();
    }
  });
});
