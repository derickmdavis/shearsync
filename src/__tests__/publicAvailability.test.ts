import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NextFunction, Request, Response } from "express";
import { getCurrentLocalDate } from "../lib/timezone";

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = process.env.AUTH_MODE ?? "production";
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key";

const { installMockSupabase } = require("./helpers/mockSupabase") as typeof import("./helpers/mockSupabase");
const { publicController } = require("../controllers/publicController") as typeof import("../controllers/publicController");
const { errorHandler } = require("../middleware/errorHandler") as typeof import("../middleware/errorHandler");
const { getPublicAvailabilitySlotsSchema } =
  require("../validators/publicBookingValidators") as typeof import("../validators/publicBookingValidators");

const userId = "11111111-1111-1111-1111-111111111111";
const ownedServiceId = "33333333-3333-4333-8333-333333333333";

interface MockResponse {
  statusCode: number;
  body: unknown;
}

const getNthWeekdayOfMonth = (year: number, monthIndex: number, weekday: number, occurrence: number): string => {
  let matchCount = 0;

  for (let day = 1; day <= 31; day += 1) {
    const date = new Date(Date.UTC(year, monthIndex, day));

    if (date.getUTCMonth() !== monthIndex) {
      break;
    }

    if (date.getUTCDay() !== weekday) {
      continue;
    }

    matchCount += 1;

    if (matchCount === occurrence) {
      return `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }

  throw new Error("Unable to resolve nth weekday of month");
};

const getNextUsDstSpringForwardDate = (timeZone: string): string => {
  const today = getCurrentLocalDate(timeZone);
  const currentYear = Number(today.slice(0, 4));
  const candidate = getNthWeekdayOfMonth(currentYear, 2, 0, 2);

  if (candidate > today) {
    return candidate;
  }

  return getNthWeekdayOfMonth(currentYear + 1, 2, 0, 2);
};

const getNextUsDstFallBackDate = (timeZone: string): string => {
  const today = getCurrentLocalDate(timeZone);
  const currentYear = Number(today.slice(0, 4));
  const candidate = getNthWeekdayOfMonth(currentYear, 10, 0, 1);

  if (candidate > today) {
    return candidate;
  }

  return getNthWeekdayOfMonth(currentYear + 1, 10, 0, 1);
};

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

describe("Public availability DST handling", () => {
  it("skips nonexistent spring-forward local times when generating public slots", async () => {
    const timeZone = "America/Denver";
    const springForwardDate = getNextUsDstSpringForwardDate(timeZone);
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "maya@example.com",
          timezone: timeZone
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
          day_of_week: 0,
          start_time: "01:00:00",
          end_time: "04:00:00",
          is_active: true
        }
      ],
      appointments: []
    });

    try {
      const req = createMockRequest({
        params: { slug: "maya-johnson" },
        query: getPublicAvailabilitySlotsSchema.parse({
          service_id: ownedServiceId,
          date: springForwardDate
        })
      });
      const response = await runWithErrorHandler((request, res) => publicController.getAvailabilitySlots(request, res), req);
      const slots = ((response.body as { data: { slots: Array<{ start: string; end: string }> } }).data.slots);

      assert.equal(response.statusCode, 200);
      assert.equal(slots.length, 7);
      assert.ok(slots.some((slot) => slot.start.includes("T01:00:00-07:00")));
      assert.ok(slots.some((slot) => slot.start.includes("T03:00:00-06:00")));
      assert.equal(slots.some((slot) => slot.start.includes("T02:")), false);
      assert.equal(new Set(slots.map((slot) => slot.start)).size, slots.length);
    } finally {
      supabase.restore();
    }
  });

  it("keeps fall-back availability slot starts unique across the offset change", async () => {
    const timeZone = "America/Denver";
    const fallBackDate = getNextUsDstFallBackDate(timeZone);
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "maya@example.com",
          timezone: timeZone
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
          day_of_week: 0,
          start_time: "00:00:00",
          end_time: "03:00:00",
          is_active: true
        }
      ],
      appointments: []
    });

    try {
      const req = createMockRequest({
        params: { slug: "maya-johnson" },
        query: getPublicAvailabilitySlotsSchema.parse({
          service_id: ownedServiceId,
          date: fallBackDate
        })
      });
      const response = await runWithErrorHandler((request, res) => publicController.getAvailabilitySlots(request, res), req);
      const slots = ((response.body as { data: { slots: Array<{ start: string; end: string }> } }).data.slots);

      assert.equal(response.statusCode, 200);
      assert.equal(new Set(slots.map((slot) => slot.start)).size, slots.length);
      assert.ok(slots.some((slot) => slot.start.includes("T01:00:00-06:00")));
      assert.ok(slots.some((slot) => slot.start.includes("T02:00:00-07:00")));
      assert.ok(slots.some((slot) => slot.end.endsWith("-06:00")));
      assert.ok(slots.some((slot) => slot.end.endsWith("-07:00")));
    } finally {
      supabase.restore();
    }
  });
});
