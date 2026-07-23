import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApiError } from "../lib/errors";
import type { ScheduledOutreachItemContract } from "../lib/outreachContracts";
import { appointmentReminderSuppressionsService } from "../services/appointmentReminderSuppressionsService";
import { appointmentRemindersService } from "../services/appointmentRemindersService";
import { outreachScheduledSendsService } from "../services/outreachScheduledSendsService";
import { listScheduledOutreachQuerySchema } from "../validators/outreachScheduledSendsValidators";
import { installMockSupabase } from "./helpers/mockSupabase";

const userId = "11111111-1111-4111-8111-111111111111";
const firstClientId = "22222222-2222-4222-8222-222222222222";
const secondClientId = "33333333-3333-4333-8333-333333333333";
const optedOutClientId = "44444444-4444-4444-8444-444444444444";
const firstAppointmentId = "55555555-5555-4555-8555-555555555555";
const secondAppointmentId = "66666666-6666-4666-8666-666666666666";
const now = new Date("2026-07-18T12:00:00.000Z");
const appointmentStartAt = "2026-07-20T12:00:00.000Z";
const appointmentReminderSendAt = "2026-07-19T12:00:00.000Z";

const baseState = () => ({
  users: [{ id: userId, plan_tier: "pro", plan_status: "active", timezone: "UTC" }],
  automation_settings: [
    { user_id: userId, key: "appointment_reminders", enabled: true },
    { user_id: userId, key: "rebook_nudges", enabled: true },
    { user_id: userId, key: "birthday_reminders", enabled: true },
    { user_id: userId, key: "thank_you_emails", enabled: true }
  ],
  clients: [
    {
      id: firstClientId,
      user_id: userId,
      first_name: "Sarah",
      last_name: "Jones",
      email: "sarah@example.com",
      deleted_at: null
    },
    {
      id: secondClientId,
      user_id: userId,
      first_name: "Alex",
      last_name: "Smith",
      email: "alex@example.com",
      deleted_at: null
    },
    {
      id: optedOutClientId,
      user_id: userId,
      first_name: "Pat",
      last_name: "Lee",
      email: "pat@example.com",
      deleted_at: null
    }
  ],
  appointments: [
    {
      id: firstAppointmentId,
      user_id: userId,
      client_id: firstClientId,
      appointment_date: appointmentStartAt,
      service_name: "Silk Press",
      status: "scheduled"
    },
    {
      id: secondAppointmentId,
      user_id: userId,
      client_id: secondClientId,
      appointment_date: appointmentStartAt,
      service_name: "Trim",
      status: "pending"
    }
  ],
  appointment_email_events: [
    {
      id: "77777777-7777-4777-8777-777777777777",
      user_id: userId,
      client_id: firstClientId,
      appointment_id: firstAppointmentId,
      email_type: "appointment_reminder",
      recipient_email: "sarah@example.com",
      status: "queued",
      created_at: appointmentReminderSendAt,
      template_data: { appointment_start_time: appointmentStartAt }
    }
  ],
  appointment_reminder_suppressions: [],
  rebook_nudges: [
    {
      id: "88888888-8888-4888-8888-888888888888",
      user_id: userId,
      client_id: firstClientId,
      last_appointment_id: null,
      recipient_email: "sarah@example.com",
      status: "queued",
      approval_required: false,
      send_after: appointmentReminderSendAt,
      template_data: {}
    }
  ],
  birthday_reminders: [
    {
      id: "99999999-9999-4999-8999-999999999999",
      user_id: userId,
      client_id: secondClientId,
      recipient_email: "alex@example.com",
      status: "queued",
      scheduled_send_at: appointmentReminderSendAt,
      template_data: {}
    }
  ],
  thank_you_emails: [
    {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      user_id: userId,
      client_id: optedOutClientId,
      appointment_id: null,
      recipient_email: "pat@example.com",
      status: "queued",
      approval_required: false,
      send_after: appointmentReminderSendAt,
      template_data: {}
    }
  ],
  client_communication_preferences: [
    {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      user_id: userId,
      client_id: optedOutClientId,
      email: "pat@example.com",
      email_normalized: "pat@example.com",
      email_marketing_enabled: false,
      email_reminders_enabled: true,
      email_rebooking_enabled: true,
      email_transactional_enabled: true,
      opted_out_all_email: false
    }
  ],
  global_email_unsubscribes: [],
  campaigns: [] as Array<Record<string, unknown>>
});

const appointmentItem = (items: ScheduledOutreachItemContract[], appointmentId: string) =>
  items.find((item) => item.kind === "appointment_reminder" && item.appointment_id === appointmentId);

