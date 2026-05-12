import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NextFunction, Request, Response } from "express";
import { getStartOfLocalDayUtc } from "../lib/timezone";

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = process.env.AUTH_MODE ?? "production";
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key";

const { installMockSupabase } = require("./helpers/mockSupabase") as typeof import("./helpers/mockSupabase");
const { offDaysController } = require("../controllers/offDaysController") as typeof import("../controllers/offDaysController");
const { publicController } = require("../controllers/publicController") as typeof import("../controllers/publicController");
const { errorHandler } = require("../middleware/errorHandler") as typeof import("../middleware/errorHandler");
const { validate } = require("../middleware/validate") as typeof import("../middleware/validate");
const {
  createOffDaySchema,
  listOffDaysQuerySchema,
  updateOffDaySchema
} = require("../validators/offDayValidators") as typeof import("../validators/offDayValidators");
const { getPublicAvailabilitySlotsSchema } =
  require("../validators/publicBookingValidators") as typeof import("../validators/publicBookingValidators");

const userId = "11111111-1111-1111-1111-111111111111";
const otherUserId = "22222222-2222-2222-2222-222222222222";
const ownedServiceId = "33333333-3333-4333-8333-333333333333";
const offDayId = "55555555-5555-4555-8555-555555555555";
const foreignOffDayId = "66666666-6666-4666-8666-666666666666";

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

const runValidation = async (
  req: Request,
  schemas: { body?: unknown; params?: unknown; query?: unknown }
): Promise<MockResponse> =>
  runWithErrorHandler(
    (request, res, next) =>
      validate(schemas as never)(request, res, (error) => {
        if (error) {
          next(error);
        }
      }),
    req
  );

const installOffDayMockSupabase = () =>
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
    stylist_off_days: [
      {
        id: offDayId,
        user_id: userId,
        date: "2026-12-25",
        label: "Christmas Day",
        reason: "Closed for holiday",
        is_recurring: false,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z"
      },
      {
        id: foreignOffDayId,
        user_id: otherUserId,
        date: "2026-12-31",
        label: "Other stylist off day",
        reason: null,
        is_recurring: false,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z"
      }
    ]
  });

