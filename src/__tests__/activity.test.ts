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
const { listActivityQuerySchema, activityFeedResponseSchema, appointmentActivityResponseSchema } =
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
        stylist_id: userId,
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
          stylist_id: userId,
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
          stylist_id: userId,
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
          stylist_id: userId,
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
          stylist_id: userId,
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
          stylist_id: otherUserId,
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
              reminders_sent: 1
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
              reminders_sent: 0
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
          stylist_id: userId,
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
              reminders_sent: 0
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
          stylist_id: userId,
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
          stylist_id: userId,
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
          stylist_id: userId,
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
          stylist_id: userId,
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
          stylist_id: userId,
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
          stylist_id: userId,
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
          stylist_id: userId,
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
          stylist_id: userId,
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
            reminders_sent: 0
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
});
