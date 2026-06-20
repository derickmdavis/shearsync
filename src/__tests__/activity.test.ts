import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type { NextFunction, Request, Response } from "express";

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = process.env.AUTH_MODE ?? "production";
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key";

const { installMockSupabase } = require("./helpers/mockSupabase") as typeof import("./helpers/mockSupabase");
const { appointmentsController } =
  require("../controllers/appointmentsController") as typeof import("../controllers/appointmentsController");
const { remindersController } =
  require("../controllers/remindersController") as typeof import("../controllers/remindersController");
const { activityController } =
  require("../controllers/activityController") as typeof import("../controllers/activityController");
const { errorHandler } = require("../middleware/errorHandler") as typeof import("../middleware/errorHandler");
const { createAppointmentSchema, updateAppointmentSchema } =
  require("../validators/appointmentValidators") as typeof import("../validators/appointmentValidators");
const { updateReminderSchema } =
  require("../validators/reminderValidators") as typeof import("../validators/reminderValidators");
const {
  listActivityQuerySchema,
  activityFeedResponseSchema,
  appointmentActivityResponseSchema,
  recentCancellationsQuerySchema,
  recentCancellationsResponseSchema
} =
  require("../validators/activityValidators") as typeof import("../validators/activityValidators");

const userId = "11111111-1111-1111-1111-111111111111";
const otherUserId = "22222222-2222-2222-2222-222222222222";
const clientId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const secondClientId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const thirdClientId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const foreignClientId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const appointmentId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const secondAppointmentId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const thirdAppointmentId = "99999999-9999-4999-8999-999999999999";
const foreignAppointmentId = "88888888-8888-4888-8888-888888888888";
const reminderId = "77777777-7777-4777-8777-777777777777";

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

