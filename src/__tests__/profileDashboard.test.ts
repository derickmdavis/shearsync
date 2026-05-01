import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NextFunction, Request, Response } from "express";
import {
  addDays,
  getCurrentLocalDate,
  getLocalDayOfWeekForDate,
  getStartOfLocalDayUtc,
  zonedDateTimeToUtc
} from "../lib/timezone";

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = process.env.AUTH_MODE ?? "production";
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key";

const { installMockSupabase } = require("./helpers/mockSupabase") as typeof import("./helpers/mockSupabase");
const { profileController } = require("../controllers/profileController") as typeof import("../controllers/profileController");
const { dashboardController } = require("../controllers/dashboardController") as typeof import("../controllers/dashboardController");
const { errorHandler } = require("../middleware/errorHandler") as typeof import("../middleware/errorHandler");

const userId = "11111111-1111-1111-1111-111111111111";

interface MockResponse {
  statusCode: number;
  body: unknown;
}

const shiftUtcMonthStartDate = (monthStartDate: string, deltaMonths: number): string => {
  const [yearText, monthText] = monthStartDate.split("-");
  const shifted = new Date(Date.UTC(Number(yearText), Number(monthText) - 1 + deltaMonths, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-01`;
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

describe("Profile and dashboard handlers", () => {
  it("returns the real next upcoming dashboard appointment even when more than 100 older appointments exist", async () => {
    const now = new Date();
    const tomorrowIso = new Date(now.getTime() + 24 * 60 * 60_000).toISOString();
    const pastAppointments = Array.from({ length: 105 }, (_, index) => ({
      id: `past-${String(index + 1).padStart(3, "0")}`,
      user_id: userId,
      client_id: "client-1",
      appointment_date: new Date(now.getTime() - (105 - index) * 60 * 60_000).toISOString(),
      service_name: "Trim",
      duration_minutes: 60,
      price: 50,
      status: "scheduled",
      client: {
        id: "client-1",
        first_name: "Taylor",
        last_name: "Client"
      }
    }));
    const futureAppointment = {
      id: "future-001",
      user_id: userId,
      client_id: "client-1",
      appointment_date: tomorrowIso,
      service_name: "Color",
      duration_minutes: 90,
      price: 120,
      status: "scheduled",
      client: {
        id: "client-1",
        first_name: "Taylor",
        last_name: "Client"
      }
    };
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "owner@example.com",
          timezone: "UTC"
        }
      ],
      clients: [
        {
          id: "client-1",
          user_id: userId,
          first_name: "Taylor",
          last_name: "Client",
          total_spend: 500
        }
      ],
      reminders: [],
      appointments: [...pastAppointments, futureAppointment]
    });

    try {
      const req = createMockRequest({ user: { id: userId } as Request["user"] });
      const response = await runWithErrorHandler((request, res) => dashboardController.getSummary(request, res), req);
      const dashboard = (response.body as { data: Record<string, unknown> }).data;
      const nextAppointment = dashboard.next_appointment as Record<string, unknown> | null;
      const upcomingAppointments = dashboard.upcoming_appointments as Array<Record<string, unknown>>;
      const recentAppointments = dashboard.recent_appointments as Array<Record<string, unknown>>;
      const appointments = dashboard.appointments as Array<Record<string, unknown>>;

      assert.equal(response.statusCode, 200);
      assert.equal(nextAppointment?.id, "future-001");
      assert.equal(upcomingAppointments.length, 1);
      assert.equal(upcomingAppointments[0]?.id, "future-001");
      assert.ok(appointments.some((appointment) => appointment.id === "future-001"));
      assert.equal(recentAppointments.length, 100);
      assert.equal(recentAppointments[0]?.id, "past-105");
    } finally {
      supabase.restore();
    }
  });

  it("returns a real profile overview", async () => {
    const now = new Date();
    const today = getCurrentLocalDate("UTC", now);
    const tomorrowIso = getStartOfLocalDayUtc(addDays(today, 1), "UTC").toISOString();
    const inThreeDaysIso = getStartOfLocalDayUtc(addDays(today, 3), "UTC").toISOString();
    const twoDaysAgoIso = getStartOfLocalDayUtc(addDays(today, -2), "UTC").toISOString();
    const eightDaysAgoIso = getStartOfLocalDayUtc(addDays(today, -8), "UTC").toISOString();
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "maya@example.com",
          full_name: "Maya Johnson",
          business_name: "Maya Johnson Hair",
          plan_tier: "pro",
          plan_status: "active",
          location_label: "Denver, CO",
          avatar_image_id: "avatar-123",
          timezone: "UTC"
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
          lead_time_hours: 24,
          same_day_booking_allowed: false,
          same_day_booking_cutoff: "17:00:00",
          max_booking_window_days: 90,
          cancellation_window_hours: 24,
          late_cancellation_fee_enabled: false,
          late_cancellation_fee_type: "flat",
          late_cancellation_fee_value: 0,
          allow_cancellation_after_cutoff: false,
          reschedule_window_hours: 24,
          max_reschedules: null,
          same_day_rescheduling_allowed: false,
          preserve_appointment_history: true,
          new_client_approval_required: true,
          new_client_booking_window_days: 30,
          restrict_services_for_new_clients: false,
          restricted_service_ids: []
        }
      ],
      services: [
        {
          id: "service-1",
          user_id: userId,
          name: "Balayage Refresh",
          description: "Refresh existing color",
          category: "Color",
          duration_minutes: 120,
          price: 245,
          is_active: true,
          is_default: false,
          sort_order: 1
        }
      ],
      availability: [
        { id: "a1", user_id: userId, day_of_week: 1, start_time: "09:00:00", end_time: "17:00:00", is_active: true },
        { id: "a2", user_id: userId, day_of_week: 2, start_time: "09:00:00", end_time: "17:00:00", is_active: true },
        { id: "a3", user_id: userId, day_of_week: 3, start_time: "09:00:00", end_time: "17:00:00", is_active: true },
        { id: "a4", user_id: userId, day_of_week: 4, start_time: "09:00:00", end_time: "17:00:00", is_active: true },
        { id: "a5", user_id: userId, day_of_week: 5, start_time: "09:00:00", end_time: "17:00:00", is_active: true },
        { id: "a6", user_id: userId, day_of_week: 6, start_time: "10:00:00", end_time: "15:00:00", is_active: true }
      ],
      appointments: [
        { id: "appt-1", user_id: userId, client_id: "client-1", appointment_date: tomorrowIso, price: 245, status: "scheduled" },
        { id: "appt-2", user_id: userId, client_id: "client-2", appointment_date: inThreeDaysIso, price: 180, status: "scheduled" },
        { id: "appt-3", user_id: userId, client_id: "client-1", appointment_date: twoDaysAgoIso, price: 95, status: "completed" },
        { id: "appt-4", user_id: userId, client_id: "client-1", appointment_date: eightDaysAgoIso, price: 85, status: "completed" }
      ]
    });

    try {
      const req = createMockRequest({ user: { id: userId } as Request["user"] });
      const response = await runWithErrorHandler((request, res) => profileController.getOverview(request, res), req);

      assert.equal(response.statusCode, 200);
      const overview = (response.body as {
        data: {
          avatarImageId: string | null;
          profile: {
            displayName: string;
            planLabel: string;
            locationLabel: string;
          };
          hero: { title: string; appointmentCount: number };
          revenueForecast: { nextMonth: string };
          performance: { periodLabel: string };
          availability: Array<{ day: string; hours: string }>;
          availabilitySettings: { timezone: string; days: Array<{ dayOfWeek: number; isOpen: boolean }> };
          settingsSummary: { booking: { badge: string }; services: { badge: string } };
          services: Array<{ id: string; name: string; duration: string; price: string }>;
          chartPoints: unknown[];
          metrics: unknown[];
        };
      }).data;

      assert.equal(overview.profile.displayName, "Maya Johnson");
      assert.equal(overview.profile.planLabel, "Pro");
      assert.equal(overview.profile.locationLabel, "Denver, CO");
      assert.equal(overview.avatarImageId, "avatar-123");
      assert.equal(overview.hero.title, "Upcoming Revenue");
      assert.equal(overview.hero.appointmentCount, 2);
      assert.equal(overview.revenueForecast.nextMonth, "$425");
      assert.equal(overview.performance.periodLabel, "This Week");
      assert.deepEqual(overview.availability, [
        { day: "Mon - Fri", hours: "9:00 AM - 5:00 PM" },
        { day: "Sat", hours: "10:00 AM - 3:00 PM" }
      ]);
      assert.equal(overview.availabilitySettings.timezone, "UTC");
      assert.equal(overview.availabilitySettings.days.length, 7);
      assert.equal(overview.settingsSummary.booking.badge, "4 rules set");
      assert.equal(overview.settingsSummary.services.badge, "1 service");
      assert.deepEqual(overview.services, [
        {
          id: "service-1",
          name: "Balayage Refresh",
          duration: "2h",
          price: "$245"
        }
      ]);
      assert.equal(Array.isArray(overview.chartPoints), true);
      assert.equal(Array.isArray(overview.metrics), true);
    } finally {
      supabase.restore();
    }
  });

  it("returns monthly business performance metrics when requested", async () => {
    const now = new Date();
    const today = getCurrentLocalDate("UTC", now);
    const currentMonthStartDate = `${today.slice(0, 7)}-01`;
    const previousMonthStartDate = shiftUtcMonthStartDate(currentMonthStartDate, -1);
    const nextMonthStartDate = shiftUtcMonthStartDate(currentMonthStartDate, 1);
    const currentMonthLastDate = addDays(nextMonthStartDate, -1);

    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "maya@example.com",
          full_name: "Maya Johnson",
          timezone: "UTC"
        }
      ],
      stylists: [
        {
          id: "stylist-1",
          user_id: userId,
          display_name: "Maya Johnson"
        }
      ],
      booking_rules: [
        {
          id: "rules-1",
          user_id: userId,
          lead_time_hours: 24,
          same_day_booking_allowed: false,
          same_day_booking_cutoff: "17:00:00",
          max_booking_window_days: 90,
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
          new_client_booking_window_days: 30,
          restrict_services_for_new_clients: false,
          restricted_service_ids: []
        }
      ],
      services: [],
      availability: [],
      appointments: [
        {
          id: "appt-month-1",
          user_id: userId,
          client_id: "client-1",
          appointment_date: getStartOfLocalDayUtc(currentMonthStartDate, "UTC").toISOString(),
          price: 100,
          status: "completed"
        },
        {
          id: "appt-month-2",
          user_id: userId,
          client_id: "client-1",
          appointment_date: getStartOfLocalDayUtc(currentMonthLastDate, "UTC").toISOString(),
          price: 200,
          status: "scheduled"
        },
        {
          id: "appt-prev-month-1",
          user_id: userId,
          client_id: "client-2",
          appointment_date: getStartOfLocalDayUtc(previousMonthStartDate, "UTC").toISOString(),
          price: 50,
          status: "completed"
        }
      ]
    });

    try {
      const req = createMockRequest({
        user: { id: userId } as Request["user"],
        query: { performancePeriod: "month" }
      });
      const response = await runWithErrorHandler((request, res) => profileController.getOverview(request, res), req);

      assert.equal(response.statusCode, 200);
      const overview = (response.body as {
        data: {
          performance: {
            period: string;
            periodLabel: string;
            metrics: Array<{ id: string; value: string; change: string; detail: string }>;
          };
        };
      }).data;

      assert.equal(overview.performance.period, "month");
      assert.equal(overview.performance.periodLabel, "This Month");
      assert.equal(overview.performance.metrics.length, 4);
      assert.deepEqual(
        overview.performance.metrics.map((metric) => ({
          id: metric.id,
          value: metric.value,
          change: metric.change,
          detail: metric.detail
        })),
        [
          { id: "revenue", value: "$300", change: "↑ 500%", detail: "vs last month" },
          { id: "appointments", value: "2", change: "↑ 1", detail: "vs last month" },
          { id: "rebooking-rate", value: "100%", change: "↑ 100%", detail: "vs last month" },
          { id: "avg-ticket", value: "$150", change: "↑ 200%", detail: "vs last month" }
        ]
      );
    } finally {
      supabase.restore();
    }
  });

  it("uses business-local week boundaries for profile overview performance metrics", async () => {
    const timeZone = "America/Denver";
    const today = getCurrentLocalDate(timeZone);
    const mondayOffset = (getLocalDayOfWeekForDate(today, timeZone) + 6) % 7;
    const currentWeekStartDate = addDays(today, -mondayOffset);
    const previousLocalSundayDate = addDays(currentWeekStartDate, -1);
    const currentWeekStartIso = zonedDateTimeToUtc(currentWeekStartDate, timeZone, 0, 30, 0, 0).toISOString();
    const previousWeekLateNightIso = zonedDateTimeToUtc(previousLocalSundayDate, timeZone, 23, 30, 0, 0).toISOString();
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "maya@example.com",
          full_name: "Maya Johnson",
          timezone: timeZone
        }
      ],
      stylists: [
        {
          id: "stylist-1",
          user_id: userId,
          display_name: "Maya Johnson"
        }
      ],
      booking_rules: [
        {
          id: "rules-1",
          user_id: userId,
          lead_time_hours: 24,
          same_day_booking_allowed: false,
          same_day_booking_cutoff: "17:00:00",
          max_booking_window_days: 90,
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
          new_client_booking_window_days: 30,
          restrict_services_for_new_clients: false,
          restricted_service_ids: []
        }
      ],
      services: [],
      availability: [],
      appointments: [
        {
          id: "appt-current-week",
          user_id: userId,
          client_id: "client-1",
          appointment_date: currentWeekStartIso,
          price: 100,
          status: "completed"
        },
        {
          id: "appt-previous-week",
          user_id: userId,
          client_id: "client-2",
          appointment_date: previousWeekLateNightIso,
          price: 50,
          status: "completed"
        }
      ]
    });

    try {
      const req = createMockRequest({ user: { id: userId } as Request["user"] });
      const response = await runWithErrorHandler((request, res) => profileController.getOverview(request, res), req);

      assert.equal(response.statusCode, 200);
      const metrics = (
        response.body as {
          data: {
            performance: {
              period: string;
              periodLabel: string;
              metrics: Array<{ id: string; value: string; change: string; detail: string }>;
            };
          };
        }
      ).data.performance.metrics;

      assert.deepEqual(
        metrics.map((metric) => ({
          id: metric.id,
          value: metric.value,
          change: metric.change,
          detail: metric.detail
        })),
        [
          { id: "revenue", value: "$100", change: "↑ 100%", detail: "vs last week" },
          { id: "appointments", value: "1", change: "0", detail: "vs last week" },
          { id: "rebooking-rate", value: "0%", change: "0%", detail: "vs last week" },
          { id: "avg-ticket", value: "$100", change: "↑ 100%", detail: "vs last week" }
        ]
      );
    } finally {
      supabase.restore();
    }
  });
});