describe("scheduled outreach read model", () => {
  it("parses canonical comma-separated kind filters and restricts scheduled statuses", () => {
    assert.deepEqual(listScheduledOutreachQuerySchema.parse({
      kind: "birthday_reminder,appointment_reminder,birthday_reminder",
      limit: "10"
    }), {
      status: "queued",
      kind: ["birthday_reminder", "appointment_reminder"],
      limit: 10
    });
    assert.equal(listScheduledOutreachQuerySchema.safeParse({ status: "sent" }).success, false);
    assert.equal(listScheduledOutreachQuerySchema.safeParse({ kind: "review_request" }).success, false);
  });

  it("normalizes, reconciles, filters eligibility, and paginates equal timestamps without duplicates", async () => {
    const supabase = installMockSupabase(baseState());
    try {
      const firstPage = await outreachScheduledSendsService.listForUser(userId, { limit: 2, now });
      assert.equal(firstPage.total_count, 4);
      assert.equal(firstPage.data.length, 2);
      assert.ok(firstPage.next_cursor);

      const secondPage = await outreachScheduledSendsService.listForUser(userId, {
        limit: 2,
        cursor: firstPage.next_cursor ?? undefined,
        now
      });
      const combined = [...firstPage.data, ...secondPage.data];

      assert.equal(combined.length, 4);
      assert.equal(new Set(combined.map((item) => item.id)).size, 4);
      assert.equal(combined.filter((item) => item.appointment_id === firstAppointmentId).length, 1);
      assert.equal(combined.some((item) => item.kind === "thank_you_email"), false);
      assert.deepEqual(combined.map((item) => item.send_at), Array(4).fill(appointmentReminderSendAt));
    } finally {
      supabase.restore();
    }
  });

  it("returns counts from the full filtered eligible set rather than the current page", async () => {
    const supabase = installMockSupabase(baseState());
    try {
      const response = await outreachScheduledSendsService.listForUser(userId, {
        kinds: ["appointment_reminder"],
        limit: 1,
        now
      });

      assert.equal(response.data.length, 1);
      assert.equal(response.total_count, 2);
      assert.ok(response.next_cursor);
    } finally {
      supabase.restore();
    }
  });

  it("filters Today and Tomorrow in the business timezone and returns complete category totals", async () => {
    const state = baseState();
    state.users[0]!.timezone = "America/Denver";
    state.client_communication_preferences = [];
    state.appointments[0]!.appointment_date = "2026-07-25T05:59:59.999Z";
    state.appointments[1]!.appointment_date = "2026-07-26T06:00:00.000Z";
    state.rebook_nudges[0]!.send_after = "2026-07-23T06:00:00.000Z";
    state.birthday_reminders[0]!.scheduled_send_at = "2026-07-25T05:59:59.999Z";
    state.thank_you_emails[0]!.send_after = "2026-07-25T06:00:00.000Z";
    state.campaigns = [{
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      user_id: userId,
      name: "Tomorrow campaign",
      status: "scheduled",
      send_mode: "scheduled",
      scheduled_for: "2026-07-24T18:00:00.000Z",
      scheduled_at: "2026-07-20T18:00:00.000Z"
    }];
    const supabase = installMockSupabase(state);
    try {
      const response = await outreachScheduledSendsService.listForUser(userId, {
        limit: 2,
        window: "today_tomorrow",
        now: new Date("2026-07-23T21:00:00.000Z")
      });

      assert.deepEqual(response.window, {
        kind: "today_tomorrow",
        timezone: "America/Denver",
        starts_at: "2026-07-23T06:00:00.000Z",
        ends_at: "2026-07-25T06:00:00.000Z"
      });
      assert.equal(response.total_count, 4);
      assert.deepEqual(response.category_counts, { reminders: 2, outreach: 1, campaigns: 1 });
      assert.equal(response.data.length, 2);
      assert.ok(response.next_cursor);

      const secondPage = await outreachScheduledSendsService.listForUser(userId, {
        limit: 2,
        window: "today_tomorrow",
        cursor: response.next_cursor ?? undefined,
        now: new Date("2026-07-23T21:00:00.000Z")
      });
      const ids = [...response.data, ...secondPage.data].map((item) => item.id);
      assert.equal(ids.length, 4);
      assert.equal(new Set(ids).size, 4);

      await assert.rejects(
        outreachScheduledSendsService.listForUser(userId, {
          limit: 2,
          window: "today_tomorrow",
          kinds: ["campaign"],
          cursor: response.next_cursor ?? undefined,
          now: new Date("2026-07-23T21:00:00.000Z")
        }),
        (error: unknown) => error instanceof ApiError && error.statusCode === 400
      );
    } finally {
      supabase.restore();
    }
  });

  it("uses local-midnight UTC boundaries across the Denver DST transition", async () => {
    const state = baseState();
    state.users[0]!.timezone = "America/Denver";
    const supabase = installMockSupabase(state);
    try {
      const response = await outreachScheduledSendsService.listForUser(userId, {
        limit: 20,
        window: "today_tomorrow",
        now: new Date("2026-03-08T18:00:00.000Z")
      });

      assert.deepEqual(response.window, {
        kind: "today_tomorrow",
        timezone: "America/Denver",
        starts_at: "2026-03-08T07:00:00.000Z",
        ends_at: "2026-03-10T06:00:00.000Z"
      });
    } finally {
      supabase.restore();
    }
  });

  it("normalizes the existing dashboard queue without issuing another read", () => {
    const response = outreachScheduledSendsService.fromLegacyDashboardQueue([
      {
        automation_key: "rebook_nudges",
        reminder_id: "88888888-8888-4888-8888-888888888888",
        client_id: firstClientId,
        client_name: "Sarah Jones",
        send_at: appointmentReminderSendAt,
        channel: "email",
        status: "queued"
      }
    ], 3);

    assert.equal(response.total_count, 1);
    assert.equal(response.data[0]?.kind, "rebook_nudge");
    assert.equal(response.data[0]?.can_cancel, true);
  });
});