describe("Off days", () => {
  it("creates, lists, filters, updates, and deletes off days for the authenticated stylist", async () => {
    const supabase = installOffDayMockSupabase();

    try {
      const createReq = createMockRequest({
        body: createOffDaySchema.parse({
          date: "2026-07-03",
          label: "Vacation",
          reason: "",
          isRecurring: false
        })
      });
      const createResponse = await runWithErrorHandler((request, res) => offDaysController.create(request, res), createReq);
      assert.equal(createResponse.statusCode, 201);
      assert.equal((createResponse.body as { data: { date: string; reason: string | null } }).data.date, "2026-07-03");
      assert.equal((createResponse.body as { data: { reason: string | null } }).data.reason, null);

      const listReq = createMockRequest({
        query: listOffDaysQuerySchema.parse({
          startDate: "2026-07-01",
          endDate: "2026-07-31"
        })
      });
      const listResponse = await runWithErrorHandler((request, res) => offDaysController.list(request, res), listReq);
      const listed = (listResponse.body as { data: Array<{ date: string }> }).data;
      assert.deepEqual(listed.map((offDay) => offDay.date), ["2026-07-03"]);

      const updateReq = createMockRequest({
        params: { id: offDayId },
        body: updateOffDaySchema.parse({
          date: "2026-12-24",
          label: "Christmas Eve",
          reason: "Closing early became closing all day",
          isRecurring: true
        })
      });
      const updateResponse = await runWithErrorHandler((request, res) => offDaysController.update(request, res), updateReq);
      assert.equal(updateResponse.statusCode, 200);
      assert.equal((updateResponse.body as { data: { date: string; isRecurring: boolean } }).data.date, "2026-12-24");
      assert.equal((updateResponse.body as { data: { isRecurring: boolean } }).data.isRecurring, true);

      const deleteReq = createMockRequest({ params: { id: offDayId } });
      const deleteResponse = await runWithErrorHandler((request, res) => offDaysController.delete(request, res), deleteReq);
      assert.equal(deleteResponse.statusCode, 204);
    } finally {
      supabase.restore();
    }
  });

  it("returns 409 for duplicate off day dates", async () => {
    const supabase = installOffDayMockSupabase();

    try {
      const req = createMockRequest({
        body: createOffDaySchema.parse({
          date: "2026-12-25",
          label: "Duplicate"
        })
      });
      const response = await runWithErrorHandler((request, res) => offDaysController.create(request, res), req);

      assert.equal(response.statusCode, 409);
      assert.match((response.body as { error: { message: string } }).error.message, /already exists/);
    } finally {
      supabase.restore();
    }
  });

  it("returns 404 when updating or deleting another user's off day", async () => {
    const supabase = installOffDayMockSupabase();

    try {
      const updateResponse = await runWithErrorHandler(
        (request, res) => offDaysController.update(request, res),
        createMockRequest({
          params: { id: foreignOffDayId },
          body: updateOffDaySchema.parse({ label: "Mine now" })
        })
      );
      assert.equal(updateResponse.statusCode, 404);

      const deleteResponse = await runWithErrorHandler(
        (request, res) => offDaysController.delete(request, res),
        createMockRequest({ params: { id: foreignOffDayId } })
      );
      assert.equal(deleteResponse.statusCode, 404);
    } finally {
      supabase.restore();
    }
  });

  it("rejects invalid date formats", async () => {
    const response = await runValidation(
      createMockRequest({
        body: {
          date: "2026-02-31"
        }
      }),
      { body: createOffDaySchema }
    );

    assert.equal(response.statusCode, 400);
  });

  it("returns no public availability slots on off days and normal slots otherwise", async () => {
    const availableDate = "2026-12-26";
    const availableDayOfWeek = getStartOfLocalDayUtc(availableDate, "UTC").getUTCDay();
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "maya@example.com",
          timezone: "America/Denver"
        }
      ],
      stylists: [
        {
          id: "stylist-1",
          user_id: userId,
          slug: "maya-johnson",
          display_name: "Maya Johnson",
          booking_enabled: true
        }
      ],
      booking_rules: [
        {
          id: "rules-1",
          user_id: userId,
          lead_time_hours: 0,
          same_day_booking_allowed: true,
          same_day_booking_cutoff: "23:59:00",
          max_booking_window_days: 800,
          cancellation_window_hours: 24,
          late_cancellation_fee_enabled: false,
          late_cancellation_fee_type: "flat",
          late_cancellation_fee_value: 0,
          allow_cancellation_after_cutoff: false,
          reschedule_window_hours: 24,
          max_reschedules: null,
          same_day_rescheduling_allowed: false,
          preserve_appointment_history: true,
          new_client_approval_required: false,
          new_client_booking_window_days: 800,
          restrict_services_for_new_clients: false,
          restricted_service_ids: []
        }
      ],
      services: [
        {
          id: ownedServiceId,
          user_id: userId,
          name: "Silk Press",
          duration_minutes: 30,
          price: 95,
          is_active: true,
          is_default: false,
          sort_order: 1
        }
      ],
      availability: [
        {
          id: "availability-1",
          user_id: userId,
          day_of_week: availableDayOfWeek,
          start_time: "10:00:00",
          end_time: "11:00:00",
          is_active: true
        }
      ],
      appointments: [],
      stylist_off_days: [
        {
          id: offDayId,
          user_id: userId,
          date: "2026-12-25",
          label: "Christmas Day",
          reason: "Closed",
          is_recurring: false,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z"
        }
      ]
    });

    try {
      const offDayResponse = await runWithErrorHandler(
        (request, res) => publicController.getAvailabilitySlots(request, res),
        createMockRequest({
          params: { slug: "maya-johnson" },
          query: getPublicAvailabilitySlotsSchema.parse({
            service_id: ownedServiceId,
            date: "2026-12-25"
          })
        })
      );
      assert.deepEqual((offDayResponse.body as { data: { slots: unknown[] } }).data.slots, []);

      const availableResponse = await runWithErrorHandler(
        (request, res) => publicController.getAvailabilitySlots(request, res),
        createMockRequest({
          params: { slug: "maya-johnson" },
          query: getPublicAvailabilitySlotsSchema.parse({
            service_id: ownedServiceId,
            date: availableDate
          })
        })
      );
      assert.ok((availableResponse.body as { data: { slots: unknown[] } }).data.slots.length > 0);
    } finally {
      supabase.restore();
    }
  });
});
