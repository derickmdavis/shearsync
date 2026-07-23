import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { outreachAutomationsService } from "../services/outreachAutomationsService";
import { outreachAutomationsSchema } from "../validators/outreachValidators";
import { ApiError } from "../lib/errors";
import { handleSupabaseError } from "../services/db";
import { installMockSupabase } from "./helpers/mockSupabase";

const userId = "11111111-1111-4111-8111-111111111111";
const clientId = "22222222-2222-4222-8222-222222222222";

describe("outreach automation bootstrap", () => {
  it("returns a valid zero-safe bootstrap for an account with no automation configuration", async () => {
    const supabase = installMockSupabase({
      users: [{ id: userId, timezone: "America/Denver" }]
    });

    try {
      const response = await outreachAutomationsService.getForUser(userId);

      outreachAutomationsSchema.parse(response);
      assert.equal(response.account_timezone, "America/Denver");
      assert.deepEqual(response.summary, { enabled_count: 0, available_count: 2, total_count: 6 });
      assert.equal(response.controls.every((control) => control.pending_approval_count === 0), true);
      assert.equal(response.controls.every((control) => control.queued_count === 0), true);
      assert.equal(response.controls.every((control) => control.templates.length >= 0), true);
      assert.equal(response.customers_reached.unique_clients, 0);
    } finally {
      supabase.restore();
    }
  });

  it("turns a missing Outreach table or column into the actionable schema-readiness response", () => {
    const databaseError = {
      code: "42P01",
      message: 'relation "public.automation_settings" does not exist',
      details: null,
      hint: null,
      name: "PostgrestError"
    };

    assert.throws(
      () => handleSupabaseError(databaseError as never, "Unable to load outreach automation settings"),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.statusCode, 503);
        assert.equal(error.message, "Database schema is out of date; apply the required Supabase migrations.");
        assert.deepEqual(error.details, {
          requiredSchemaVersion: "campaign_delivery_analytics_2026_07_18",
          code: "42P01",
          message: 'relation "public.automation_settings" does not exist',
          details: null,
          hint: null
        });
        return true;
      }
    );
  });

  it("composes settings, capabilities, timing, counts, and metric metadata", async () => {
    const supabase = installMockSupabase({
      users: [{ id: userId, plan_tier: "pro", plan_status: "active", timezone: "America/Denver" }],
      automation_settings: [
        { user_id: userId, key: "email_confirmations", enabled: true },
        { user_id: userId, key: "appointment_reminders", enabled: true },
        { user_id: userId, key: "rebook_nudges", enabled: true },
        { user_id: userId, key: "thank_you_emails", enabled: true }
      ],
      rebook_nudge_settings: [{
        user_id: userId, approval_required: false, default_rebook_interval_days: 120,
        subject_template: "Time to rebook, {{client_name}}", custom_message_block: null
      }],
      birthday_reminder_settings: [{ user_id: userId, approval_required: true }],
      thank_you_email_settings: [{
        user_id: userId, approval_required: false, send_delay_hours: 3,
        subject_template: "Thank you", custom_message_block: null
      }],
      appointment_email_templates: [{
        user_id: userId, email_type: "appointment_reminder",
        subject_template: "Reminder", custom_message_block: null
      }],
      clients: [{ id: clientId, user_id: userId, first_name: "Sara", email: "sara@example.com", deleted_at: null }],
      appointments: [{
        id: "33333333-3333-4333-8333-333333333333", user_id: userId, client_id: clientId,
        appointment_date: "2026-07-25T18:00:00.000Z", service_name: "Cut", status: "scheduled"
      }],
      appointment_email_events: [],
      appointment_reminder_suppressions: [],
      rebook_nudges: [{
        id: "44444444-4444-4444-8444-444444444444", user_id: userId, client_id: clientId,
        status: "queued", approval_required: false, send_after: "2026-07-24T18:00:00.000Z"
      }],
      birthday_reminders: [],
      thank_you_emails: [],
      communication_events: [{
        user_id: userId, client_id: clientId, status: "delivered", message_type: "marketing",
        created_at: new Date().toISOString()
      }],
      reminders: [],
      activity_events: [],
      client_communication_preferences: [],
      global_email_unsubscribes: []
    });

    try {
      const response = await outreachAutomationsService.getForUser(userId);
      outreachAutomationsSchema.parse(response);

      assert.equal(response.controls.length, 6);
      assert.equal(response.controls.some((control) => control.key === "no_show_follow_up"), false);
      assert.equal(response.controls.every((control) => !control.channels.sms.available && !control.channels.sms.enabled), true);

      const reminder = response.controls.find((control) => control.key === "appointment_reminders");
      assert.deepEqual(reminder?.timing, { lead_time_minutes: 1440, lead_time_editable: false });
      assert.equal(reminder?.scheduled_count, 1);

      const rebook = response.controls.find((control) => control.key === "rebook_nudges");
      assert.equal(rebook?.mode, "automatic");
      assert.equal(rebook?.mutation?.path, "/api/settings/rebook-nudges");
      assert.equal(rebook?.settings.defaultRebookIntervalDays, 120);

      const thankYou = response.controls.find((control) => control.key === "thank_you_emails");
      assert.equal(thankYou?.mutation?.path, "/api/settings/thank-you-emails");
      assert.equal(thankYou?.settings.sendDelayHours, 3);

      assert.equal(response.customers_reached.unique_clients, 1);
      assert.equal(response.customers_reached.window_kind, "rolling");
      assert.equal(response.customers_reached.window_days, 30);
    } finally {
      supabase.restore();
    }
  });
});
