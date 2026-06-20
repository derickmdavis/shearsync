import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NextFunction, Request, Response } from "express";

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = process.env.AUTH_MODE ?? "production";
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key";
process.env.WEB_APP_URL = "https://dripdesk.example";

const { installMockSupabase } = require("./helpers/mockSupabase") as typeof import("./helpers/mockSupabase");
const { clientsController } = require("../controllers/clientsController") as typeof import("../controllers/clientsController");
const { publicController } = require("../controllers/publicController") as typeof import("../controllers/publicController");
const { errorHandler } = require("../middleware/errorHandler") as typeof import("../middleware/errorHandler");
const { validate } = require("../middleware/validate") as typeof import("../middleware/validate");
const { referralCodeParamSchema, uuidParamSchema } =
  require("../validators/common") as typeof import("../validators/common");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";
const CLIENT_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_CLIENT_ID = "44444444-4444-4444-8444-444444444444";
const REFERRAL_LINK_ID = "55555555-5555-4555-8555-555555555555";

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
    auth: { userId: USER_ID, email: "stylist@example.com", source: "dev" },
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

const installReferralEndpointMockSupabase = () =>
  installMockSupabase({
    users: [
      {
        id: USER_ID,
        email: "stylist@example.com"
      },
      {
        id: OTHER_USER_ID,
        email: "other@example.com"
      }
    ],
    stylists: [
      {
        id: "66666666-6666-4666-8666-666666666666",
        user_id: USER_ID,
        slug: "maya",
        display_name: "Maya",
        booking_enabled: true
      }
    ],
    clients: [
      {
        id: CLIENT_ID,
        user_id: USER_ID,
        first_name: "Katie",
        last_name: "Morgan",
        phone_normalized: "+15551230000",
        email: "katie@example.com",
        deleted_at: null
      },
      {
        id: OTHER_CLIENT_ID,
        user_id: OTHER_USER_ID,
        first_name: "Other",
        last_name: "Client",
        deleted_at: null
      }
    ],
    client_referral_links: [
      {
        id: REFERRAL_LINK_ID,
        user_id: USER_ID,
        client_id: CLIENT_ID,
        referral_code: "rf_existing01",
        referral_url: "https://dripdesk.example/r/rf_existing01",
        status: "active"
      }
    ],
    referral_events: [],
    appointments: [
      {
        id: "77777777-7777-4777-8777-777777777777",
        user_id: USER_ID,
        client_id: "88888888-8888-4888-8888-888888888888",
        service_name: "Cut",
        appointment_date: "2026-06-21T18:00:00.000Z",
        status: "scheduled",
        referred_by_client_id: CLIENT_ID,
        referral_link_id: REFERRAL_LINK_ID,
        referral_attributed_at: "2026-06-20T18:30:00.000Z"
      }
    ]
  });

describe("referral endpoints", () => {
  it("returns and creates client referral links for the authenticated stylist", async () => {
    const supabase = installReferralEndpointMockSupabase();

    try {
      const getResponse = await runWithErrorHandler(
        (request, res) => clientsController.getReferralLink(request, res),
        createMockRequest({ params: { id: CLIENT_ID } })
      );

      assert.equal(getResponse.statusCode, 200);
      assert.equal((getResponse.body as { data: { referral_code: string } }).data.referral_code, "rf_existing01");

      supabase.state.client_referral_links = [];
      const createResponse = await runWithErrorHandler(
        (request, res) => clientsController.createReferralLink(request, res),
        createMockRequest({ params: { id: CLIENT_ID } })
      );

      assert.equal(createResponse.statusCode, 201);
      assert.match(String((createResponse.body as { data: { referral_code: string } }).data.referral_code), /^rf_[0-9a-f]{12}$/);
      assert.equal(supabase.state.client_referral_links.length, 1);
    } finally {
      supabase.restore();
    }
  });

  it("rejects referral link access for another stylist's client", async () => {
    const supabase = installReferralEndpointMockSupabase();

    try {
      const response = await runWithErrorHandler(
        (request, res) => clientsController.createReferralLink(request, res),
        createMockRequest({ params: { id: OTHER_CLIENT_ID } })
      );

      assert.equal(response.statusCode, 400);
      assert.match((response.body as { error: { message: string } }).error.message, /Client does not belong/);
    } finally {
      supabase.restore();
    }
  });

  it("returns referral stats for a client", async () => {
    const supabase = installReferralEndpointMockSupabase();

    try {
      const response = await runWithErrorHandler(
        (request, res) => clientsController.getReferralStats(request, res),
        createMockRequest({ params: { id: CLIENT_ID } })
      );

      assert.equal(response.statusCode, 200);
      assert.equal((response.body as { data: { totalAttributedBookings: number } }).data.totalAttributedBookings, 1);
    } finally {
      supabase.restore();
    }
  });

  it("resolves a public referral code", async () => {
    const supabase = installReferralEndpointMockSupabase();

    try {
      const response = await runWithErrorHandler(
        (request, res) => publicController.resolveReferral(request, res),
        createMockRequest({ auth: undefined, params: { referralCode: "rf_existing01" } })
      );

      assert.equal(response.statusCode, 200);
      assert.equal((response.body as { data: { stylistSlug: string; bookingUrl: string } }).data.stylistSlug, "maya");
      assert.equal(
        (response.body as { data: { bookingUrl: string } }).data.bookingUrl,
        "https://dripdesk.example/book/maya?ref=rf_existing01"
      );
      assert.equal(supabase.state.referral_events.length, 1);
      assert.equal(supabase.state.referral_events[0].event_type, "opened");
    } finally {
      supabase.restore();
    }
  });

  it("validates referral endpoint params", async () => {
    const invalidUuidResponse = await runWithErrorHandler(
      (request, res, next) =>
        validate({ params: uuidParamSchema })(request, res, (error) => {
          if (error) {
            next(error);
          }
        }),
      createMockRequest({ params: { id: "not-a-uuid" } })
    );
    const invalidReferralResponse = await runWithErrorHandler(
      (request, res, next) =>
        validate({ params: referralCodeParamSchema })(request, res, (error) => {
          if (error) {
            next(error);
          }
        }),
      createMockRequest({ params: { referralCode: "bad" } })
    );

    assert.equal(invalidUuidResponse.statusCode, 400);
    assert.equal(invalidReferralResponse.statusCode, 400);
  });
});