describe("Activity handlers", () => {
  it("accepts booking_created as a valid activity_type filter", () => {
    const query = listActivityQuerySchema.parse({ activity_type: "booking_created" });
    assert.equal(query.activity_type, "booking_created");
  });

  it("accepts waitlist_joined as a valid activity_type filter", () => {
    const query = listActivityQuerySchema.parse({ activity_type: "waitlist_joined" });
    assert.equal(query.activity_type, "waitlist_joined");
  });

  it("accepts client_rebook_needed as a valid activity_type filter", () => {
    const query = listActivityQuerySchema.parse({ activity_type: "client_rebook_needed" });
    assert.equal(query.activity_type, "client_rebook_needed");
  });

  it("defaults recent cancellation queries to a 24-hour window", () => {
    const query = recentCancellationsQuerySchema.parse({});
    assert.equal(query.window_hours, 24);
  });

  it("rejects unbounded recent cancellation windows", () => {
    assert.throws(
      () => recentCancellationsQuerySchema.parse({ window_hours: 720 }),
      /Number must be less than or equal to 168/
    );
  });

  it("rejects unsupported activity categories", () => {
    assert.throws(
      () => listActivityQuerySchema.parse({ category: "all" }),
      /Invalid enum value/
    );
  });

  it("rejects appointment_created as an invalid activity_type filter", () => {
    assert.throws(
      () => listActivityQuerySchema.parse({ activity_type: "appointment_created" }),
      /Invalid enum value/
    );
  });

  it("creates a booking_created activity event when an appointment is created", async () => {
    mock.timers.enable({ apis: ["Date"], now: new Date("2026-05-12T10:42:00.000Z") });
    const supabase = installMockSupabase({
      users: [
        { id: userId, timezone: "UTC" }
      ],
      clients: [
        { id: clientId, user_id: userId, first_name: "Sarah", last_name: "Miller" }
      ],
      appointments: [],
      activity_events: []
    });

    try {
      const req = createMockRequest({
        user: { id: userId } as Request["user"],
        body: createAppointmentSchema.parse({
          client_id: clientId,
          appointment_date: "2026-05-12T15:00:00.000Z",
          service_name: "Balayage",
          duration_minutes: 120,
          price: 220
        })
      });

      const response = await runWithErrorHandler((request, res) => appointmentsController.create(request, res), req);

      assert.equal(response.statusCode, 201);
      assert.equal(supabase.state.activity_events.length, 1);
      assert.deepEqual(supabase.state.activity_events[0], {
        id: supabase.state.activity_events[0]?.id,
        created_at: supabase.state.activity_events[0]?.created_at,
        updated_at: supabase.state.activity_events[0]?.updated_at,
        user_id: userId,
        client_id: clientId,
        appointment_id: supabase.state.appointments[0]?.id,
        activity_type: "booking_created",
        title: "Sarah booked Balayage",
        description: "Appointment scheduled for 3:00 PM",
        occurred_at: "2026-05-12T10:42:00.000Z",
        metadata: {
          client_name: "Sarah Miller",
          service_name: "Balayage",
          appointment_start_time: "2026-05-12T15:00:00.000Z"
        },
        dedupe_key: `booking_created:${supabase.state.appointments[0]?.id}`
      });
    } finally {
      supabase.restore();
      mock.timers.reset();
    }
  });

  it("creates an appointment_cancelled activity event when an appointment is cancelled", async () => {
    mock.timers.enable({ apis: ["Date"], now: new Date("2026-05-12T11:15:00.000Z") });
    const supabase = installMockSupabase({
      users: [
        { id: userId, timezone: "UTC" }
      ],
      clients: [
        { id: clientId, user_id: userId, first_name: "Jessica", last_name: "Lane" }
      ],
      appointments: [
        {
          id: appointmentId,
          user_id: userId,
          client_id: clientId,
          appointment_date: "2026-05-12T18:00:00.000Z",
          service_name: "Haircut",
          duration_minutes: 60,
          status: "scheduled",
          created_at: "2026-05-11T10:00:00.000Z",
          updated_at: "2026-05-11T10:00:00.000Z"
        }
      ],
      activity_events: []
    });

    try {
      const req = createMockRequest({
        user: { id: userId } as Request["user"],
        params: { id: appointmentId },
        body: updateAppointmentSchema.parse({ status: "cancelled" })
      });

      const response = await runWithErrorHandler((request, res) => appointmentsController.update(request, res), req);

      assert.equal(response.statusCode, 200);
      assert.equal(supabase.state.activity_events.length, 1);
      assert.equal(supabase.state.activity_events[0]?.activity_type, "appointment_cancelled");
      assert.equal(supabase.state.activity_events[0]?.title, "Jessica cancelled Haircut");
      assert.equal(
        supabase.state.activity_events[0]?.description,
        "Appointment was scheduled for Tue 6:00 PM"
      );
      assert.deepEqual(supabase.state.activity_events[0]?.metadata, {
        client_name: "Jessica Lane",
        service_name: "Haircut",
        appointment_start_time: "2026-05-12T18:00:00.000Z",
        cancelled_by: "stylist"
      });
    } finally {
      supabase.restore();
      mock.timers.reset();
    }
  });

  it("returns recently cancelled appointments for the cancellation screen", async () => {
    mock.timers.enable({ apis: ["Date"], now: new Date("2026-06-10T18:00:00.000Z") });
    const oldAppointmentId = "12121212-1212-4212-8212-121212121212";
    const metadataFallbackAppointmentId = "34343434-3434-4343-8343-343434343434";
    const supabase = installMockSupabase({
      users: [
        { id: userId, timezone: "UTC" }
      ],
      clients: [
        { id: clientId, user_id: userId, first_name: "Jessica", last_name: "Lane" },
        { id: secondClientId, user_id: userId, first_name: "Mina", last_name: "Patel" }
      ],
      appointments: [
        {
          id: appointmentId,
          user_id: userId,
          client_id: clientId,
          appointment_date: "2026-06-11T15:00:00.000Z",
          service_name: "Haircut",
          status: "cancelled"
        },
        {
          id: metadataFallbackAppointmentId,
          user_id: userId,
          client_id: secondClientId,
          appointment_date: "2026-06-11T16:30:00.000Z",
          service_name: "Gloss",
          status: "cancelled"
        },
        {
          id: oldAppointmentId,
          user_id: userId,
          client_id: clientId,
          appointment_date: "2026-06-09T15:00:00.000Z",
          service_name: "Trim",
          status: "cancelled"
        }
      ],
      activity_events: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          user_id: userId,
          client_id: clientId,
          appointment_id: appointmentId,
          activity_type: "appointment_cancelled",
          title: "Jessica cancelled Haircut",
          description: null,
          occurred_at: "2026-06-10T17:00:00.000Z",
          metadata: {
            client_name: "Jessica Lane",
            service_name: "Haircut",
            appointment_start_time: "2026-06-11T15:00:00.000Z",
            cancelled_by: "client"
          }
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          user_id: userId,
          client_id: secondClientId,
          appointment_id: metadataFallbackAppointmentId,
          activity_type: "appointment_cancelled",
          title: "Mina cancelled Gloss",
          description: null,
          occurred_at: "2026-06-10T16:00:00.000Z",
          metadata: {}
        },
        {
          id: "33333333-3333-4333-8333-333333333333",
          user_id: userId,
          client_id: clientId,
          appointment_id: oldAppointmentId,
          activity_type: "appointment_cancelled",
          title: "Old cancellation",
          description: null,
          occurred_at: "2026-06-09T17:59:59.999Z",
          metadata: {
            client_name: "Jessica Lane",
            service_name: "Trim",
            appointment_start_time: "2026-06-09T15:00:00.000Z",
            cancelled_by: "stylist"
          }
        },
        {
          id: "44444444-4444-4444-8444-444444444444",
          user_id: otherUserId,
          client_id: foreignClientId,
          appointment_id: foreignAppointmentId,
          activity_type: "appointment_cancelled",
          title: "Foreign cancellation",
          description: null,
          occurred_at: "2026-06-10T17:30:00.000Z",
          metadata: {
            client_name: "Other Client",
            service_name: "Color",
            appointment_start_time: "2026-06-11T17:00:00.000Z",
            cancelled_by: "client"
          }
        }
      ]
    });

    try {
      const req = createMockRequest({
        user: { id: userId } as Request["user"],
        query: recentCancellationsQuerySchema.parse({}) as unknown as Request["query"]
      });

      const response = await runWithErrorHandler((request, res) => activityController.recentCancellations(request, res), req);

      assert.equal(response.statusCode, 200);
      const payload = (response.body as { data: unknown }).data;
      recentCancellationsResponseSchema.parse(payload);
      assert.deepEqual(payload, {
        items: [
          {
            appointment_id: appointmentId,
            client_id: clientId,
            client_name: "Jessica Lane",
            appointment_start_time: "2026-06-11T15:00:00.000Z",
            service_names: ["Haircut"],
            cancelled_at: "2026-06-10T17:00:00.000Z",
            cancelled_by: "client"
          },
          {
            appointment_id: metadataFallbackAppointmentId,
            client_id: secondClientId,
            client_name: "Mina Patel",
            appointment_start_time: "2026-06-11T16:30:00.000Z",
            service_names: ["Gloss"],
            cancelled_at: "2026-06-10T16:00:00.000Z",
            cancelled_by: "stylist"
          }
        ]
      });
    } finally {
      supabase.restore();
      mock.timers.reset();
    }
  });

  it("creates an appointment_rescheduled activity event when an appointment is moved", async () => {
    mock.timers.enable({ apis: ["Date"], now: new Date("2026-05-12T11:20:00.000Z") });
    const supabase = installMockSupabase({
      users: [
        { id: userId, timezone: "UTC" }
      ],
      clients: [
        { id: clientId, user_id: userId, first_name: "Mike", last_name: "Chen" }
      ],
      appointments: [
        {
          id: appointmentId,
          user_id: userId,
          client_id: clientId,
          appointment_date: "2026-05-12T16:00:00.000Z",
          service_name: "Color",
          duration_minutes: 90,
          status: "scheduled",
          created_at: "2026-05-11T10:00:00.000Z",
          updated_at: "2026-05-11T10:00:00.000Z"
        }
      ],
      activity_events: []
    });

    try {
      const req = createMockRequest({
        user: { id: userId } as Request["user"],
        params: { id: appointmentId },
        body: updateAppointmentSchema.parse({
          appointment_date: "2026-05-13T17:00:00.000Z"
        })
      });

      const response = await runWithErrorHandler((request, res) => appointmentsController.update(request, res), req);

      assert.equal(response.statusCode, 200);
      assert.equal(supabase.state.activity_events.length, 1);
      assert.equal(supabase.state.activity_events[0]?.activity_type, "appointment_rescheduled");
      assert.equal(supabase.state.activity_events[0]?.title, "Mike rescheduled Color");
      assert.equal(
        supabase.state.activity_events[0]?.description,
        "Moved from Tue 4:00 PM to Wed 5:00 PM"
      );
      assert.deepEqual(supabase.state.activity_events[0]?.metadata, {
        client_name: "Mike Chen",
        service_name: "Color",
        old_start_time: "2026-05-12T16:00:00.000Z",
        new_start_time: "2026-05-13T17:00:00.000Z"
      });
    } finally {
      supabase.restore();
      mock.timers.reset();
    }
  });

  it("creates a reminder_sent activity event and prevents duplicates on retry", async () => {
    const supabase = installMockSupabase({
      users: [
        { id: userId, timezone: "UTC" }
      ],
      clients: [
        { id: clientId, user_id: userId, first_name: "Amanda", last_name: "Reed" }
      ],
      appointments: [
        {
          id: appointmentId,
          user_id: userId,
          client_id: clientId,
          appointment_date: "2026-05-12T15:00:00.000Z",
          service_name: "Silk Press",
          duration_minutes: 60,
          status: "scheduled"
        }
      ],
      reminders: [
        {
          id: reminderId,
          user_id: userId,
          client_id: clientId,
          appointment_id: appointmentId,
          title: "Appointment reminder",
          due_date: "2026-05-12T13:00:00.000Z",
          status: "open",
          channel: "sms",
          reminder_type: "appointment_reminder"
        }
      ],
      activity_events: []
    });

    try {
      const updateBody = updateReminderSchema.parse({
        status: "sent",
        sent_at: "2026-05-12T14:00:00.000Z",
        channel: "sms",
        reminder_type: "appointment_reminder"
      });

      const firstReq = createMockRequest({
        user: { id: userId } as Request["user"],
        params: { id: reminderId },
        body: updateBody
      });

      const firstResponse = await runWithErrorHandler((request, res) => remindersController.update(request, res), firstReq);
      assert.equal(firstResponse.statusCode, 200);
      assert.equal(supabase.state.activity_events.length, 1);
      assert.equal(supabase.state.activity_events[0]?.activity_type, "reminder_sent");
      assert.equal(supabase.state.activity_events[0]?.title, "SMS reminder sent to Amanda");
      assert.equal(
        supabase.state.activity_events[0]?.description,
        "Reminder for today's 3:00 PM appointment"
      );

      const secondReq = createMockRequest({
        user: { id: userId } as Request["user"],
        params: { id: reminderId },
        body: updateBody
      });

      const secondResponse = await runWithErrorHandler((request, res) => remindersController.update(request, res), secondReq);
      assert.equal(secondResponse.statusCode, 200);
      assert.equal(supabase.state.activity_events.length, 1);
    } finally {
      supabase.restore();
    }
  });

  it("returns only the authenticated stylist's activity grouped by day with summary counts", async () => {
    mock.timers.enable({ apis: ["Date"], now: new Date("2026-05-12T20:00:00.000Z") });
    const supabase = installMockSupabase({
      users: [
        { id: userId, timezone: "UTC" },
        { id: otherUserId, timezone: "UTC" }
      ],
      activity_events: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          user_id: userId,
          client_id: clientId,
          appointment_id: appointmentId,
          activity_type: "booking_created",
          title: "Sarah booked Balayage",
          description: "Appointment scheduled for 3:00 PM",
          occurred_at: "2026-05-12T18:00:00.000Z",
          metadata: {
            client_name: "Sarah Miller",
            service_name: "Balayage",
            appointment_start_time: "2026-05-12T15:00:00.000Z"
          }
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          user_id: userId,
          client_id: clientId,
          appointment_id: appointmentId,
          activity_type: "reminder_sent",
          title: "SMS reminder sent to Sarah",
          description: "Reminder for today's 3:00 PM appointment",
          occurred_at: "2026-05-12T10:00:00.000Z",
          metadata: {
            client_name: "Sarah Miller",
            channel: "sms",
            reminder_type: "appointment_reminder",
            appointment_start_time: "2026-05-12T15:00:00.000Z"
          }
        },
        {
          id: "33333333-3333-4333-8333-333333333333",
          user_id: userId,
          client_id: secondClientId,
          appointment_id: secondAppointmentId,
          activity_type: "appointment_cancelled",
          title: "Jessica cancelled Haircut",
          description: "Appointment was scheduled for Sun 6:00 PM",
          occurred_at: "2026-05-11T16:00:00.000Z",
          metadata: {
            client_name: "Jessica Lane",
            service_name: "Haircut",
            appointment_start_time: "2026-05-11T18:00:00.000Z",
            cancelled_by: "client"
          }
        },
        {
          id: "44444444-4444-4444-8444-444444444444",
          user_id: userId,
          client_id: thirdClientId,
          appointment_id: thirdAppointmentId,
          activity_type: "appointment_rescheduled",
          title: "Mike rescheduled Color",
          description: "Moved from Sun 2:00 PM to Mon 3:00 PM",
          occurred_at: "2026-05-11T09:00:00.000Z",
          metadata: {
            client_name: "Mike Chen",
            service_name: "Color",
            old_start_time: "2026-05-11T14:00:00.000Z",
            new_start_time: "2026-05-12T15:00:00.000Z"
          }
        },
        {
          id: "55555555-5555-4555-8555-555555555555",
          user_id: otherUserId,
          client_id: foreignClientId,
          appointment_id: foreignAppointmentId,
          activity_type: "booking_created",
          title: "Foreign booking",
          description: "Should not be returned",
          occurred_at: "2026-05-12T19:00:00.000Z",
          metadata: {
            client_name: "Foreign Client",
            service_name: "Service",
            appointment_start_time: "2026-05-12T19:30:00.000Z"
          }
        }
      ]
    });

    try {
      const req = createMockRequest({
        user: { id: userId } as Request["user"],
        query: listActivityQuerySchema.parse({}) as unknown as Request["query"]
      });

      const response = await runWithErrorHandler((request, res) => activityController.list(request, res), req);

      assert.equal(response.statusCode, 200);
      const payload = (response.body as { data: unknown }).data;
      activityFeedResponseSchema.parse(payload);
      assert.deepEqual(payload, {
        groups: [
          {
            date: "2026-05-12",
            label: "Today",
            summary: {
              new_bookings: 1,
              cancellations: 0,
              reschedules: 0,
              reminders_sent: 1,
              waitlist_joins: 0,
              rebook_needed: 0
            },
            events: [
              {
                id: "11111111-1111-4111-8111-111111111111",
                activity_type: "booking_created",
                title: "Sarah booked Balayage",
                description: "Appointment scheduled for 3:00 PM",
                occurred_at: "2026-05-12T18:00:00.000Z",
                client_id: clientId,
                appointment_id: appointmentId,
                metadata: {
                  client_name: "Sarah Miller",
                  service_name: "Balayage",
                  appointment_start_time: "2026-05-12T15:00:00.000Z"
                }
              },
              {
                id: "22222222-2222-4222-8222-222222222222",
                activity_type: "reminder_sent",
                title: "SMS reminder sent to Sarah",
                description: "Reminder for today's 3:00 PM appointment",
                occurred_at: "2026-05-12T10:00:00.000Z",
                client_id: clientId,
                appointment_id: appointmentId,
                metadata: {
                  client_name: "Sarah Miller",
                  channel: "sms",
                  reminder_type: "appointment_reminder",
                  appointment_start_time: "2026-05-12T15:00:00.000Z"
                }
              }
            ]
          },
          {
            date: "2026-05-11",
            label: "Yesterday",
            summary: {
              new_bookings: 0,
              cancellations: 1,
              reschedules: 1,
              reminders_sent: 0,
              waitlist_joins: 0,
              rebook_needed: 0
            },
            events: [
              {
                id: "33333333-3333-4333-8333-333333333333",
                activity_type: "appointment_cancelled",
                title: "Jessica cancelled Haircut",
                description: "Appointment was scheduled for Sun 6:00 PM",
                occurred_at: "2026-05-11T16:00:00.000Z",
                client_id: secondClientId,
                appointment_id: secondAppointmentId,
                metadata: {
                  client_name: "Jessica Lane",
                  service_name: "Haircut",
                  appointment_start_time: "2026-05-11T18:00:00.000Z",
                  cancelled_by: "client"
                }
              },
              {
                id: "44444444-4444-4444-8444-444444444444",
                activity_type: "appointment_rescheduled",
                title: "Mike rescheduled Color",
                description: "Moved from Sun 2:00 PM to Mon 3:00 PM",
                occurred_at: "2026-05-11T09:00:00.000Z",
                client_id: thirdClientId,
                appointment_id: thirdAppointmentId,
                metadata: {
                  client_name: "Mike Chen",
                  service_name: "Color",
                  old_start_time: "2026-05-11T14:00:00.000Z",
                  new_start_time: "2026-05-12T15:00:00.000Z"
                }
              }
            ]
          }
        ],
        next_cursor: null
      });
    } finally {
      supabase.restore();
      mock.timers.reset();
    }
  });

  it("enriches booking activity with current appointment status", async () => {
    mock.timers.enable({ apis: ["Date"], now: new Date("2026-05-12T20:00:00.000Z") });
    const supabase = installMockSupabase({
      users: [
        { id: userId, timezone: "UTC" }
      ],
      appointments: [
        {
          id: appointmentId,
          user_id: userId,
          status: "pending",
          client_id: clientId,
          appointment_date: "2026-05-12T15:00:00.000Z"
        }
      ],
      activity_events: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          user_id: userId,
          client_id: clientId,
          appointment_id: appointmentId,
          activity_type: "booking_created",
          title: "Sarah booked Balayage",
          description: "Appointment scheduled for 3:00 PM",
          occurred_at: "2026-05-12T18:00:00.000Z",
          metadata: {
            client_name: "Sarah Miller",
            service_name: "Balayage",
            appointment_start_time: "2026-05-12T15:00:00.000Z"
          }
        }
      ]
    });

    try {
      const req = createMockRequest({
        user: { id: userId } as Request["user"],
        query: listActivityQuerySchema.parse({}) as unknown as Request["query"]
      });

      const response = await runWithErrorHandler((request, res) => activityController.list(request, res), req);

      assert.equal(response.statusCode, 200);
      const payload = (response.body as { data: unknown }).data;
      activityFeedResponseSchema.parse(payload);
      assert.deepEqual(payload, {
        groups: [
          {
            date: "2026-05-12",
            label: "Today",
            summary: {
              new_bookings: 1,
              cancellations: 0,
              reschedules: 0,
              reminders_sent: 0,
              waitlist_joins: 0,
              rebook_needed: 0
            },
            events: [
              {
                id: "11111111-1111-4111-8111-111111111111",
                activity_type: "booking_created",
                title: "Sarah booked Balayage",
                description: "Appointment scheduled for 3:00 PM",
                occurred_at: "2026-05-12T18:00:00.000Z",
                client_id: clientId,
                appointment_id: appointmentId,
                current_appointment_status: "pending",
                metadata: {
                  client_name: "Sarah Miller",
                  service_name: "Balayage",
                  appointment_start_time: "2026-05-12T15:00:00.000Z",
                  current_appointment_status: "pending"
                }
              }
            ]
          }
        ],
        next_cursor: null
      });
    } finally {
      supabase.restore();
      mock.timers.reset();
    }
  });

  it("paginates the activity feed with a cursor", async () => {
    const supabase = installMockSupabase({
      users: [
        { id: userId, timezone: "UTC" }
      ],
      activity_events: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          user_id: userId,
          activity_type: "booking_created",
          title: "Event 1",
          description: null,
          occurred_at: "2026-05-12T18:00:00.000Z",
          metadata: {
            client_name: "Sarah Miller",
            service_name: "Balayage",
            appointment_start_time: "2026-05-12T15:00:00.000Z"
          }
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          user_id: userId,
          activity_type: "reminder_sent",
          title: "Event 2",
          description: null,
          occurred_at: "2026-05-12T10:00:00.000Z",
          metadata: {
            client_name: "Sarah Miller",
            channel: "sms",
            reminder_type: "appointment_reminder",
            appointment_start_time: "2026-05-12T15:00:00.000Z"
          }
        },
        {
          id: "33333333-3333-4333-8333-333333333333",
          user_id: userId,
          activity_type: "appointment_cancelled",
          title: "Event 3",
          description: null,
          occurred_at: "2026-05-11T16:00:00.000Z",
          metadata: {
            client_name: "Jessica Lane",
            service_name: "Haircut",
            appointment_start_time: "2026-05-11T18:00:00.000Z",
            cancelled_by: "stylist"
          }
        }
      ]
    });

    try {
      const firstReq = createMockRequest({
        user: { id: userId } as Request["user"],
        query: listActivityQuerySchema.parse({ limit: "2" }) as unknown as Request["query"]
      });

      const firstResponse = await runWithErrorHandler((request, res) => activityController.list(request, res), firstReq);
      assert.equal(firstResponse.statusCode, 200);
      const firstPayload = (firstResponse.body as { data: { next_cursor: string | null; groups: Array<{ events: Array<{ id: string }> }> } }).data;
      assert.equal(firstPayload.groups.length, 1);
      assert.deepEqual(firstPayload.groups[0]?.events.map((event) => event.id), [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222"
      ]);
      assert.equal(typeof firstPayload.next_cursor, "string");

      const secondReq = createMockRequest({
        user: { id: userId } as Request["user"],
        query: listActivityQuerySchema.parse({ limit: "2", cursor: firstPayload.next_cursor as string }) as unknown as Request["query"]
      });

      const secondResponse = await runWithErrorHandler((request, res) => activityController.list(request, res), secondReq);
      assert.equal(secondResponse.statusCode, 200);
      const secondPayload = (secondResponse.body as { data: { next_cursor: string | null; groups: Array<{ events: Array<{ id: string }> }> } }).data;
      assert.deepEqual(secondPayload.groups[0]?.events.map((event) => event.id), [
        "33333333-3333-4333-8333-333333333333"
      ]);
      assert.equal(secondPayload.next_cursor, null);
    } finally {
      supabase.restore();
    }
  });

  it("returns activity events for a single appointment ordered by most recent first", async () => {
    const supabase = installMockSupabase({
      users: [
        { id: userId, timezone: "UTC" }
      ],
      appointments: [
        { id: appointmentId, user_id: userId, client_id: clientId, appointment_date: "2026-05-12T15:00:00.000Z" }
      ],
      activity_events: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          user_id: userId,
          appointment_id: appointmentId,
          activity_type: "reminder_sent",
          title: "SMS reminder sent to Sarah",
          description: null,
          occurred_at: "2026-05-12T14:00:00.000Z",
          metadata: {
            client_name: "Sarah Miller",
            channel: "sms",
            reminder_type: "appointment_reminder",
            appointment_start_time: "2026-05-12T15:00:00.000Z"
          }
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          user_id: userId,
          appointment_id: appointmentId,
          activity_type: "booking_created",
          title: "Sarah booked Balayage",
          description: null,
          occurred_at: "2026-05-12T10:00:00.000Z",
          metadata: {
            client_name: "Sarah Miller",
            service_name: "Balayage",
            appointment_start_time: "2026-05-12T15:00:00.000Z"
          }
        },
        {
          id: "33333333-3333-4333-8333-333333333333",
          user_id: userId,
          appointment_id: secondAppointmentId,
          activity_type: "booking_created",
          title: "Foreign event",
          description: null,
          occurred_at: "2026-05-12T09:00:00.000Z",
          metadata: {
            client_name: "Other Client",
            service_name: "Haircut",
            appointment_start_time: "2026-05-12T16:00:00.000Z"
          }
        }
      ]
    });

    try {
      const req = createMockRequest({
        user: { id: userId } as Request["user"],
        params: { id: appointmentId }
      });

      const response = await runWithErrorHandler((request, res) => appointmentsController.listActivity(request, res), req);

      assert.equal(response.statusCode, 200);
      const payload = (response.body as { data: unknown }).data;
      appointmentActivityResponseSchema.parse(payload);
      assert.deepEqual(payload, {
        events: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            activity_type: "reminder_sent",
            title: "SMS reminder sent to Sarah",
            description: null,
            occurred_at: "2026-05-12T14:00:00.000Z",
            client_id: null,
            appointment_id: appointmentId,
            metadata: {
              client_name: "Sarah Miller",
              channel: "sms",
              reminder_type: "appointment_reminder",
              appointment_start_time: "2026-05-12T15:00:00.000Z"
            }
          },
          {
            id: "22222222-2222-4222-8222-222222222222",
            activity_type: "booking_created",
            title: "Sarah booked Balayage",
            description: null,
            occurred_at: "2026-05-12T10:00:00.000Z",
            client_id: null,
            appointment_id: appointmentId,
            metadata: {
              client_name: "Sarah Miller",
              service_name: "Balayage",
              appointment_start_time: "2026-05-12T15:00:00.000Z"
            }
          }
        ]
      });
    } finally {
      supabase.restore();
    }
  });

  it("filters the activity feed by booking_created", async () => {
    mock.timers.enable({ apis: ["Date"], now: new Date("2026-05-12T20:00:00.000Z") });
    const supabase = installMockSupabase({
      users: [
        { id: userId, timezone: "UTC" }
      ],
      activity_events: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          user_id: userId,
          activity_type: "booking_created",
          title: "Booking event",
          description: null,
          occurred_at: "2026-05-12T18:00:00.000Z",
          metadata: {
            client_name: "Sarah Miller",
            service_name: "Balayage",
            appointment_start_time: "2026-05-12T15:00:00.000Z"
          }
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          user_id: userId,
          activity_type: "reminder_sent",
          title: "Reminder event",
          description: null,
          occurred_at: "2026-05-12T10:00:00.000Z",
          metadata: {
            client_name: "Sarah Miller",
            channel: "sms",
            reminder_type: "appointment_reminder",
            appointment_start_time: "2026-05-12T15:00:00.000Z"
          }
        }
      ]
    });

    try {
      const req = createMockRequest({
        user: { id: userId } as Request["user"],
        query: listActivityQuerySchema.parse({ activity_type: "booking_created" }) as unknown as Request["query"]
      });

      const response = await runWithErrorHandler((request, res) => activityController.list(request, res), req);

      assert.equal(response.statusCode, 200);
      const payload = (response.body as { data: { groups: Array<{ events: Array<{ activity_type: string; id: string }> }> } }).data;
      assert.deepEqual(payload.groups, [
        {
          date: "2026-05-12",
          label: "Today",
          summary: {
            new_bookings: 1,
            cancellations: 0,
            reschedules: 0,
            reminders_sent: 0,
            waitlist_joins: 0,
            rebook_needed: 0
          },
          events: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              activity_type: "booking_created",
              title: "Booking event",
              description: null,
              occurred_at: "2026-05-12T18:00:00.000Z",
              client_id: null,
              appointment_id: null,
              metadata: {
                client_name: "Sarah Miller",
                service_name: "Balayage",
                appointment_start_time: "2026-05-12T15:00:00.000Z"
              }
            }
          ]
        }
      ]);
    } finally {
      supabase.restore();
      mock.timers.reset();
    }
  });

  it("filters the activity feed by waitlist_joined", async () => {
    mock.timers.enable({ apis: ["Date"], now: new Date("2026-05-12T20:00:00.000Z") });
    const supabase = installMockSupabase({
      users: [
        { id: userId, timezone: "UTC" }
      ],
      activity_events: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          user_id: userId,
          activity_type: "waitlist_joined",
          title: "Ava Martinez joined the waitlist",
          description: "Requested 2026-05-14 for Color",
          occurred_at: "2026-05-12T18:00:00.000Z",
          metadata: {
            client_name: "Ava Martinez",
            service_name: "Color",
            requested_date: "2026-05-14",
            requested_time_preference: "Morning preferred",
            source: "public_booking"
          }
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          user_id: userId,
          activity_type: "booking_created",
          title: "Booking event",
          description: null,
          occurred_at: "2026-05-12T10:00:00.000Z",
          metadata: {
            client_name: "Sarah Miller",
            service_name: "Balayage",
            appointment_start_time: "2026-05-12T15:00:00.000Z"
          }
        }
      ]
    });

    try {
      const req = createMockRequest({
        user: { id: userId } as Request["user"],
        query: listActivityQuerySchema.parse({ activity_type: "waitlist_joined" }) as unknown as Request["query"]
      });

      const response = await runWithErrorHandler((request, res) => activityController.list(request, res), req);

      assert.equal(response.statusCode, 200);
      const payload = (response.body as { data: { groups: Array<{ events: Array<{ activity_type: string; id: string }> }> } }).data;
      assert.deepEqual(payload.groups, [
        {
          date: "2026-05-12",
          label: "Today",
          summary: {
            new_bookings: 0,
            cancellations: 0,
            reschedules: 0,
            reminders_sent: 0,
            waitlist_joins: 1,
            rebook_needed: 0
          },
          events: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              activity_type: "waitlist_joined",
              title: "Ava Martinez joined the waitlist",
              description: "Requested 2026-05-14 for Color",
              occurred_at: "2026-05-12T18:00:00.000Z",
              client_id: null,
              appointment_id: null,
              metadata: {
                client_name: "Ava Martinez",
                service_name: "Color",
                requested_date: "2026-05-14",
                requested_time_preference: "Morning preferred",
                source: "public_booking"
              }
            }
          ]
        }
      ]);
    } finally {
      supabase.restore();
      mock.timers.reset();
    }
  });

  it("returns waitlist events as a scoped activity category with total counts", async () => {
    mock.timers.enable({ apis: ["Date"], now: new Date("2026-05-12T20:00:00.000Z") });
    const supabase = installMockSupabase({
      users: [
        { id: userId, timezone: "UTC" }
      ],
      appointments: [
        {
          id: appointmentId,
          user_id: userId,
          client_id: clientId,
          appointment_date: "2026-05-13T15:00:00.000Z",
          service_name: "Balayage",
          status: "pending",
          created_at: "2026-05-12T17:00:00.000Z"
        }
      ],
      activity_events: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          user_id: userId,
          activity_type: "waitlist_joined",
          title: "Ava Martinez joined the waitlist",
          description: "Requested 2026-05-14 for Color",
          occurred_at: "2026-05-12T18:00:00.000Z",
          metadata: {
            client_name: "Ava Martinez",
            service_name: "Color",
            requested_date: "2026-05-14",
            requested_time_preference: "Morning preferred",
            source: "public_booking"
          }
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          user_id: userId,
          activity_type: "appointment_cancelled",
          title: "Cancellation event",
          description: null,
          occurred_at: "2026-05-12T10:00:00.000Z",
          metadata: {
            client_name: "Sarah Miller",
            service_name: "Balayage",
            appointment_start_time: "2026-05-12T15:00:00.000Z",
            cancelled_by: "stylist"
          }
        }
      ]
    });

    try {
      const req = createMockRequest({
        user: { id: userId } as Request["user"],
        query: listActivityQuerySchema.parse({ category: "waitlist" }) as unknown as Request["query"]
      });

      const response = await runWithErrorHandler((request, res) => activityController.list(request, res), req);

      assert.equal(response.statusCode, 200);
      const payload = (response.body as {
        data: {
          category: string;
          counts: { updates: number; approvals: number; waitlist: number; rebook: number };
          groups: Array<{ events: Array<{ id: string; activity_type: string }> }>;
        };
      }).data;
      assert.equal(payload.category, "waitlist");
      assert.deepEqual(payload.counts, {
        updates: 1,
        approvals: 1,
        waitlist: 1,
        rebook: 0
      });
      assert.deepEqual(payload.groups[0]?.events.map((event) => [event.id, event.activity_type]), [
        ["11111111-1111-4111-8111-111111111111", "waitlist_joined"]
      ]);
    } finally {
      supabase.restore();
      mock.timers.reset();
    }
  });

  it("returns pending appointment approvals as an activity category", async () => {
    mock.timers.enable({ apis: ["Date"], now: new Date("2026-05-12T20:00:00.000Z") });
    const supabase = installMockSupabase({
      users: [
        { id: userId, timezone: "UTC" }
      ],
      clients: [
        { id: clientId, user_id: userId, first_name: "Sarah", last_name: "Miller" },
        { id: secondClientId, user_id: userId, first_name: "Jessica", last_name: "Lane" }
      ],
      appointments: [
        {
          id: appointmentId,
          user_id: userId,
          client_id: clientId,
          appointment_date: "2026-05-14T15:00:00.000Z",
          service_name: "Balayage",
          status: "pending",
          created_at: "2026-05-12T18:00:00.000Z"
        },
        {
          id: secondAppointmentId,
          user_id: userId,
          client_id: secondClientId,
          appointment_date: "2026-05-13T16:00:00.000Z",
          service_name: "Haircut",
          status: "scheduled",
          created_at: "2026-05-12T17:00:00.000Z"
        }
      ],
      activity_events: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          user_id: userId,
          activity_type: "reminder_sent",
          title: "Reminder event",
          description: null,
          occurred_at: "2026-05-12T19:00:00.000Z",
          metadata: {
            client_name: "Sarah Miller",
            channel: "sms",
            reminder_type: "appointment_reminder",
            appointment_start_time: "2026-05-14T15:00:00.000Z"
          }
        }
      ]
    });

    try {
      const req = createMockRequest({
        user: { id: userId } as Request["user"],
        query: listActivityQuerySchema.parse({ category: "approvals" }) as unknown as Request["query"]
      });

      const response = await runWithErrorHandler((request, res) => activityController.list(request, res), req);

      assert.equal(response.statusCode, 200);
      const payload = (response.body as { data: unknown }).data;
      activityFeedResponseSchema.parse(payload);
      assert.deepEqual(payload, {
        category: "approvals",
        counts: {
          updates: 0,
          approvals: 1,
          waitlist: 0,
          rebook: 0
        },
        groups: [
          {
            date: "2026-05-12",
            label: "Today",
            summary: {
              new_bookings: 1,
              cancellations: 0,
              reschedules: 0,
              reminders_sent: 0,
              waitlist_joins: 0,
              rebook_needed: 0
            },
            events: [
              {
                id: appointmentId,
                activity_type: "booking_created",
                title: "Sarah booked Balayage",
                description: "Appointment scheduled for 3:00 PM",
                occurred_at: "2026-05-12T18:00:00.000Z",
                client_id: clientId,
                appointment_id: appointmentId,
                current_appointment_status: "pending",
                metadata: {
                  client_name: "Sarah Miller",
                  service_name: "Balayage",
                  appointment_start_time: "2026-05-14T15:00:00.000Z",
                  current_appointment_status: "pending"
                }
              }
            ]
          }
        ],
        next_cursor: null
      });
    } finally {
      supabase.restore();
      mock.timers.reset();
    }
  });

  it("returns clients needing rebook as an activity category", async () => {
    mock.timers.enable({ apis: ["Date"], now: new Date("2026-04-30T12:00:00.000Z") });
    const rebookClientId = "12121212-1212-4212-8212-121212121212";
    const secondRebookClientId = "34343434-3434-4434-8434-343434343434";
    const tooRecentClientId = "56565656-5656-4656-8656-565656565656";
    const futureBookedClientId = "78787878-7878-4787-8787-787878787878";
    const supabase = installMockSupabase({
      users: [
        { id: userId, timezone: "UTC" }
      ],
      clients: [
        { id: rebookClientId, user_id: userId, first_name: "Morgan", last_name: "Reed" },
        { id: secondRebookClientId, user_id: userId, first_name: "Avery", last_name: "Cole" },
        { id: tooRecentClientId, user_id: userId, first_name: "Jordan", last_name: "Parks" },
        { id: futureBookedClientId, user_id: userId, first_name: "Riley", last_name: "Stone" }
      ],
      appointments: [
        {
          id: "10101010-1010-4010-8010-101010101010",
          user_id: userId,
          client_id: rebookClientId,
          appointment_date: "2025-11-20T09:00:00.000Z",
          service_name: "Color Refresh",
          status: "completed"
        },
        {
          id: "20202020-2020-4020-8020-202020202020",
          user_id: userId,
          client_id: secondRebookClientId,
          appointment_date: "2026-01-30T09:00:00.000Z",
          service_name: "Trim",
          status: "completed"
        },
        {
          id: "30303030-3030-4030-8030-303030303030",
          user_id: userId,
          client_id: tooRecentClientId,
          appointment_date: "2026-02-01T09:00:00.000Z",
          service_name: "Silk Press",
          status: "completed"
        },
        {
          id: "40404040-4040-4040-8040-404040404040",
          user_id: userId,
          client_id: futureBookedClientId,
          appointment_date: "2026-01-15T09:00:00.000Z",
          service_name: "Loc Retwist",
          status: "completed"
        },
        {
          id: "50505050-5050-4050-8050-505050505050",
          user_id: userId,
          client_id: futureBookedClientId,
          appointment_date: "2026-05-12T09:00:00.000Z",
          service_name: "Loc Retwist",
          status: "scheduled"
        }
      ],
      activity_events: []
    });

    try {
      const req = createMockRequest({
        user: { id: userId } as Request["user"],
        query: listActivityQuerySchema.parse({ category: "rebook" }) as unknown as Request["query"]
      });

      const response = await runWithErrorHandler((request, res) => activityController.list(request, res), req);

      assert.equal(response.statusCode, 200);
      const payload = (response.body as { data: unknown }).data;
      activityFeedResponseSchema.parse(payload);
      assert.deepEqual(payload, {
        category: "rebook",
        counts: {
          updates: 0,
          approvals: 0,
          waitlist: 0,
          rebook: 2
        },
        groups: [
          {
            date: "2026-01-30",
            label: "Fri, Jan 30",
            summary: {
              new_bookings: 0,
              cancellations: 0,
              reschedules: 0,
              reminders_sent: 0,
              waitlist_joins: 0,
              rebook_needed: 1
            },
            events: [
              {
                id: secondRebookClientId,
                activity_type: "client_rebook_needed",
                title: "Avery is due to rebook",
                description: "Last visit was Trim",
                occurred_at: "2026-01-30T09:00:00.000Z",
                client_id: secondRebookClientId,
                appointment_id: null,
                metadata: {
                  client_name: "Avery Cole",
                  last_appointment_date: "2026-01-30T09:00:00.000Z",
                  last_service_name: "Trim"
                }
              }
            ]
          },
          {
            date: "2025-11-20",
            label: "Thu, Nov 20",
            summary: {
              new_bookings: 0,
              cancellations: 0,
              reschedules: 0,
              reminders_sent: 0,
              waitlist_joins: 0,
              rebook_needed: 1
            },
            events: [
              {
                id: rebookClientId,
                activity_type: "client_rebook_needed",
                title: "Morgan is due to rebook",
                description: "Last visit was Color Refresh",
                occurred_at: "2025-11-20T09:00:00.000Z",
                client_id: rebookClientId,
                appointment_id: null,
                metadata: {
                  client_name: "Morgan Reed",
                  last_appointment_date: "2025-11-20T09:00:00.000Z",
                  last_service_name: "Color Refresh"
                }
              }
            ]
          }
        ],
        next_cursor: null
      });
    } finally {
      supabase.restore();
      mock.timers.reset();
    }
  });

  it("returns updates without waitlist joins or pending approval bookings", async () => {
    mock.timers.enable({ apis: ["Date"], now: new Date("2026-05-12T20:00:00.000Z") });
    const supabase = installMockSupabase({
      users: [
        { id: userId, timezone: "UTC" }
      ],
      appointments: [
        {
          id: appointmentId,
          user_id: userId,
          status: "pending",
          client_id: clientId,
          appointment_date: "2026-05-12T15:00:00.000Z"
        },
        {
          id: secondAppointmentId,
          user_id: userId,
          status: "scheduled",
          client_id: secondClientId,
          appointment_date: "2026-05-12T16:00:00.000Z"
        }
      ],
      activity_events: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          user_id: userId,
          client_id: clientId,
          appointment_id: appointmentId,
          activity_type: "booking_created",
          title: "Pending booking event",
          description: null,
          occurred_at: "2026-05-12T18:00:00.000Z",
          metadata: {
            client_name: "Sarah Miller",
            service_name: "Balayage",
            appointment_start_time: "2026-05-12T15:00:00.000Z"
          }
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          user_id: userId,
          client_id: secondClientId,
          appointment_id: secondAppointmentId,
          activity_type: "booking_created",
          title: "Scheduled booking event",
          description: null,
          occurred_at: "2026-05-12T17:00:00.000Z",
          metadata: {
            client_name: "Jessica Lane",
            service_name: "Haircut",
            appointment_start_time: "2026-05-12T16:00:00.000Z"
          }
        },
        {
          id: "33333333-3333-4333-8333-333333333333",
          user_id: userId,
          activity_type: "waitlist_joined",
          title: "Ava Martinez joined the waitlist",
          description: "Requested 2026-05-14",
          occurred_at: "2026-05-12T16:00:00.000Z",
          metadata: {
            client_name: "Ava Martinez",
            service_name: null,
            requested_date: "2026-05-14",
            requested_time_preference: null,
            source: "public_booking"
          }
        },
        {
          id: "44444444-4444-4444-8444-444444444444",
          user_id: userId,
          client_id: secondClientId,
          appointment_id: secondAppointmentId,
          activity_type: "reminder_sent",
          title: "Reminder event",
          description: null,
          occurred_at: "2026-05-12T15:00:00.000Z",
          metadata: {
            client_name: "Jessica Lane",
            channel: "sms",
            reminder_type: "appointment_reminder",
            appointment_start_time: "2026-05-12T16:00:00.000Z"
          }
        }
      ]
    });

    try {
      const req = createMockRequest({
        user: { id: userId } as Request["user"],
        query: listActivityQuerySchema.parse({ category: "updates" }) as unknown as Request["query"]
      });

      const response = await runWithErrorHandler((request, res) => activityController.list(request, res), req);

      assert.equal(response.statusCode, 200);
      const payload = (response.body as {
        data: {
          category: string;
          counts: { updates: number; approvals: number; waitlist: number; rebook: number };
          groups: Array<{ events: Array<{ id: string }> }>;
        };
      }).data;
      assert.equal(payload.category, "updates");
      assert.deepEqual(payload.counts, {
        updates: 1,
        approvals: 1,
        waitlist: 1,
        rebook: 0
      });
      assert.deepEqual(payload.groups[0]?.events.map((event) => event.id), [
        "22222222-2222-4222-8222-222222222222"
      ]);
    } finally {
      supabase.restore();
      mock.timers.reset();
    }
  });

  it("returns backend-backed activity dashboard data and persists automation settings", async () => {
    mock.timers.enable({ apis: ["Date"], now: new Date("2026-06-06T16:00:00.000Z") });
    const serviceId = "55555555-5555-4555-8555-555555555555";
    const waitlistEntryId = "66666666-6666-4666-8666-666666666666";
    const followUpReminderId = "12121212-1212-4121-8121-121212121212";
    const appointmentReminderId = "34343434-3434-4343-8343-343434343434";
    const duplicateAppointmentReminderId = "45454545-4545-4545-8545-454545454545";
    const supabase = installMockSupabase({
      users: [
        { id: userId, timezone: "UTC", plan_tier: "pro", plan_status: "active" }
      ],
      clients: [
        { id: clientId, user_id: userId, first_name: "Sarah", last_name: "Miller" }
      ],
      appointments: [
        {
          id: appointmentId,
          user_id: userId,
          client_id: clientId,
          service_id: serviceId,
          appointment_date: "2026-06-07T17:00:00.000Z",
          service_name: "Haircut",
          duration_minutes: 60,
          price: 75,
          status: "cancelled",
          booking_source: "internal",
          created_at: "2026-06-01T12:00:00.000Z",
          updated_at: "2026-06-05T12:00:00.000Z"
        },
        {
          id: secondAppointmentId,
          user_id: userId,
          client_id: secondClientId,
          service_id: serviceId,
          appointment_date: "2026-06-08T17:00:00.000Z",
          service_name: "Gloss",
          duration_minutes: 45,
          price: 60,
          status: "pending",
          booking_source: "public",
          created_at: "2026-06-06T14:00:00.000Z",
          updated_at: "2026-06-06T14:00:00.000Z"
        }
      ],
      reminders: [
        {
          id: appointmentReminderId,
          user_id: userId,
          client_id: clientId,
          appointment_id: appointmentId,
          title: "Appointment reminder",
          due_date: "2026-06-07T15:00:00.000Z",
          status: "open",
          channel: "sms",
          reminder_type: "appointment_reminder",
          created_at: "2026-06-05T12:00:00.000Z",
          updated_at: "2026-06-05T12:00:00.000Z"
        },
        {
          id: followUpReminderId,
          user_id: userId,
          client_id: clientId,
          appointment_id: appointmentId,
          title: "Review request",
          due_date: "2026-06-08T15:00:00.000Z",
          status: "open",
          channel: "email",
          reminder_type: "follow_up",
          created_at: "2026-06-05T12:00:00.000Z",
          updated_at: "2026-06-05T12:00:00.000Z"
        },
        {
          id: duplicateAppointmentReminderId,
          user_id: userId,
          client_id: clientId,
          appointment_id: secondAppointmentId,
          title: "Appointment reminder",
          due_date: "2026-06-07T15:55:00.000Z",
          status: "open",
          channel: "email",
          reminder_type: "appointment_reminder",
          created_at: "2026-06-05T12:00:00.000Z",
          updated_at: "2026-06-05T12:00:00.000Z"
        }
      ],
      waitlist_entries: [
        {
          id: waitlistEntryId,
          user_id: userId,
          client_id: clientId,
          service_id: serviceId,
          requested_date: "2026-06-07",
          requested_time_preference: "afternoon",
          client_name: "Sarah Miller",
          client_email: "sarah@example.com",
          client_phone: null,
          note: null,
          status: "active",
          source: "public_booking",
          created_at: "2026-06-04T12:00:00.000Z",
          updated_at: "2026-06-04T12:00:00.000Z"
        }
      ],
      activity_events: [
        {
          id: "98989898-9898-4989-8989-989898989898",
          user_id: userId,
          client_id: clientId,
          appointment_id: appointmentId,
          activity_type: "appointment_cancelled",
          title: "Sarah cancelled Haircut",
          description: null,
          occurred_at: "2026-06-05T18:00:00.000Z",
          metadata: {
            client_name: "Sarah Miller",
            service_name: "Haircut",
            appointment_start_time: "2026-06-07T17:00:00.000Z",
            cancelled_by: "client"
          }
        },
        {
          id: "78787878-7878-4787-8787-787878787878",
          user_id: userId,
          client_id: clientId,
          appointment_id: appointmentId,
          activity_type: "reminder_sent",
          title: "SMS reminder sent to Sarah",
          description: null,
          occurred_at: "2026-06-06T15:00:00.000Z",
          metadata: {
            client_name: "Sarah Miller",
            channel: "sms",
            reminder_type: "appointment_reminder",
            appointment_start_time: "2026-06-07T17:00:00.000Z"
          }
        }
      ],
      appointment_email_events: [
        {
          id: "56565656-5656-4565-8565-565656565656",
          user_id: userId,
          status: "queued",
          created_at: "2026-06-06T15:00:00.000Z"
        },
        {
          id: "67676767-6767-4676-8676-676767676767",
          user_id: userId,
          client_id: clientId,
          appointment_id: secondAppointmentId,
          email_type: "appointment_reminder",
          recipient_email: "sarah@example.com",
          status: "queued",
          created_at: "2026-06-06T15:55:00.000Z",
          template_data: {
            appointment_start_time: "2026-06-08T17:00:00.000Z"
          }
        }
      ],
      automation_settings: [
        {
          id: "90909090-9090-4909-8909-909090909090",
          user_id: userId,
          key: "waitlist_match",
          enabled: false
        },
        {
          user_id: userId,
          key: "rebook_nudges",
          enabled: true
        },
        {
          user_id: userId,
          key: "appointment_reminders",
          enabled: true
        },
        {
          user_id: userId,
          key: "email_confirmations",
          enabled: true
        },
        {
          user_id: userId,
          key: "no_show_follow_up",
          enabled: true
        },
        {
          user_id: userId,
          key: "birthday_reminders",
          enabled: true
        }
      ]
    });

    try {
      const dashboardReq = createMockRequest({
        user: { id: userId } as Request["user"]
      });

      const dashboardResponse = await runWithErrorHandler((request, res) => activityController.dashboard(request, res), dashboardReq);
      assert.equal(dashboardResponse.statusCode, 200);

      const payload = (dashboardResponse.body as {
        data: {
          needs_attention: {
            cancellations_need_review_count: number;
            waitlist_match_count: number;
            pending_approval_count: number;
            pending_reminder_count: number;
            queued_review_request_count: number;
            pending_rebook_nudge_count: number;
            birthday_reminder_count: number;
          };
          cancellation_review_items: Array<{ appointment_id: string; review_status: string }>;
          waitlist_matches: Array<{ waitlist_entry_id: string; matched_opening_start_time: string }>;
          reminder_queue: Array<{ reminder_id: string; status: string; channel?: string }>;
          review_request_queue: Array<{ review_request_id: string; status: string }>;
          automation_health: { score: number; status: string };
          automation_impact_this_week: { booked_count: number; reminders_sent_count: number };
          automation_controls: Array<{ key: string; enabled: boolean; status_label: string }>;
        };
      }).data;

      assert.deepEqual(payload.needs_attention, {
        cancellations_need_review_count: 1,
        waitlist_match_count: 1,
        pending_approval_count: 1,
        pending_reminder_count: 3,
        queued_review_request_count: 1,
        pending_rebook_nudge_count: 0,
        birthday_reminder_count: 0
      });
      assert.deepEqual(payload.cancellation_review_items.map((item) => [item.appointment_id, item.review_status]), [
        [appointmentId, "pending"]
      ]);
      assert.deepEqual(payload.waitlist_matches.map((match) => [match.waitlist_entry_id, match.matched_opening_start_time]), [
        [waitlistEntryId, "2026-06-07T17:00:00.000Z"]
      ]);
      assert.deepEqual(payload.reminder_queue.map((item) => [item.reminder_id, item.status]), [
        [appointmentReminderId, "scheduled"],
        [followUpReminderId, "scheduled"],
        ["67676767-6767-4676-8676-676767676767", "queued"]
      ]);
      assert.equal(payload.reminder_queue.some((item) => item.reminder_id === duplicateAppointmentReminderId), false);
      assert.equal(payload.reminder_queue.find((item) => item.reminder_id === "67676767-6767-4676-8676-676767676767")?.channel, "email");
      assert.deepEqual(payload.review_request_queue.map((item) => [item.review_request_id, item.status]), [
        [followUpReminderId, "queued"]
      ]);
      assert.equal(payload.automation_health.score, 85);
      assert.equal(payload.automation_health.status, "warning");
      assert.equal(payload.automation_impact_this_week.booked_count, 0);
      assert.equal(payload.automation_impact_this_week.reminders_sent_count, 1);
      assert.equal(payload.automation_controls.find((control) => control.key === "email_confirmations")?.enabled, true);
      assert.equal(payload.automation_controls.find((control) => control.key === "email_confirmations")?.status_label, "On for bookings");
      assert.equal(payload.automation_controls.find((control) => control.key === "waitlist_match")?.enabled, false);
      assert.equal(payload.automation_controls.find((control) => control.key === "appointment_reminders")?.status_label, "3 scheduled");

      const updateReq = createMockRequest({
        user: { id: userId } as Request["user"],
        params: { key: "waitlist_match" },
        body: { enabled: true }
      });

      const updateResponse = await runWithErrorHandler((request, res) => activityController.updateAutomationSetting(request, res), updateReq);
      assert.equal(updateResponse.statusCode, 200);
      assert.equal(supabase.state.automation_settings.find((setting) => setting.key === "waitlist_match")?.enabled, true);

      const emailUpdateReq = createMockRequest({
        user: { id: userId } as Request["user"],
        params: { key: "email_confirmations" },
        body: { enabled: false }
      });

      const emailUpdateResponse = await runWithErrorHandler((request, res) => activityController.updateAutomationSetting(request, res), emailUpdateReq);
      assert.equal(emailUpdateResponse.statusCode, 200);
      assert.equal(supabase.state.automation_settings.find((setting) => setting.key === "email_confirmations")?.enabled, false);
    } finally {
      supabase.restore();
      mock.timers.reset();
    }
  });

  it("returns an empty activity dashboard without empty Supabase in filters", async () => {
    mock.timers.enable({ apis: ["Date"], now: new Date("2026-06-06T16:00:00.000Z") });
    const queryLog: Array<{ table: string; operation: "in"; column: string; values: unknown[] }> = [];
    const supabase = installMockSupabase({
      users: [
        { id: userId, timezone: "UTC" }
      ],
      clients: [],
      appointments: [],
      reminders: [],
      waitlist_entries: [],
      activity_events: [],
      appointment_email_events: [],
      automation_settings: []
    }, { queryLog });

    try {
      const dashboardReq = createMockRequest({
        user: { id: userId } as Request["user"]
      });

      const dashboardResponse = await runWithErrorHandler((request, res) => activityController.dashboard(request, res), dashboardReq);
      assert.equal(dashboardResponse.statusCode, 200);

      const payload = (dashboardResponse.body as {
        data: {
          needs_attention: {
            cancellations_need_review_count: number;
            waitlist_match_count: number;
            pending_approval_count: number;
            pending_reminder_count: number;
            queued_review_request_count: number;
            pending_rebook_nudge_count: number;
            birthday_reminder_count: number;
          };
          cancellation_review_count: number;
          cancellation_review_items: unknown[];
          waitlist_match_count: number;
          waitlist_matches: unknown[];
          pending_reminder_count: number;
          scheduled_reminder_count: number;
          reminder_queue: unknown[];
          queued_review_request_count: number;
          review_request_queue: unknown[];
          automation_health: { score: number; status: string; failed_count: number; delayed_count: number; reasons: string[] };
          automation_health_score: number;
          automation_health_status: string;
          failed_automation_count: number;
          delayed_automation_count: number;
          health_reasons: string[];
          automation_impact_this_week: { booked_count: number; total_booking_activity_count: number; recovered_revenue_cents: number; reminders_sent_count: number; openings_filled_count: number };
          recent_activity: unknown[];
          automation_controls: unknown[];
        };
      }).data;

      assert.deepEqual(payload.needs_attention, {
        cancellations_need_review_count: 0,
        waitlist_match_count: 0,
        pending_approval_count: 0,
        pending_reminder_count: 0,
        queued_review_request_count: 0,
        pending_rebook_nudge_count: 0,
        birthday_reminder_count: 0
      });
      assert.equal(payload.cancellation_review_count, 0);
      assert.deepEqual(payload.cancellation_review_items, []);
      assert.equal(payload.waitlist_match_count, 0);
      assert.deepEqual(payload.waitlist_matches, []);
      assert.equal(payload.pending_reminder_count, 0);
      assert.equal(payload.scheduled_reminder_count, 0);
      assert.deepEqual(payload.reminder_queue, []);
      assert.equal(payload.queued_review_request_count, 0);
      assert.deepEqual(payload.review_request_queue, []);
      assert.deepEqual(payload.automation_health, {
        score: 40,
        status: "issue",
        failed_count: 0,
        delayed_count: 0,
        reasons: ["6 automation controls are disabled"]
      });
      assert.equal(payload.automation_health_score, 40);
      assert.equal(payload.automation_health_status, "issue");
      assert.equal(payload.failed_automation_count, 0);
      assert.equal(payload.delayed_automation_count, 0);
      assert.deepEqual(payload.health_reasons, ["6 automation controls are disabled"]);
      assert.deepEqual(payload.automation_impact_this_week, {
        booked_count: 0,
        total_booking_activity_count: 0,
        recovered_revenue_cents: 0,
        reminders_sent_count: 0,
        openings_filled_count: 0
      });
      assert.deepEqual(payload.recent_activity, []);
      assert.equal(payload.automation_controls.length, 6);
      assert.equal(
        (payload.automation_controls as Array<{ key?: string; enabled?: boolean }>)
          .find((control) => control.key === "email_confirmations")?.enabled,
        false
      );
      assert.equal(queryLog.some((entry) => entry.operation === "in" && entry.values.length === 0), false);
    } finally {
      supabase.restore();
      mock.timers.reset();
    }
  });

  it("allows Basic users to toggle core automations but blocks Pro automation controls", async () => {
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          timezone: "UTC",
          plan_tier: "basic",
          plan_status: "active"
        }
      ],
      automation_settings: [
        { user_id: userId, key: "email_confirmations", enabled: true },
        { user_id: userId, key: "appointment_reminders", enabled: true },
        { user_id: userId, key: "rebook_nudges", enabled: true },
        { user_id: userId, key: "birthday_reminders", enabled: true },
        { user_id: userId, key: "waitlist_match", enabled: true },
        { user_id: userId, key: "no_show_follow_up", enabled: true }
      ],
      clients: [],
      appointments: [],
      reminders: [],
      waitlist_entries: [],
      activity_events: [],
      appointment_email_events: [],
      rebook_nudges: [],
      birthday_reminders: []
    });

    try {
      const dashboardResponse = await runWithErrorHandler(
        (request, res) => activityController.dashboard(request, res),
        createMockRequest({ user: { id: userId } as Request["user"] })
      );
      const controls = (dashboardResponse.body as {
        data: {
          automation_controls: Array<{
            key: string;
            enabled: boolean;
            feature_available: boolean;
            status_label: string;
          }>;
        };
      }).data.automation_controls;

      assert.equal(controls.find((control) => control.key === "email_confirmations")?.feature_available, true);
      assert.equal(controls.find((control) => control.key === "email_confirmations")?.enabled, true);
      assert.equal(controls.find((control) => control.key === "appointment_reminders")?.feature_available, true);
      assert.equal(controls.find((control) => control.key === "appointment_reminders")?.enabled, true);

      for (const key of ["rebook_nudges", "birthday_reminders", "waitlist_match", "no_show_follow_up"]) {
        const control = controls.find((item) => item.key === key);
        assert.equal(control?.feature_available, false);
        assert.equal(control?.enabled, false);
        assert.equal(control?.status_label, "Upgrade required");

        const response = await runWithErrorHandler(
          (request, res) => activityController.updateAutomationSetting(request, res),
          createMockRequest({
            user: { id: userId } as Request["user"],
            params: { key },
            body: { enabled: true }
          })
        );
        assert.equal(response.statusCode, 403);
      }

      for (const key of ["email_confirmations", "appointment_reminders"]) {
        const response = await runWithErrorHandler(
          (request, res) => activityController.updateAutomationSetting(request, res),
          createMockRequest({
            user: { id: userId } as Request["user"],
            params: { key },
            body: { enabled: false }
          })
        );
        assert.equal(response.statusCode, 200);
        assert.equal(supabase.state.automation_settings.find((setting) => setting.key === key)?.enabled, false);
      }
    } finally {
      supabase.restore();
    }
  });

  it("does not queue birthday reminders while loading the activity dashboard", async () => {
    mock.timers.enable({ apis: ["Date"], now: new Date("2026-06-06T16:00:00.000Z") });
    const supabase = installMockSupabase({
      users: [
        { id: userId, timezone: "UTC", business_name: "Maya Johnson Hair" }
      ],
      clients: [
        {
          id: clientId,
          user_id: userId,
          first_name: "Jane",
          last_name: "Doe",
          email: "jane@example.com",
          birthday: "1990-06-10"
        }
      ],
      appointments: [],
      reminders: [],
      waitlist_entries: [],
      activity_events: [],
      appointment_email_events: [],
      automation_settings: [],
      birthday_reminders: []
    });

    try {
      const dashboardReq = createMockRequest({
        user: { id: userId } as Request["user"]
      });

      const dashboardResponse = await runWithErrorHandler((request, res) => activityController.dashboard(request, res), dashboardReq);
      assert.equal(dashboardResponse.statusCode, 200);
      assert.deepEqual(supabase.state.birthday_reminders, []);
    } finally {
      supabase.restore();
      mock.timers.reset();
    }
  });

  it("keeps the activity dashboard valid with legacy activity rows and deleted cancellation appointments", async () => {
    mock.timers.enable({ apis: ["Date"], now: new Date("2026-06-06T16:00:00.000Z") });
    const supabase = installMockSupabase({
      users: [
        { id: userId, timezone: "UTC" }
      ],
      clients: [
        { id: clientId, user_id: userId, first_name: "Sarah", last_name: "Miller" }
      ],
      appointments: [
        {
          id: appointmentId,
          user_id: userId,
          client_id: clientId,
          appointment_date: "2026-06-07T17:00:00.000Z",
          service_name: "Haircut",
          duration_minutes: 60,
          status: "scheduled",
          created_at: "2026-06-01T12:00:00.000Z",
          updated_at: "2026-06-05T12:00:00.000Z"
        }
      ],
      reminders: [],
      waitlist_entries: [],
      activity_events: [
        {
          id: "45454545-4545-4545-8545-454545454545",
          user_id: userId,
          client_id: clientId,
          appointment_id: appointmentId,
          activity_type: "appointment_created",
          title: "Sarah booked Haircut",
          description: null,
          occurred_at: "2026-06-05T18:00:00.000Z",
          metadata: {
            client_name: "Sarah Miller",
            service_name: "Haircut",
            appointment_start_time: "2026-06-07T17:00:00.000Z"
          }
        },
        {
          id: "56565656-5656-4565-8565-565656565656",
          user_id: userId,
          client_id: clientId,
          appointment_id: null,
          activity_type: "appointment_cancelled",
          title: "Sarah cancelled Haircut",
          description: null,
          occurred_at: "2026-06-05T17:00:00.000Z",
          metadata: {
            client_name: "Sarah Miller",
            service_name: "Haircut",
            appointment_start_time: "2026-06-07T17:00:00.000Z",
            cancelled_by: "client"
          }
        }
      ],
      appointment_email_events: [],
      automation_settings: []
    });

    try {
      const dashboardReq = createMockRequest({
        user: { id: userId } as Request["user"]
      });

      const dashboardResponse = await runWithErrorHandler((request, res) => activityController.dashboard(request, res), dashboardReq);
      assert.equal(dashboardResponse.statusCode, 200);

      const payload = (dashboardResponse.body as {
        data: {
          recent_activity: Array<{ activity_type: string; appointment_id: string | null }>;
          cancellation_review_count: number;
          cancellation_review_items: Array<{ appointment_id: string | null }>;
        };
      }).data;

      assert.equal(payload.recent_activity[0]?.activity_type, "booking_created");
      assert.equal(payload.recent_activity.some((event) => event.activity_type === "appointment_created"), false);
      assert.equal(payload.cancellation_review_count, 0);
      assert.deepEqual(payload.cancellation_review_items, []);
    } finally {
      supabase.restore();
      mock.timers.reset();
    }
  });
});