describe("appointment reminder occurrence cancellation", () => {
  it("cancels before event creation and prevents reminder generation", async () => {
    const state = baseState();
    state.appointment_email_events = [];
    state.appointments = [state.appointments[0] as (typeof state.appointments)[number]];
    const supabase = installMockSupabase(state);
    try {
      const feed = await outreachScheduledSendsService.listForUser(userId, { limit: 20, now });
      const reminder = appointmentItem(feed.data, firstAppointmentId);
      assert.ok(reminder);

      const cancelled = await outreachScheduledSendsService.cancelForUser(userId, reminder.id, "Skip Sarah once");
      assert.equal(cancelled.status, "cancelled");
      assert.equal(supabase.state.appointment_reminder_suppressions.length, 1);

      const dueNow = new Date("2026-07-19T12:00:00.000Z");
      const queued = await appointmentRemindersService.queueDueForUser(userId, dueNow);
      assert.deepEqual(queued, { queued: 0, skipped: 1 });
      assert.equal(supabase.state.appointment_email_events.length, 0);
    } finally {
      supabase.restore();
    }
  });

  it("skips an existing queued event and remains idempotent", async () => {
    const supabase = installMockSupabase(baseState());
    try {
      const feed = await outreachScheduledSendsService.listForUser(userId, { limit: 20, now });
      const reminder = appointmentItem(feed.data, firstAppointmentId);
      assert.ok(reminder);

      await outreachScheduledSendsService.cancelForUser(userId, reminder.id, "Skip once");
      await outreachScheduledSendsService.cancelForUser(userId, reminder.id, "Still skip");

      assert.equal(supabase.state.appointment_reminder_suppressions.length, 1);
      assert.equal(supabase.state.appointment_email_events[0]?.status, "skipped");
      assert.equal(supabase.state.appointment_reminder_suppressions[0]?.reason, "Still skip");
    } finally {
      supabase.restore();
    }
  });

  it("makes a rescheduled occurrence eligible without removing the old suppression", async () => {
    const state = baseState();
    state.appointment_email_events = [];
    state.appointments = [state.appointments[0] as (typeof state.appointments)[number]];
    const supabase = installMockSupabase(state);
    try {
      const initialFeed = await outreachScheduledSendsService.listForUser(userId, { limit: 20, now });
      const initialReminder = appointmentItem(initialFeed.data, firstAppointmentId);
      assert.ok(initialReminder);
      await outreachScheduledSendsService.cancelForUser(userId, initialReminder.id, "Skip old time");

      const newStartAt = "2026-07-21T12:00:00.000Z";
      supabase.state.appointments[0]!.appointment_date = newStartAt;
      const nextFeed = await outreachScheduledSendsService.listForUser(userId, { limit: 20, now });
      const nextReminder = appointmentItem(nextFeed.data, firstAppointmentId);

      assert.ok(nextReminder);
      assert.notEqual(nextReminder.id, initialReminder.id);
      assert.equal(await appointmentReminderSuppressionsService.isSuppressed(userId, firstAppointmentId, newStartAt), false);
      assert.equal(supabase.state.appointment_reminder_suppressions.length, 1);
    } finally {
      supabase.restore();
    }
  });

  it("returns conflict without creating suppression after sending begins", async () => {
    const state = baseState();
    state.appointment_email_events[0]!.status = "sending";
    const supabase = installMockSupabase(state);
    try {
      const resourceId = outreachScheduledSendsService.encodeResourceId({
        version: 1,
        kind: "appointment_reminder",
        source_id: firstAppointmentId,
        occurrence_at: appointmentStartAt
      });

      await assert.rejects(
        outreachScheduledSendsService.cancelForUser(userId, resourceId, "Too late"),
        (error: unknown) => error instanceof ApiError && error.statusCode === 409
      );
      assert.equal(supabase.state.appointment_reminder_suppressions.length, 0);
      assert.equal(supabase.state.appointment_email_events[0]?.status, "sending");
    } finally {
      supabase.restore();
    }
  });

  it("dispatches generic cancellation to an existing automation workflow", async () => {
    const supabase = installMockSupabase(baseState());
    try {
      const feed = await outreachScheduledSendsService.listForUser(userId, { limit: 20, now });
      const rebook = feed.data.find((item) => item.kind === "rebook_nudge");
      assert.ok(rebook);

      const cancelled = await outreachScheduledSendsService.cancelForUser(userId, rebook.id, "Not this time");
      assert.equal(cancelled.status, "cancelled");
      assert.equal(supabase.state.rebook_nudges[0]?.status, "cancelled");
    } finally {
      supabase.restore();
    }
  });
});
