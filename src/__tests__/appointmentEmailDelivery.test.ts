import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type { NextFunction, Request, Response } from "express";

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = process.env.AUTH_MODE ?? "production";
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key";

const { installMockSupabase } =
  require("./helpers/mockSupabase") as typeof import("./helpers/mockSupabase");
const {
  appointmentEmailDeliveryService,
  renderAppointmentEmail
} =
  require("../services/appointmentEmailDeliveryService") as typeof import("../services/appointmentEmailDeliveryService");
const { communicationPreferencesService } =
  require("../services/communicationPreferences") as typeof import("../services/communicationPreferences");
const { appointmentEmailEventsService } =
  require("../services/appointmentEmailEventsService") as typeof import("../services/appointmentEmailEventsService");
const { appointmentEmailTemplatesService } =
  require("../services/appointmentEmailTemplatesService") as typeof import("../services/appointmentEmailTemplatesService");
const { rebookNudgesService } =
  require("../services/rebookNudgesService") as typeof import("../services/rebookNudgesService");
const { birthdayRemindersService } =
  require("../services/birthdayRemindersService") as typeof import("../services/birthdayRemindersService");
const { thankYouEmailsService } =
  require("../services/thankYouEmailsService") as typeof import("../services/thankYouEmailsService");
const { appointmentRemindersService } =
  require("../services/appointmentRemindersService") as typeof import("../services/appointmentRemindersService");
const { communicationPreferenceTokensService } =
  require("../services/communicationPreferenceTokens") as typeof import("../services/communicationPreferenceTokens");
const { communicationsService } =
  require("../services/communicationsService") as typeof import("../services/communicationsService");
const { globalEmailUnsubscribesService } =
  require("../services/globalEmailUnsubscribesService") as typeof import("../services/globalEmailUnsubscribesService");
const { communicationEventsService } =
  require("../services/communicationEvents") as typeof import("../services/communicationEvents");
const { env } = require("../config/env") as typeof import("../config/env");
const { internalController } =
  require("../controllers/internalController") as typeof import("../controllers/internalController");
const { requireInternalApiSecret } =
  require("../middleware/internalAuth") as typeof import("../middleware/internalAuth");
const { errorHandler } = require("../middleware/errorHandler") as typeof import("../middleware/errorHandler");
import type { EmailMessage, EmailProvider } from "../services/appointmentEmailDeliveryService";

const TEST_USER_ID = "11111111-1111-1111-1111-111111111111";
const TEST_CLIENT_ID = "22222222-2222-2222-2222-222222222222";
const allEmailTypes = [
  "appointment_scheduled",
  "appointment_pending",
  "appointment_confirmed",
  "appointment_cancelled",
  "appointment_rescheduled",
  "appointment_reminder",
  "rebooking_prompt",
  "birthday_reminder",
  "thank_you_email"
] as const;
const appointmentEventEmailTypes = [
  "appointment_scheduled",
  "appointment_pending",
  "appointment_confirmed",
  "appointment_cancelled",
  "appointment_rescheduled",
  "appointment_reminder"
] as const;

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

const createRenderTemplateData = (emailType: typeof allEmailTypes[number], emailTemplate?: Record<string, string>) => ({
  recipient_name: "Jane Doe",
  service_name: "Silk Press",
  appointment_start_time: "2099-05-12T16:00:00.000Z",
  appointment_time_display: "Tuesday, May 12, 2099 at 10:00 AM MDT - 11:00 AM MDT",
  duration_minutes: 60,
  business_timezone: "America/Denver",
  business_display_name: "Maya Johnson Hair",
  business_phone: "(720) 555-0100",
  business_email: "maya@example.com",
  management_token: "manage-token",
  management_url: "https://example.com/appointments/manage/manage-token",
  last_service_name: "Silk Press",
  last_appointment_display: "February 12, 2099",
  rebook_url: "https://example.com/book/maya",
  birthday_display: "June 15",
  appointment_date_display: "June 1, 2026",
  referral_url: "https://dripdesk.example/r/rf_abc123",
  referral_code: "rf_abc123",
  qr_code_url: "data:image/png;base64,abc123",
  ...(emailType === "appointment_cancelled" ? { cancelled_by: "stylist" as const } : {}),
  ...(emailType === "appointment_rescheduled" ? { status: "scheduled" } : {}),
  ...(emailType === "rebooking_prompt" ? { message_type: "rebooking_prompt" } : {}),
  ...(emailType === "birthday_reminder" ? { message_type: "birthday_reminder" } : {}),
  ...(emailType === "thank_you_email" ? { message_type: "marketing" } : {}),
  ...(emailTemplate ? { email_template: emailTemplate } : {})
});

describe("appointment email delivery", () => {
  it("saves custom subject and body templates for every automated email type", async () => {
    const supabase = installMockSupabase({
      appointment_email_templates: []
    });

    try {
      for (const emailType of allEmailTypes) {
        const saved = await appointmentEmailTemplatesService.upsertForUser(TEST_USER_ID, emailType, {
          subjectTemplate: `Subject for ${emailType} and {{client_name}}`,
          customMessageBlock: `Body for ${emailType} and {{business_name}}`
        });

        assert.equal(saved.emailType, emailType);
        assert.equal(saved.subjectTemplate, `Subject for ${emailType} and {{client_name}}`);
        assert.equal(saved.customMessageBlock, `Body for ${emailType} and {{business_name}}`);
      }

      const templates = await appointmentEmailTemplatesService.getForUser(TEST_USER_ID);
      assert.equal(supabase.state.appointment_email_templates.length, allEmailTypes.length);
      assert.deepEqual(
        templates.map((template) => template.emailType),
        [...allEmailTypes]
      );
      assert.equal(templates.every((template) => template.configured), true);
    } finally {
      supabase.restore();
    }
  });

  it("renders custom body text and html for every automated email type", () => {
    for (const emailType of allEmailTypes) {
      const message = renderAppointmentEmail({
        id: `${emailType}-email-event`,
        email_type: emailType,
        recipient_email: "jane@example.com",
        template_data: createRenderTemplateData(emailType, {
          subject_template: `Custom {{client_name}} ${emailType}`,
          custom_message_block: `Custom body for {{client_name}} in ${emailType}.`
        })
      });

      assert.equal(message.subject, `Custom Jane Doe ${emailType}`);
      assert.match(message.text, new RegExp(`Custom body for Jane Doe in ${emailType}\\.`));
      assert.match(message.html, new RegExp(`<p>Custom body for Jane Doe in ${emailType}\\.</p>`));
    }
  });

  it("falls back to default subjects and omits custom body text when templates are unset", () => {
    for (const emailType of allEmailTypes) {
      const message = renderAppointmentEmail({
        id: `${emailType}-email-event`,
        email_type: emailType,
        recipient_email: "jane@example.com",
        template_data: createRenderTemplateData(emailType)
      });

      assert.notEqual(message.subject, `Custom Jane Doe ${emailType}`);
      assert.doesNotMatch(message.text, /Custom body for Jane Doe/);
      assert.doesNotMatch(message.html, /Custom body for Jane Doe/);
      assert.match(message.text, /Hi Jane Doe/);
    }
  });

  it("rejects invalid template tokens and overlong subject/body values", () => {
    assert.throws(
      () => appointmentEmailTemplatesService.validateTemplatePayload({ subjectTemplate: "Hello {{unknown_token}}" }),
      /Unsupported email template token: unknown_token/
    );
    assert.throws(
      () => appointmentEmailTemplatesService.validateTemplatePayload({ subjectTemplate: "x".repeat(161) }),
      /Subject template must be 160 characters or fewer/
    );
    assert.throws(
      () => appointmentEmailTemplatesService.validateTemplatePayload({ customMessageBlock: "x".repeat(4001) }),
      /Custom message block must be 4000 characters or fewer/
    );
  });

  it("snapshots custom subject and body when queued for every automated email type", async () => {
    const appointmentSupabase = installMockSupabase({
      users: [
        {
          id: TEST_USER_ID,
          email: "maya@example.com",
          business_name: "Maya Johnson Hair",
          timezone: "UTC"
        }
      ],
      stylists: [
        {
          id: "stylist-1",
          user_id: TEST_USER_ID,
          slug: "maya-johnson",
          display_name: "Maya Johnson"
        }
      ],
      clients: [
        {
          id: TEST_CLIENT_ID,
          user_id: TEST_USER_ID,
          first_name: "Jane",
          last_name: "Doe",
          email: "jane@example.com"
        }
      ],
      appointment_email_templates: appointmentEventEmailTypes.map((emailType) => ({
        id: `${emailType}-template`,
        user_id: TEST_USER_ID,
        email_type: emailType,
        subject_template: `Subject snapshot ${emailType}`,
        custom_message_block: `Body snapshot ${emailType}`
      })),
      automation_settings: [
        {
          user_id: TEST_USER_ID,
          key: "email_confirmations",
          enabled: true
        }
      ],
      appointment_email_events: []
    });

    try {
      for (const [index, emailType] of appointmentEventEmailTypes.entries()) {
        await appointmentEmailEventsService.queueAppointmentEmail(
          TEST_USER_ID,
          {
            id: `appointment-${index + 1}`,
            user_id: TEST_USER_ID,
            client_id: TEST_CLIENT_ID,
            service_name: "Silk Press",
            appointment_date: `2099-05-${String(index + 12).padStart(2, "0")}T16:00:00.000Z`,
            duration_minutes: 60,
            status: emailType === "appointment_pending" ? "pending" : "scheduled"
          },
          emailType
        );
      }

      for (const emailType of appointmentEventEmailTypes) {
        const event = appointmentSupabase.state.appointment_email_events.find((row) => row.email_type === emailType);
        assert.deepEqual(event?.template_data && (event.template_data as Record<string, unknown>).email_template, {
          subject_template: `Subject snapshot ${emailType}`,
          custom_message_block: `Body snapshot ${emailType}`
        });
      }
    } finally {
      appointmentSupabase.restore();
    }

    const rebookSupabase = installMockSupabase({
      users: [
        {
          id: TEST_USER_ID,
          email: "maya@example.com",
          business_name: "Maya Johnson Hair",
          timezone: "UTC",
          plan_tier: "pro",
          plan_status: "active"
        }
      ],
      stylists: [
        {
          user_id: TEST_USER_ID,
          slug: "maya"
        }
      ],
      clients: [
        {
          id: TEST_CLIENT_ID,
          user_id: TEST_USER_ID,
          first_name: "Jane",
          last_name: "Doe",
          email: "jane@example.com"
        }
      ],
      appointments: [
        {
          id: "rebook-appointment",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          appointment_date: "2026-01-01T12:00:00.000Z",
          service_name: "Silk Press",
          status: "completed"
        }
      ],
      rebook_nudge_settings: [
        {
          user_id: TEST_USER_ID,
          approval_required: false,
          default_rebook_interval_days: 90
        }
      ],
      appointment_email_templates: [
        {
          id: "rebook-template",
          user_id: TEST_USER_ID,
          email_type: "rebooking_prompt",
          subject_template: "Subject snapshot rebooking_prompt",
          custom_message_block: "Body snapshot rebooking_prompt"
        }
      ],
      automation_settings: [
        {
          user_id: TEST_USER_ID,
          key: "rebook_nudges",
          enabled: true
        }
      ],
      rebook_nudges: [],
      appointment_email_events: []
    });

    try {
      await rebookNudgesService.queueDueNudgesForUser(TEST_USER_ID, new Date("2026-06-10T12:00:00.000Z"));
      await rebookNudgesService.processQueuedNudgeEmails(new Date("2026-06-10T12:00:00.000Z"));

      const event = rebookSupabase.state.appointment_email_events.find((row) => row.email_type === "rebooking_prompt");
      assert.deepEqual(event?.template_data && (event.template_data as Record<string, unknown>).email_template, {
        subject_template: "Subject snapshot rebooking_prompt",
        custom_message_block: "Body snapshot rebooking_prompt"
      });
    } finally {
      rebookSupabase.restore();
    }

    const thankYouSupabase = installMockSupabase({
      users: [
        {
          id: TEST_USER_ID,
          email: "maya@example.com",
          business_name: "Maya Johnson Hair",
          timezone: "UTC",
          plan_tier: "pro",
          plan_status: "active"
        }
      ],
      clients: [
        {
          id: TEST_CLIENT_ID,
          user_id: TEST_USER_ID,
          first_name: "Jane",
          last_name: "Doe",
          email: "jane@example.com"
        }
      ],
      appointments: [
        {
          id: "thank-you-appointment",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          appointment_date: "2026-06-01T12:00:00.000Z",
          service_name: "Silk Press",
          status: "completed"
        }
      ],
      client_referral_links: [],
      thank_you_email_settings: [
        {
          user_id: TEST_USER_ID,
          approval_required: false,
          send_delay_hours: 0
        }
      ],
      appointment_email_templates: [
        {
          id: "thank-you-template",
          user_id: TEST_USER_ID,
          email_type: "thank_you_email",
          subject_template: "Subject snapshot thank_you_email",
          custom_message_block: "Body snapshot thank_you_email"
        }
      ],
      automation_settings: [
        {
          user_id: TEST_USER_ID,
          key: "thank_you_emails",
          enabled: true
        }
      ],
      thank_you_emails: [],
      appointment_email_events: []
    });

    try {
      await thankYouEmailsService.queueDueForUser(TEST_USER_ID, new Date("2026-06-03T12:00:00.000Z"));
      await thankYouEmailsService.processQueuedThankYouEmails(new Date("2026-06-03T12:00:00.000Z"));

      const event = thankYouSupabase.state.appointment_email_events.find((row) => row.email_type === "thank_you_email");
      assert.deepEqual(event?.template_data && (event.template_data as Record<string, unknown>).email_template, {
        subject_template: "Subject snapshot thank_you_email",
        custom_message_block: "Body snapshot thank_you_email"
      });
    } finally {
      thankYouSupabase.restore();
    }

    const birthdaySupabase = installMockSupabase({
      users: [
        {
          id: TEST_USER_ID,
          email: "maya@example.com",
          business_name: "Maya Johnson Hair",
          timezone: "UTC",
          plan_tier: "pro",
          plan_status: "active"
        }
      ],
      clients: [
        {
          id: TEST_CLIENT_ID,
          user_id: TEST_USER_ID,
          first_name: "Jane",
          last_name: "Doe",
          email: "jane@example.com",
          birthday: "10/06"
        }
      ],
      appointment_email_templates: [
        {
          id: "birthday-template",
          user_id: TEST_USER_ID,
          email_type: "birthday_reminder",
          subject_template: "Subject snapshot birthday_reminder",
          custom_message_block: "Body snapshot birthday_reminder"
        }
      ],
      automation_settings: [
        {
          user_id: TEST_USER_ID,
          key: "birthday_reminders",
          enabled: true
        }
      ],
      birthday_reminder_settings: [
        {
          user_id: TEST_USER_ID,
          approval_required: false
        }
      ],
      birthday_reminders: [],
      appointment_email_events: []
    });

    try {
      await birthdayRemindersService.queueUpcomingForUser(TEST_USER_ID, new Date("2026-06-01T12:00:00.000Z"));
      await birthdayRemindersService.processQueuedBirthdayEmails(new Date("2026-06-10T09:01:00.000Z"));

      const event = birthdaySupabase.state.appointment_email_events.find((row) => row.email_type === "birthday_reminder");
      assert.deepEqual(event?.template_data && (event.template_data as Record<string, unknown>).email_template, {
        subject_template: "Subject snapshot birthday_reminder",
        custom_message_block: "Body snapshot birthday_reminder"
      });
    } finally {
      birthdaySupabase.restore();
    }
  });

  it("renders appointment email content without a provider-specific dependency", () => {
    const message = renderAppointmentEmail(
      {
        id: "email-event-1",
        email_type: "appointment_scheduled",
        recipient_email: "jane@example.com",
        template_data: {
          recipient_name: "Jane Doe",
          service_name: "Silk Press",
          appointment_start_time: "2099-05-12T16:00:00.000Z",
          appointment_time_display: "Tuesday, May 12, 2099 at 10:00 AM MDT - 11:00 AM MDT",
          duration_minutes: 60,
          business_display_name: "Maya Johnson Hair",
          business_phone: "(720) 555-0100",
          business_email: "maya@example.com",
          management_token: "manage-token"
        }
      },
      { appointmentManagementBaseUrl: "https://book.example.com/" }
    );

    assert.equal(message.to, "jane@example.com");
    assert.equal(message.subject, "Your Silk Press appointment with Maya Johnson Hair is confirmed");
    assert.match(message.text, /Hi Jane Doe/);
    assert.match(message.text, /Tuesday, May 12, 2099 at 10:00 AM MDT - 11:00 AM MDT/);
    assert.match(message.text, /Questions\? Contact Maya Johnson Hair at \(720\) 555-0100 or maya@example.com\./);
    assert.match(message.text, /Manage appointment: https:\/\/book\.example\.com\/appointments\/manage\/manage-token/);
    assert.match(message.html, /Maya Johnson Hair/);
  });

  it("renders a custom confirmation subject and fixed-position message block", () => {
    const message = renderAppointmentEmail(
      {
        id: "email-event-1",
        email_type: "appointment_scheduled",
        recipient_email: "jane@example.com",
        template_data: {
          recipient_name: "Jane Doe",
          service_name: "Silk Press",
          appointment_start_time: "2099-05-12T16:00:00.000Z",
          appointment_time_display: "Tuesday, May 12, 2099 at 10:00 AM MDT - 11:00 AM MDT",
          duration_minutes: 60,
          business_display_name: "Maya Johnson Hair",
          business_phone: "(720) 555-0100",
          business_email: "maya@example.com",
          management_token: "manage-token",
          email_template: {
            subject_template: "{{business_name}} saved your {{service_name}} spot",
            custom_message_block: "Please arrive 10 minutes early, {{client_name}}.\nBring inspiration photos if you have them."
          }
        }
      },
      { appointmentManagementBaseUrl: "https://book.example.com/" }
    );

    assert.equal(message.subject, "Maya Johnson Hair saved your Silk Press spot");
    assert.match(message.text, /Your appointment with Maya Johnson Hair is confirmed\.\n\nPlease arrive 10 minutes early, Jane Doe\./);
    assert.match(message.text, /Bring inspiration photos if you have them\.\n\nService: Silk Press/);
    assert.match(
      message.html,
      /<p>Please arrive 10 minutes early, Jane Doe\.<br>Bring inspiration photos if you have them\.<\/p><p><a href="https:\/\/book\.example\.com\/appointments\/manage\/manage-token"[^>]*>Manage Appointment<\/a><\/p><ul>/
    );
  });

  it("escapes custom confirmation blocks in html output", () => {
    const message = renderAppointmentEmail({
      id: "email-event-1",
      email_type: "appointment_confirmed",
      recipient_email: "jane@example.com",
      template_data: {
        recipient_name: "Jane Doe",
        service_name: "Color",
        appointment_start_time: "2099-05-12T16:00:00.000Z",
        appointment_time_display: "Tuesday, May 12, 2099 at 10:00 AM MDT - 11:00 AM MDT",
        duration_minutes: 60,
        business_display_name: "Maya Johnson Hair",
        email_template: {
          custom_message_block: "<script>alert('x')</script>"
        }
      }
    });

    assert.doesNotMatch(message.html, /<script>/);
    assert.match(message.html, /&lt;script&gt;alert\(&#39;x&#39;\)&lt;\/script&gt;/);
  });

  it("renders a custom rebooking prompt subject and message block", () => {
    const message = renderAppointmentEmail({
      id: "email-event-1",
      email_type: "rebooking_prompt",
      recipient_email: "jane@example.com",
      template_data: {
        recipient_name: "Jane Doe",
        service_name: "Silk Press",
        last_service_name: "Silk Press",
        last_appointment_display: "February 12, 2099",
        business_display_name: "Maya Johnson Hair",
        business_phone: "(720) 555-0100",
        business_email: "maya@example.com",
        rebook_url: "https://example.com/book/maya",
        message_type: "rebooking_prompt",
        email_template: {
          subject_template: "{{client_name}}, ready for your next {{last_service_name}}?",
          custom_message_block: "Book here when you're ready: {{rebook_url}}"
        }
      }
    });

    assert.equal(message.subject, "Jane Doe, ready for your next Silk Press?");
    assert.match(message.text, /It has been a little while since your last visit with Maya Johnson Hair\./);
    assert.match(message.text, /Book here when you're ready: https:\/\/example\.com\/book\/maya/);
    assert.match(message.text, /Last service: Silk Press/);
    assert.match(message.text, /Last visit: February 12, 2099/);
  });

  it("renders a birthday reminder email", () => {
    const message = renderAppointmentEmail({
      id: "birthday-email-event",
      email_type: "birthday_reminder",
      recipient_email: "jane@example.com",
      template_data: {
        recipient_name: "Jane Doe",
        birthday_display: "June 15",
        business_display_name: "Maya Johnson Hair",
        business_phone: "(720) 555-0100",
        business_email: "maya@example.com",
        message_type: "birthday_reminder"
      }
    });

    assert.equal(message.subject, "Happy birthday from Maya Johnson Hair");
    assert.match(message.text, /Hi Jane Doe/);
    assert.match(message.text, /Wishing you a very happy birthday from Maya Johnson Hair\./);
    assert.match(message.text, /Birthday: June 15/);
  });

  it("renders custom subjects and message blocks for non-confirmation email types", () => {
    const cancelled = renderAppointmentEmail({
      id: "cancelled-email-event",
      email_type: "appointment_cancelled",
      recipient_email: "jane@example.com",
      template_data: {
        recipient_name: "Jane Doe",
        service_name: "Color",
        appointment_time_display: "June 12 at 10:00 AM",
        business_display_name: "Maya Johnson Hair",
        email_template: {
          subject_template: "{{business_name}} cancellation note",
          custom_message_block: "We will help you find a new {{appointment_time}}."
        }
      }
    });
    const birthday = renderAppointmentEmail({
      id: "birthday-email-event",
      email_type: "birthday_reminder",
      recipient_email: "jane@example.com",
      template_data: {
        recipient_name: "Jane Doe",
        birthday_display: "June 15",
        business_display_name: "Maya Johnson Hair",
        message_type: "birthday_reminder",
        email_template: {
          subject_template: "Happy birthday, {{client_name}}",
          custom_message_block: "Here is a birthday note for {{birthday}}."
        }
      }
    });

    assert.equal(cancelled.subject, "Maya Johnson Hair cancellation note");
    assert.match(cancelled.text, /Maya Johnson Hair cancelled this appointment\.\n\nWe will help you find a new June 12 at 10:00 AM\./);
    assert.equal(birthday.subject, "Happy birthday, Jane Doe");
    assert.match(birthday.text, /Wishing you a very happy birthday from Maya Johnson Hair\.\n\nHere is a birthday note for June 15\./);
  });

  it("renders a thank you email with referral link, QR image, and custom tokens", () => {
    const message = renderAppointmentEmail({
      id: "thank-you-email-event",
      email_type: "thank_you_email",
      recipient_email: "jane@example.com",
      template_data: {
        recipient_name: "Jane Doe",
        service_name: "Silk Press",
        appointment_date_display: "June 1, 2026",
        business_display_name: "Maya Johnson Hair",
        business_phone: "(720) 555-0100",
        business_email: "maya@example.com",
        referral_url: "https://dripdesk.example/r/rf_abc123",
        referral_code: "rf_abc123",
        qr_code_url: "data:image/png;base64,abc123",
        message_type: "marketing",
        email_template: {
          subject_template: "Thanks for visiting, {{client_name}}",
          custom_message_block: "Share {{referral_url}} or code {{referral_code}} with a friend."
        }
      }
    });

    assert.equal(message.subject, "Thanks for visiting, Jane Doe");
    assert.match(message.text, /Thank you for visiting Maya Johnson Hair\./);
    assert.match(message.text, /Share https:\/\/dripdesk\.example\/r\/rf_abc123 or code rf_abc123 with a friend\./);
    assert.match(message.text, /Referral link: https:\/\/dripdesk\.example\/r\/rf_abc123/);
    assert.match(message.text, /Referral code: rf_abc123/);
    assert.match(message.html, /<img src="cid:referral-qr-code" alt="Referral QR code"/);
    assert.deepEqual(message.attachments, [
      {
        filename: "referral-qr-code.png",
        content: "abc123",
        contentType: "image/png",
        contentId: "referral-qr-code"
      }
    ]);
  });

  it("processes queued events with an injected provider and marks them sent", async () => {
    const sentMessages: EmailMessage[] = [];
    const provider: EmailProvider = {
      async send(message) {
        sentMessages.push(message);
        return {
          status: "sent",
          provider: "test-provider",
          providerMessageId: "provider-message-1"
        };
      }
    };
    const supabase = installMockSupabase({
      automation_settings: [
        {
          user_id: TEST_USER_ID,
          key: "email_confirmations",
          enabled: true
        }
      ],
      appointment_email_events: [
        {
          id: "email-event-1",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          email_type: "appointment_pending",
          recipient_email: "jane@example.com",
          status: "queued",
          created_at: "2026-05-10T10:00:00.000Z",
          template_data: {
            recipient_name: "Jane Doe",
            service_name: "Trim",
            appointment_start_time: "2099-05-12T16:00:00.000Z",
            appointment_time_display: "Tuesday, May 12, 2099 at 10:00 AM MDT - 10:45 AM MDT",
            business_display_name: "Maya Johnson Hair",
            duration_minutes: 45
          }
        }
      ]
    });

    try {
      const result = await appointmentEmailDeliveryService.processQueuedAppointmentEmails({
        provider,
        now: new Date("2026-05-10T12:00:00.000Z")
      });

      assert.deepEqual(result, {
        processed: 1,
        sent: 1,
        skipped: 0,
        failed: 0
      });
      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0]?.subject, "Maya Johnson Hair received your Trim request");
      assert.equal(supabase.state.appointment_email_events[0]?.status, "sent");
      assert.equal(supabase.state.appointment_email_events[0]?.provider, "test-provider");
      assert.equal(supabase.state.appointment_email_events[0]?.provider_message_id, "provider-message-1");
      assert.equal(supabase.state.appointment_email_events[0]?.sent_at, "2026-05-10T12:00:00.000Z");
      assert.equal(supabase.state.appointment_email_events[0]?.error, null);
    } finally {
      supabase.restore();
    }
  });

  it("records activity when an appointment reminder email is sent", async () => {
    const provider: EmailProvider = {
      async send() {
        return {
          status: "sent",
          provider: "test-provider",
          providerMessageId: "provider-message-1"
        };
      }
    };
    const supabase = installMockSupabase({
      users: [
        {
          id: TEST_USER_ID,
          timezone: "UTC",
          business_name: "Maya Johnson Hair"
        }
      ],
      clients: [
        {
          id: TEST_CLIENT_ID,
          user_id: TEST_USER_ID,
          first_name: "Jane",
          last_name: "Doe",
          email: "jane@example.com"
        }
      ],
      appointments: [
        {
          id: "appointment-1",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          appointment_date: "2026-05-11T12:00:00.000Z",
          service_name: "Trim",
          duration_minutes: 45,
          status: "scheduled"
        }
      ],
      appointment_email_events: [
        {
          id: "email-event-1",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          appointment_id: "appointment-1",
          email_type: "appointment_reminder",
          recipient_email: "jane@example.com",
          status: "queued",
          created_at: "2026-05-10T10:00:00.000Z",
          template_data: {
            recipient_name: "Jane Doe",
            service_name: "Trim",
            appointment_start_time: "2026-05-11T12:00:00.000Z",
            appointment_time_display: "Monday, May 11, 2026 at 12:00 PM UTC - 12:45 PM UTC",
            business_display_name: "Maya Johnson Hair",
            duration_minutes: 45
          }
        }
      ],
      activity_events: []
    });

    try {
      const result = await appointmentEmailDeliveryService.processQueuedAppointmentEmails({
        provider,
        now: new Date("2026-05-10T12:00:00.000Z")
      });

      assert.deepEqual(result, {
        processed: 1,
        sent: 1,
        skipped: 0,
        failed: 0
      });
      assert.equal(supabase.state.activity_events.length, 1);
      assert.equal(supabase.state.activity_events[0]?.activity_type, "reminder_sent");
      assert.equal(supabase.state.activity_events[0]?.title, "EMAIL reminder sent to Jane");
      assert.equal(supabase.state.activity_events[0]?.appointment_id, "appointment-1");
      assert.deepEqual(supabase.state.activity_events[0]?.metadata, {
        client_name: "Jane Doe",
        channel: "email",
        reminder_type: "appointment_reminder",
        appointment_start_time: "2026-05-11T12:00:00.000Z"
      });
    } finally {
      supabase.restore();
    }
  });

  it("skips appointment reminder emails when the appointment is no longer active", async () => {
    let sendCount = 0;
    const provider: EmailProvider = {
      async send() {
        sendCount += 1;
        return {
          status: "sent",
          provider: "test-provider"
        };
      }
    };
    const supabase = installMockSupabase({
      clients: [
        {
          id: TEST_CLIENT_ID,
          user_id: TEST_USER_ID,
          first_name: "Jane",
          last_name: "Doe",
          email: "jane@example.com"
        }
      ],
      appointments: [
        {
          id: "appointment-1",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          appointment_date: "2026-05-11T12:00:00.000Z",
          service_name: "Trim",
          duration_minutes: 45,
          status: "cancelled"
        }
      ],
      appointment_email_events: [
        {
          id: "email-event-1",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          appointment_id: "appointment-1",
          email_type: "appointment_reminder",
          recipient_email: "jane@example.com",
          status: "queued",
          created_at: "2026-05-10T10:00:00.000Z",
          idempotency_key: "appointment_reminder:appointment-1:2026-05-11T12:00:00.000Z",
          template_data: {
            recipient_name: "Jane Doe",
            service_name: "Trim",
            appointment_start_time: "2026-05-11T12:00:00.000Z",
            business_display_name: "Maya Johnson Hair"
          }
        }
      ],
      communication_events: []
    });

    try {
      const result = await appointmentEmailDeliveryService.processQueuedAppointmentEmails({
        provider,
        now: new Date("2026-05-10T12:00:00.000Z")
      });

      assert.deepEqual(result, {
        processed: 1,
        sent: 0,
        skipped: 1,
        failed: 0
      });
      assert.equal(sendCount, 0);
      assert.equal(supabase.state.appointment_email_events[0]?.status, "skipped");
      assert.equal(supabase.state.appointment_email_events[0]?.error, "appointment_reminder_appointment_not_active");
    } finally {
      supabase.restore();
    }
  });

  it("skips stale appointment reminder emails when the appointment time changed", async () => {
    let sendCount = 0;
    const provider: EmailProvider = {
      async send() {
        sendCount += 1;
        return {
          status: "sent",
          provider: "test-provider"
        };
      }
    };
    const supabase = installMockSupabase({
      clients: [
        {
          id: TEST_CLIENT_ID,
          user_id: TEST_USER_ID,
          first_name: "Jane",
          last_name: "Doe",
          email: "jane@example.com"
        }
      ],
      appointments: [
        {
          id: "appointment-1",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          appointment_date: "2026-05-11T14:00:00.000Z",
          service_name: "Trim",
          duration_minutes: 45,
          status: "scheduled"
        }
      ],
      appointment_email_events: [
        {
          id: "email-event-1",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          appointment_id: "appointment-1",
          email_type: "appointment_reminder",
          recipient_email: "jane@example.com",
          status: "queued",
          created_at: "2026-05-10T10:00:00.000Z",
          idempotency_key: "appointment_reminder:appointment-1:2026-05-11T12:00:00.000Z",
          template_data: {
            recipient_name: "Jane Doe",
            service_name: "Trim",
            appointment_start_time: "2026-05-11T12:00:00.000Z",
            business_display_name: "Maya Johnson Hair"
          }
        }
      ],
      communication_events: []
    });

    try {
      const result = await appointmentEmailDeliveryService.processQueuedAppointmentEmails({
        provider,
        now: new Date("2026-05-10T12:00:00.000Z")
      });

      assert.deepEqual(result, {
        processed: 1,
        sent: 0,
        skipped: 1,
        failed: 0
      });
      assert.equal(sendCount, 0);
      assert.equal(supabase.state.appointment_email_events[0]?.status, "skipped");
      assert.equal(supabase.state.appointment_email_events[0]?.error, "appointment_reminder_appointment_changed");
    } finally {
      supabase.restore();
    }
  });

  it("does not mark a sent email failed when communication event logging fails", async () => {
    const provider: EmailProvider = {
      async send() {
        return {
          status: "sent",
          provider: "test-provider",
          providerMessageId: "provider-message-1"
        };
      }
    };
    const logCommunicationEvent = mock.method(
      communicationEventsService,
      "logCommunicationEvent",
      async () => {
        throw new Error("telemetry unavailable");
      }
    );
    const supabase = installMockSupabase({
      automation_settings: [
        {
          user_id: TEST_USER_ID,
          key: "email_confirmations",
          enabled: true
        }
      ],
      appointment_email_events: [
        {
          id: "email-event-1",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          email_type: "appointment_pending",
          recipient_email: "jane@example.com",
          status: "queued",
          created_at: "2026-05-10T10:00:00.000Z",
          template_data: {
            recipient_name: "Jane Doe",
            service_name: "Trim",
            appointment_start_time: "2099-05-12T16:00:00.000Z",
            appointment_time_display: "Tuesday, May 12, 2099 at 10:00 AM MDT - 10:45 AM MDT",
            business_display_name: "Maya Johnson Hair",
            duration_minutes: 45
          }
        }
      ]
    });

    try {
      const result = await appointmentEmailDeliveryService.processQueuedAppointmentEmails({
        provider,
        now: new Date("2026-05-10T12:00:00.000Z")
      });

      assert.deepEqual(result, {
        processed: 1,
        sent: 1,
        skipped: 0,
        failed: 0
      });
      assert.equal(logCommunicationEvent.mock.callCount(), 1);
      assert.equal(supabase.state.appointment_email_events[0]?.status, "sent");
      assert.equal(supabase.state.appointment_email_events[0]?.provider, "test-provider");
      assert.equal(supabase.state.appointment_email_events[0]?.provider_message_id, "provider-message-1");
      assert.equal(supabase.state.appointment_email_events[0]?.sent_at, "2026-05-10T12:00:00.000Z");
      assert.equal(supabase.state.appointment_email_events[0]?.error, null);
    } finally {
      logCommunicationEvent.mock.restore();
      supabase.restore();
    }
  });

  it("snapshots configured confirmation templates when queueing appointment emails", async () => {
    const previousWebAppUrl = env.WEB_APP_URL;
    env.WEB_APP_URL = "https://dripdesk.example";
    const supabase = installMockSupabase({
      users: [
        {
          id: TEST_USER_ID,
          email: "maya@example.com",
          business_name: "Maya Johnson Hair",
          timezone: "UTC"
        }
      ],
      stylists: [
        {
          id: "stylist-1",
          user_id: TEST_USER_ID,
          slug: "maya-johnson",
          display_name: "Maya Johnson"
        }
      ],
      clients: [
        {
          id: TEST_CLIENT_ID,
          user_id: TEST_USER_ID,
          first_name: "Jane",
          last_name: "Doe",
          email: "jane@example.com"
        }
      ],
      appointment_action_links: [],
      appointment_email_templates: [
        {
          id: "template-1",
          user_id: TEST_USER_ID,
          email_type: "appointment_scheduled",
          subject_template: "{{business_name}} saved your {{service_name}} spot",
          custom_message_block: "Please arrive 10 minutes early."
        }
      ],
      automation_settings: [
        {
          user_id: TEST_USER_ID,
          key: "email_confirmations",
          enabled: true
        }
      ],
      appointment_email_events: []
    });

    try {
      const queued = await appointmentEmailEventsService.queueAppointmentEmail(
        TEST_USER_ID,
        {
          id: "appointment-1",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          service_name: "Silk Press",
          appointment_date: "2099-05-12T16:00:00.000Z",
          duration_minutes: 60,
          status: "scheduled"
        },
        "appointment_scheduled"
      );

      assert.ok(queued);
      const templateData = supabase.state.appointment_email_events[0]?.template_data as Record<string, unknown>;
      assert.deepEqual(templateData.email_template, {
        subject_template: "{{business_name}} saved your {{service_name}} spot",
        custom_message_block: "Please arrive 10 minutes early."
      });
      assert.equal(supabase.state.appointment_action_links.length, 1);
      assert.match(String(templateData.management_url), /^https:\/\/dripdesk\.example\/manage\/[A-Za-z0-9_-]{8,32}$/);
    } finally {
      env.WEB_APP_URL = previousWebAppUrl;
      supabase.restore();
    }
  });

  it("keeps existing queued email template snapshots when settings change", async () => {
    const sentMessages: EmailMessage[] = [];
    const provider: EmailProvider = {
      async send(message) {
        sentMessages.push(message);
        return {
          status: "sent",
          provider: "test-provider",
          providerMessageId: "provider-message-1"
        };
      }
    };
    const supabase = installMockSupabase({
      users: [
        {
          id: TEST_USER_ID,
          email: "maya@example.com",
          business_name: "Maya Johnson Hair",
          timezone: "UTC"
        }
      ],
      clients: [
        {
          id: TEST_CLIENT_ID,
          user_id: TEST_USER_ID,
          first_name: "Jane",
          last_name: "Doe",
          email: "jane@example.com"
        }
      ],
      appointment_email_templates: [
        {
          id: "template-1",
          user_id: TEST_USER_ID,
          email_type: "appointment_scheduled",
          subject_template: "New subject for {{service_name}}",
          custom_message_block: "New body copy."
        }
      ],
      automation_settings: [
        {
          user_id: TEST_USER_ID,
          key: "email_confirmations",
          enabled: true
        }
      ],
      appointment_email_events: [
        {
          id: "email-event-1",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          appointment_id: "appointment-1",
          email_type: "appointment_scheduled",
          recipient_email: "jane@example.com",
          status: "queued",
          idempotency_key: "appointment_scheduled:appointment-1",
          created_at: "2026-05-10T10:00:00.000Z",
          template_data: {
            recipient_name: "Jane Doe",
            service_name: "Silk Press",
            appointment_start_time: "2099-05-12T16:00:00.000Z",
            appointment_time_display: "Tuesday, May 12, 2099 at 10:00 AM MDT - 11:00 AM MDT",
            business_display_name: "Maya Johnson Hair",
            duration_minutes: 60,
            email_template: {
              subject_template: "Old subject for {{service_name}}",
              custom_message_block: "Old body copy."
            }
          }
        }
      ]
    });

    try {
      const result = await appointmentEmailDeliveryService.processQueuedAppointmentEmails({
        provider,
        now: new Date("2026-05-10T12:00:00.000Z")
      });
      const newlyQueued = await appointmentEmailEventsService.queueAppointmentEmail(
        TEST_USER_ID,
        {
          id: "appointment-2",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          service_name: "Gloss",
          appointment_date: "2099-05-13T16:00:00.000Z",
          duration_minutes: 45,
          status: "scheduled"
        },
        "appointment_scheduled"
      );

      assert.deepEqual(result, {
        processed: 1,
        sent: 1,
        skipped: 0,
        failed: 0
      });
      assert.equal(sentMessages[0]?.subject, "Old subject for Silk Press");
      assert.match(sentMessages[0]?.text ?? "", /Old body copy\./);
      assert.doesNotMatch(sentMessages[0]?.text ?? "", /New body copy\./);
      assert.deepEqual(newlyQueued?.template_data && (newlyQueued.template_data as Record<string, unknown>).email_template, {
        subject_template: "New subject for {{service_name}}",
        custom_message_block: "New body copy."
      });
    } finally {
      supabase.restore();
    }
  });

  it("queues approval-required rebook nudges and creates a rebooking email after approval", async () => {
    const supabase = installMockSupabase({
      users: [
        {
          id: TEST_USER_ID,
          email: "maya@example.com",
          business_name: "Maya Johnson Hair",
          timezone: "UTC",
          plan_tier: "pro",
          plan_status: "active"
        }
      ],
      stylists: [
        {
          user_id: TEST_USER_ID,
          slug: "maya"
        }
      ],
      clients: [
        {
          id: TEST_CLIENT_ID,
          user_id: TEST_USER_ID,
          first_name: "Jane",
          last_name: "Doe",
          email: "Jane@Example.com"
        }
      ],
      appointments: [
        {
          id: "appointment-1",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          appointment_date: "2026-01-01T12:00:00.000Z",
          service_name: "Silk Press",
          status: "completed"
        }
      ],
      rebook_nudge_settings: [
        {
          user_id: TEST_USER_ID,
          approval_required: true,
          default_rebook_interval_days: 90,
          subject_template: "Legacy {{client_name}}",
          custom_message_block: "Legacy book here: {{rebook_url}}"
        }
      ],
      appointment_email_templates: [
        {
          id: "rebook-template-1",
          user_id: TEST_USER_ID,
          email_type: "rebooking_prompt",
          subject_template: "{{client_name}}, ready for your next {{last_service_name}}?",
          custom_message_block: "Unified book here: {{rebook_url}}"
        }
      ],
      automation_settings: [
        {
          user_id: TEST_USER_ID,
          key: "rebook_nudges",
          enabled: true
        }
      ],
      rebook_nudges: [],
      appointment_email_events: []
    });

    try {
      const queueResult = await rebookNudgesService.queueDueNudgesForUser(
        TEST_USER_ID,
        new Date("2026-06-10T12:00:00.000Z")
      );

      assert.deepEqual(queueResult, { queued: 1, skipped: 0 });
      assert.equal(supabase.state.rebook_nudges.length, 1);
      assert.equal(supabase.state.rebook_nudges[0]?.status, "pending_approval");
      assert.equal(supabase.state.rebook_nudges[0]?.recipient_email, "jane@example.com");
      assert.equal(supabase.state.rebook_nudges[0]?.send_after, "2026-04-01T12:00:00.000Z");
      assert.equal(supabase.state.rebook_nudges[0]?.subject_snapshot, "{{client_name}}, ready for your next {{last_service_name}}?");
      assert.equal(supabase.state.rebook_nudges[0]?.custom_message_block_snapshot, "Unified book here: {{rebook_url}}");

      const nudgeId = String(supabase.state.rebook_nudges[0]?.id);
      await rebookNudgesService.approveForUser(TEST_USER_ID, nudgeId);
      const processResult = await rebookNudgesService.processQueuedNudgeEmails(
        new Date("2026-06-10T12:00:00.000Z")
      );

      assert.deepEqual(processResult, { processed: 1, queued_emails: 1 });
      assert.equal(supabase.state.rebook_nudges[0]?.status, "sending");
      assert.equal(supabase.state.appointment_email_events.length, 1);
      assert.equal(supabase.state.appointment_email_events[0]?.email_type, "rebooking_prompt");
      assert.equal(supabase.state.appointment_email_events[0]?.rebook_nudge_id, nudgeId);
      assert.equal(
        (supabase.state.appointment_email_events[0]?.template_data as Record<string, unknown>).message_type,
        "rebooking_prompt"
      );
      assert.deepEqual(
        (supabase.state.appointment_email_events[0]?.template_data as Record<string, unknown>).email_template,
        {
          subject_template: "{{client_name}}, ready for your next {{last_service_name}}?",
          custom_message_block: "Unified book here: {{rebook_url}}"
        }
      );

      const secondProcessResult = await rebookNudgesService.processQueuedNudgeEmails(
        new Date("2026-06-10T12:01:00.000Z")
      );
      assert.deepEqual(secondProcessResult, { processed: 0, queued_emails: 0 });
      assert.equal(supabase.state.appointment_email_events.length, 1);
    } finally {
      supabase.restore();
    }
  });

  it("queues completed appointment thank you emails with referral QR snapshots and processes approved emails", async () => {
    const previousWebAppUrl = env.WEB_APP_URL;
    env.WEB_APP_URL = "https://dripdesk.example";
    const supabase = installMockSupabase({
      users: [
        {
          id: TEST_USER_ID,
          email: "maya@example.com",
          business_name: "Maya Johnson Hair",
          timezone: "UTC",
          plan_tier: "pro",
          plan_status: "active"
        }
      ],
      clients: [
        {
          id: TEST_CLIENT_ID,
          user_id: TEST_USER_ID,
          first_name: "Jane",
          last_name: "Doe",
          email: "Jane@Example.com"
        }
      ],
      appointments: [
        {
          id: "appointment-1",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          appointment_date: "2026-06-01T12:00:00.000Z",
          service_name: "Silk Press",
          status: "completed"
        }
      ],
      client_referral_links: [],
      thank_you_email_settings: [
        {
          user_id: TEST_USER_ID,
          approval_required: true,
          send_delay_hours: 24,
          subject_template: "Legacy thanks, {{client_name}}",
          custom_message_block: "Legacy code: {{referral_code}}"
        }
      ],
      appointment_email_templates: [
        {
          id: "thank-you-template-1",
          user_id: TEST_USER_ID,
          email_type: "thank_you_email",
          subject_template: "Unified thanks, {{client_name}}",
          custom_message_block: "Unified code: {{referral_code}}"
        }
      ],
      automation_settings: [
        {
          user_id: TEST_USER_ID,
          key: "thank_you_emails",
          enabled: true
        }
      ],
      thank_you_emails: [],
      appointment_email_events: []
    });

    try {
      const queueResult = await thankYouEmailsService.queueDueForUser(
        TEST_USER_ID,
        new Date("2026-06-03T12:00:00.000Z")
      );

      assert.deepEqual(queueResult, { queued: 1, skipped: 0 });
      assert.equal(supabase.state.client_referral_links.length, 1);
      assert.equal(supabase.state.thank_you_emails.length, 1);
      assert.equal(supabase.state.thank_you_emails[0]?.status, "pending_approval");
      assert.equal(supabase.state.thank_you_emails[0]?.recipient_email, "jane@example.com");
      assert.equal(supabase.state.thank_you_emails[0]?.send_after, "2026-06-02T12:00:00.000Z");
      assert.equal(
        supabase.state.thank_you_emails[0]?.referral_url_snapshot,
        `https://dripdesk.example/r/${supabase.state.client_referral_links[0]?.referral_code}`
      );
      assert.match(String(supabase.state.thank_you_emails[0]?.qr_code_url_snapshot), /^data:image\/png;base64,/);
      assert.equal(supabase.state.thank_you_emails[0]?.subject_snapshot, "Unified thanks, {{client_name}}");
      assert.equal(supabase.state.thank_you_emails[0]?.custom_message_block_snapshot, "Unified code: {{referral_code}}");

      const thankYouEmailId = String(supabase.state.thank_you_emails[0]?.id);
      await thankYouEmailsService.approveForUser(TEST_USER_ID, thankYouEmailId);
      const processResult = await thankYouEmailsService.processQueuedThankYouEmails(
        new Date("2026-06-03T12:00:00.000Z")
      );

      assert.deepEqual(processResult, { processed: 1, queued_emails: 1 });
      assert.equal(supabase.state.thank_you_emails[0]?.status, "sending");
      assert.equal(supabase.state.appointment_email_events.length, 1);
      assert.equal(supabase.state.appointment_email_events[0]?.email_type, "thank_you_email");
      assert.equal(supabase.state.appointment_email_events[0]?.thank_you_email_id, thankYouEmailId);
      assert.equal(
        (supabase.state.appointment_email_events[0]?.template_data as Record<string, unknown>).message_type,
        "marketing"
      );
      assert.deepEqual(
        (supabase.state.appointment_email_events[0]?.template_data as Record<string, unknown>).email_template,
        {
          subject_template: "Unified thanks, {{client_name}}",
          custom_message_block: "Unified code: {{referral_code}}"
        }
      );

      const secondProcessResult = await thankYouEmailsService.processQueuedThankYouEmails(
        new Date("2026-06-03T12:01:00.000Z")
      );
      assert.deepEqual(secondProcessResult, { processed: 0, queued_emails: 0 });
      assert.equal(supabase.state.appointment_email_events.length, 1);
    } finally {
      env.WEB_APP_URL = previousWebAppUrl;
      supabase.restore();
    }
  });

  it("does not count existing thank you emails as newly queued", async () => {
    const supabase = installMockSupabase({
      users: [
        {
          id: TEST_USER_ID,
          email: "maya@example.com",
          plan_tier: "pro",
          plan_status: "active"
        }
      ],
      clients: [
        {
          id: TEST_CLIENT_ID,
          user_id: TEST_USER_ID,
          first_name: "Jane",
          last_name: "Doe",
          email: "jane@example.com"
        }
      ],
      appointments: [
        {
          id: "appointment-1",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          appointment_date: "2026-06-01T12:00:00.000Z",
          service_name: "Silk Press",
          status: "completed"
        }
      ],
      automation_settings: [
        {
          user_id: TEST_USER_ID,
          key: "thank_you_emails",
          enabled: true
        }
      ],
      thank_you_email_settings: [],
      thank_you_emails: [
        {
          id: "44444444-4444-4444-8444-444444444444",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          appointment_id: "appointment-1",
          recipient_email: "jane@example.com",
          status: "pending_approval",
          send_after: "2026-06-01T12:00:00.000Z",
          created_at: "2026-06-01T12:00:00.000Z"
        }
      ],
      client_referral_links: []
    });

    try {
      const result = await thankYouEmailsService.queueDueForUser(
        TEST_USER_ID,
        new Date("2026-06-03T12:00:00.000Z")
      );

      assert.deepEqual(result, { queued: 0, skipped: 1 });
      assert.equal(supabase.state.thank_you_emails.length, 1);
    } finally {
      supabase.restore();
    }
  });

  it("does not queue thank you emails when automation is disabled", async () => {
    const supabase = installMockSupabase({
      users: [
        {
          id: TEST_USER_ID,
          email: "maya@example.com",
          plan_tier: "pro",
          plan_status: "active"
        }
      ],
      clients: [
        {
          id: TEST_CLIENT_ID,
          user_id: TEST_USER_ID,
          first_name: "Jane",
          last_name: "Doe",
          email: "jane@example.com"
        }
      ],
      appointments: [
        {
          id: "appointment-1",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          appointment_date: "2026-06-01T12:00:00.000Z",
          service_name: "Silk Press",
          status: "completed"
        }
      ],
      automation_settings: [
        {
          user_id: TEST_USER_ID,
          key: "thank_you_emails",
          enabled: false
        }
      ],
      thank_you_email_settings: [],
      thank_you_emails: [],
      client_referral_links: []
    });

    try {
      const result = await thankYouEmailsService.queueDueForUser(
        TEST_USER_ID,
        new Date("2026-06-03T12:00:00.000Z")
      );

      assert.deepEqual(result, { queued: 0, skipped: 0 });
      assert.equal(supabase.state.thank_you_emails.length, 0);
      assert.equal(supabase.state.client_referral_links.length, 0);
    } finally {
      supabase.restore();
    }
  });

  it("does not overwrite a cancelled thank you email when delivery finishes late", async () => {
    const supabase = installMockSupabase({
      thank_you_emails: [
        {
          id: "44444444-4444-4444-8444-444444444444",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          appointment_id: "appointment-1",
          recipient_email: "jane@example.com",
          status: "cancelled",
          send_after: "2026-06-02T12:00:00.000Z",
          cancelled_at: "2026-06-03T12:00:00.000Z",
          cancelled_reason: "Client requested no email"
        }
      ]
    });

    try {
      await thankYouEmailsService.markForEmailEvent(
        {
          id: "thank-you-event-1",
          thank_you_email_id: "44444444-4444-4444-8444-444444444444"
        },
        "sent",
        null
      );

      assert.equal(supabase.state.thank_you_emails[0]?.status, "cancelled");
      assert.equal(supabase.state.thank_you_emails[0]?.sent_at, undefined);
      assert.equal(supabase.state.thank_you_emails[0]?.cancelled_reason, "Client requested no email");
    } finally {
      supabase.restore();
    }
  });

  it("skips thank you email delivery when marketing email is opted out", async () => {
    const supabase = installMockSupabase({
      users: [
        {
          id: TEST_USER_ID,
          email: "maya@example.com",
          plan_tier: "pro",
          plan_status: "active"
        }
      ],
      clients: [
        {
          id: TEST_CLIENT_ID,
          user_id: TEST_USER_ID,
          first_name: "Jane",
          last_name: "Doe",
          email: "jane@example.com"
        }
      ],
      thank_you_emails: [
        {
          id: "44444444-4444-4444-8444-444444444444",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          appointment_id: "appointment-1",
          recipient_email: "jane@example.com",
          status: "sending",
          send_after: "2026-06-02T12:00:00.000Z"
        }
      ],
      appointment_email_events: [
        {
          id: "thank-you-event-1",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          appointment_id: "appointment-1",
          thank_you_email_id: "44444444-4444-4444-8444-444444444444",
          email_type: "thank_you_email",
          recipient_email: "jane@example.com",
          status: "queued",
          idempotency_key: "thank_you_email:44444444-4444-4444-8444-444444444444",
          template_data: {
            recipient_name: "Jane Doe",
            service_name: "Silk Press",
            business_display_name: "Maya Johnson Hair",
            referral_url: "https://dripdesk.example/r/rf_abc123",
            referral_code: "rf_abc123",
            message_type: "marketing"
          }
        }
      ],
      client_communication_preferences: [
        {
          id: "preference-1",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          email: "jane@example.com",
          email_normalized: "jane@example.com",
          email_transactional_enabled: true,
          email_reminders_enabled: true,
          email_marketing_enabled: false,
          email_rebooking_enabled: true,
          opted_out_all_email: false
        }
      ],
      communication_events: [],
      communication_preference_tokens: [],
      global_email_unsubscribes: []
    });

    try {
      const provider: EmailProvider = {
        async send() {
          throw new Error("Provider should not be called");
        }
      };

      const result = await appointmentEmailDeliveryService.processQueuedAppointmentEmails({
        provider,
        now: new Date("2026-06-03T12:00:00.000Z")
      });

      assert.deepEqual(result, {
        processed: 1,
        sent: 0,
        skipped: 1,
        failed: 0
      });
      assert.equal(supabase.state.appointment_email_events[0]?.status, "skipped");
      assert.equal(supabase.state.appointment_email_events[0]?.error, "opted_out");
      assert.equal(supabase.state.thank_you_emails[0]?.status, "skipped");
      assert.equal(supabase.state.thank_you_emails[0]?.error, "opted_out");
    } finally {
      supabase.restore();
    }
  });

  it("updates thank you email rows after delivery succeeds", async () => {
    const supabase = installMockSupabase({
      users: [
        {
          id: TEST_USER_ID,
          email: "maya@example.com",
          plan_tier: "pro",
          plan_status: "active"
        }
      ],
      clients: [
        {
          id: TEST_CLIENT_ID,
          user_id: TEST_USER_ID,
          first_name: "Jane",
          last_name: "Doe",
          email: "jane@example.com"
        }
      ],
      thank_you_emails: [
        {
          id: "44444444-4444-4444-8444-444444444444",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          appointment_id: "appointment-1",
          recipient_email: "jane@example.com",
          status: "sending",
          send_after: "2026-06-02T12:00:00.000Z"
        }
      ],
      appointment_email_events: [
        {
          id: "thank-you-event-1",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          appointment_id: "appointment-1",
          thank_you_email_id: "44444444-4444-4444-8444-444444444444",
          email_type: "thank_you_email",
          recipient_email: "jane@example.com",
          status: "queued",
          idempotency_key: "thank_you_email:44444444-4444-4444-8444-444444444444",
          template_data: {
            recipient_name: "Jane Doe",
            service_name: "Silk Press",
            business_display_name: "Maya Johnson Hair",
            appointment_date_display: "June 1, 2026",
            referral_url: "https://dripdesk.example/r/rf_abc123",
            referral_code: "rf_abc123",
            message_type: "marketing"
          }
        }
      ],
      communication_events: [],
      communication_preference_tokens: [],
      global_email_unsubscribes: [],
      client_communication_preferences: []
    });

    try {
      const provider: EmailProvider = {
        async send(message: EmailMessage) {
          assert.equal(message.to, "jane@example.com");
          assert.match(message.text, /Referral link: https:\/\/dripdesk\.example\/r\/rf_abc123/);
          return {
            status: "sent",
            provider: "test",
            providerMessageId: "provider-message-1"
          };
        }
      };

      const result = await appointmentEmailDeliveryService.processQueuedAppointmentEmails({
        provider,
        now: new Date("2026-06-03T12:00:00.000Z")
      });

      assert.equal(result.sent, 1);
      assert.equal(supabase.state.appointment_email_events[0]?.status, "sent");
      assert.equal(supabase.state.thank_you_emails[0]?.status, "sent");
      assert.equal(typeof supabase.state.thank_you_emails[0]?.sent_at, "string");
    } finally {
      supabase.restore();
    }
  });

  it("queues and processes thank you emails through internal job handlers", async () => {
    const previousWebAppUrl = env.WEB_APP_URL;
    env.WEB_APP_URL = "https://dripdesk.example";
    const supabase = installMockSupabase({
      users: [
        {
          id: TEST_USER_ID,
          email: "maya@example.com",
          business_name: "Maya Johnson Hair",
          timezone: "UTC",
          plan_tier: "pro",
          plan_status: "active"
        }
      ],
      clients: [
        {
          id: TEST_CLIENT_ID,
          user_id: TEST_USER_ID,
          first_name: "Jane",
          last_name: "Doe",
          email: "jane@example.com"
        }
      ],
      appointments: [
        {
          id: "appointment-1",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          appointment_date: "2026-06-01T12:00:00.000Z",
          service_name: "Silk Press",
          status: "completed"
        }
      ],
      client_referral_links: [],
      thank_you_email_settings: [
        {
          user_id: TEST_USER_ID,
          approval_required: false,
          send_delay_hours: 0
        }
      ],
      automation_settings: [
        {
          user_id: TEST_USER_ID,
          key: "thank_you_emails",
          enabled: true
        }
      ],
      thank_you_emails: [],
      appointment_email_events: []
    });

    try {
      const queueResponse = await runWithErrorHandler(
        (request, res) => internalController.queueThankYouEmails(request, res),
        createMockRequest()
      );
      assert.deepEqual(queueResponse.body, {
        data: {
          processed_users: 1,
          queued: 1,
          skipped: 0
        }
      });
      assert.equal(supabase.state.thank_you_emails[0]?.status, "queued");

      const processResponse = await runWithErrorHandler(
        (request, res) => internalController.processThankYouEmails(request, res),
        createMockRequest()
      );
      assert.deepEqual(processResponse.body, {
        data: {
          processed: 1,
          queued_emails: 1
        }
      });
      assert.equal(supabase.state.thank_you_emails[0]?.status, "sending");
      assert.equal(supabase.state.appointment_email_events[0]?.email_type, "thank_you_email");
    } finally {
      env.WEB_APP_URL = previousWebAppUrl;
      supabase.restore();
    }
  });

  it("applies separate user and per-user limits when queueing thank you emails", async () => {
    const previousWebAppUrl = env.WEB_APP_URL;
    env.WEB_APP_URL = "https://dripdesk.example";
    const secondUserId = "55555555-5555-4555-8555-555555555555";
    const secondClientId = "66666666-6666-4666-8666-666666666666";
    const supabase = installMockSupabase({
      users: [
        {
          id: TEST_USER_ID,
          email: "maya@example.com",
          business_name: "Maya Johnson Hair",
          timezone: "UTC",
          plan_tier: "pro",
          plan_status: "active"
        },
        {
          id: secondUserId,
          email: "taylor@example.com",
          business_name: "Taylor Studio",
          timezone: "UTC",
          plan_tier: "pro",
          plan_status: "active"
        }
      ],
      clients: [
        {
          id: TEST_CLIENT_ID,
          user_id: TEST_USER_ID,
          first_name: "Jane",
          last_name: "Doe",
          email: "jane@example.com"
        },
        {
          id: secondClientId,
          user_id: secondUserId,
          first_name: "Alex",
          last_name: "Rivera",
          email: "alex@example.com"
        }
      ],
      appointments: [
        {
          id: "first-user-first-appointment",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          appointment_date: "2026-06-01T12:00:00.000Z",
          service_name: "Silk Press",
          status: "completed"
        },
        {
          id: "first-user-second-appointment",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          appointment_date: "2026-06-02T12:00:00.000Z",
          service_name: "Gloss",
          status: "completed"
        },
        {
          id: "second-user-appointment",
          user_id: secondUserId,
          client_id: secondClientId,
          appointment_date: "2026-06-01T12:00:00.000Z",
          service_name: "Color",
          status: "completed"
        }
      ],
      thank_you_email_settings: [
        {
          user_id: TEST_USER_ID,
          approval_required: false,
          send_delay_hours: 0
        },
        {
          user_id: secondUserId,
          approval_required: false,
          send_delay_hours: 0
        }
      ],
      automation_settings: [
        {
          user_id: TEST_USER_ID,
          key: "thank_you_emails",
          enabled: true
        },
        {
          user_id: secondUserId,
          key: "thank_you_emails",
          enabled: true
        }
      ],
      client_referral_links: [],
      thank_you_emails: []
    });

    try {
      const response = await runWithErrorHandler(
        (request, res) => internalController.queueThankYouEmails(request, res),
        createMockRequest({
          query: {
            user_limit: 1,
            per_user_limit: 1
          } as unknown as Request["query"]
        })
      );

      assert.deepEqual(response.body, {
        data: {
          processed_users: 1,
          queued: 1,
          skipped: 0
        }
      });
      assert.equal(supabase.state.thank_you_emails.length, 1);
      assert.equal(supabase.state.thank_you_emails[0]?.user_id, TEST_USER_ID);
    } finally {
      env.WEB_APP_URL = previousWebAppUrl;
      supabase.restore();
    }
  });

  it("allows manual rebook nudges to be scheduled before they are due", async () => {
    mock.timers.enable({ apis: ["Date"], now: new Date("2026-06-10T12:00:00.000Z") });
    const supabase = installMockSupabase({
      users: [
        {
          id: TEST_USER_ID,
          email: "maya@example.com",
          business_name: "Maya Johnson Hair",
          timezone: "UTC",
          plan_tier: "pro",
          plan_status: "active"
        }
      ],
      stylists: [],
      clients: [
        {
          id: TEST_CLIENT_ID,
          user_id: TEST_USER_ID,
          first_name: "Jane",
          last_name: "Doe",
          email: "jane@example.com"
        }
      ],
      appointments: [
        {
          id: "appointment-1",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          appointment_date: "2026-05-01T12:00:00.000Z",
          service_name: "Silk Press",
          status: "completed"
        }
      ],
      rebook_nudge_settings: [],
      rebook_nudges: [],
      appointment_email_events: []
    });

    try {
      const nudge = await rebookNudgesService.queueManualForUser(TEST_USER_ID, {
        clientId: TEST_CLIENT_ID,
        rebookIntervalDays: 120,
        approvalRequired: false
      });

      assert.equal(nudge.status, "queued");
      assert.equal(nudge.send_after, "2026-08-29T12:00:00.000Z");
      assert.equal(supabase.state.appointment_email_events.length, 0);
    } finally {
      supabase.restore();
      mock.timers.reset();
    }
  });

  it("counts only automatic queued rebook nudges in the queued total", async () => {
    const supabase = installMockSupabase({
      users: [
        {
          id: TEST_USER_ID,
          email: "maya@example.com",
          plan_tier: "pro",
          plan_status: "active"
        }
      ],
      rebook_nudges: [
        {
          id: "automatic-queued",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          recipient_email: "jane@example.com",
          status: "queued",
          approval_required: false,
          send_after: "2026-06-07T12:00:00.000Z",
          rebook_interval_days: 90
        },
        {
          id: "automatic-failed",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          recipient_email: "jane@example.com",
          status: "failed",
          approval_required: false,
          send_after: "2026-06-07T12:00:00.000Z",
          rebook_interval_days: 90
        },
        {
          id: "manual-review-queued",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          recipient_email: "jane@example.com",
          status: "queued",
          approval_required: true,
          send_after: "2026-06-07T12:00:00.000Z",
          rebook_interval_days: 90
        },
        {
          id: "manual-review-pending",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          recipient_email: "jane@example.com",
          status: "pending_approval",
          approval_required: true,
          send_after: "2026-06-07T12:00:00.000Z",
          rebook_interval_days: 90
        },
        {
          id: "sending-nudge",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          recipient_email: "jane@example.com",
          status: "sending",
          approval_required: false,
          send_after: "2026-06-07T12:00:00.000Z",
          rebook_interval_days: 90
        }
      ]
    });

    try {
      const counts = await rebookNudgesService.getCountsForUser(TEST_USER_ID);

      assert.deepEqual(counts, {
        pending_approval: 1,
        queued: 2
      });
    } finally {
      supabase.restore();
    }
  });

  it("skips linked queued rebook email events when a nudge is cancelled", async () => {
    const supabase = installMockSupabase({
      users: [
        {
          id: TEST_USER_ID,
          email: "maya@example.com",
          business_name: "Maya Johnson Hair",
          timezone: "UTC",
          plan_tier: "pro",
          plan_status: "active"
        }
      ],
      rebook_nudges: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          email_event_id: "email-event-1",
          recipient_email: "jane@example.com",
          status: "sending",
          send_after: "2026-06-10T10:00:00.000Z",
          rebook_interval_days: 90
        }
      ],
      automation_settings: [
        {
          user_id: TEST_USER_ID,
          key: "email_confirmations",
          enabled: true
        }
      ],
      appointment_email_events: [
        {
          id: "email-event-1",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          email_type: "rebooking_prompt",
          recipient_email: "jane@example.com",
          status: "queued",
          idempotency_key: "rebooking_prompt:33333333-3333-4333-8333-333333333333",
          template_data: {}
        }
      ]
    });

    try {
      const nudge = await rebookNudgesService.cancelForUser(
        TEST_USER_ID,
        "33333333-3333-4333-8333-333333333333",
        "Not this time"
      );

      assert.equal(nudge.status, "cancelled");
      assert.equal(supabase.state.appointment_email_events[0]?.status, "skipped");
      assert.equal(supabase.state.appointment_email_events[0]?.error, "Rebook nudge cancelled");
    } finally {
      supabase.restore();
    }
  });

  it("skips linked queued rebook email events when a future appointment supersedes a nudge", async () => {
    const supabase = installMockSupabase({
      rebook_nudges: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          email_event_id: "email-event-1",
          recipient_email: "jane@example.com",
          status: "sending",
          send_after: "2026-06-10T10:00:00.000Z",
          rebook_interval_days: 90
        }
      ],
      automation_settings: [
        {
          user_id: TEST_USER_ID,
          key: "email_confirmations",
          enabled: true
        }
      ],
      appointment_email_events: [
        {
          id: "email-event-1",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          email_type: "rebooking_prompt",
          recipient_email: "jane@example.com",
          status: "queued",
          idempotency_key: "rebooking_prompt:33333333-3333-4333-8333-333333333333",
          template_data: {}
        }
      ]
    });

    try {
      await rebookNudgesService.supersedeActiveForClient(TEST_USER_ID, TEST_CLIENT_ID);

      assert.equal(supabase.state.rebook_nudges[0]?.status, "superseded");
      assert.equal(supabase.state.appointment_email_events[0]?.status, "skipped");
      assert.equal(
        supabase.state.appointment_email_events[0]?.error,
        "Rebook nudge superseded by future appointment"
      );
    } finally {
      supabase.restore();
    }
  });

  it("queues and sends due birthday reminder emails", async () => {
    const sentMessages: EmailMessage[] = [];
    const provider: EmailProvider = {
      async send(message) {
        sentMessages.push(message);
        return {
          status: "sent",
          provider: "test-provider",
          providerMessageId: "birthday-provider-message"
        };
      }
    };
    const supabase = installMockSupabase({
      users: [
        {
          id: TEST_USER_ID,
          email: "maya@example.com",
          business_name: "Maya Johnson Hair",
          timezone: "UTC",
          plan_tier: "pro",
          plan_status: "active"
        }
      ],
      birthday_reminders: [
        {
          id: "44444444-4444-4444-8444-444444444444",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          recipient_email: "jane@example.com",
          birthday: "10/06",
          birthday_occurrence_date: "2026-06-10",
          scheduled_send_at: "2026-06-10T09:00:00.000Z",
          status: "queued",
          template_data: {
            recipient_name: "Jane Doe",
            birthday_display: "June 10",
            business_display_name: "Maya Johnson Hair",
            message_type: "birthday_reminder"
          }
        }
      ],
      appointment_email_events: [],
      client_communication_preferences: [],
      communication_events: []
    });

    try {
      const queueResult = await birthdayRemindersService.processQueuedBirthdayEmails(
        new Date("2026-06-10T09:01:00.000Z")
      );

      assert.deepEqual(queueResult, {
        processed: 1,
        queued_emails: 1
      });
      assert.equal(supabase.state.birthday_reminders[0]?.status, "sending");
      assert.equal(supabase.state.appointment_email_events[0]?.email_type, "birthday_reminder");
      assert.equal(supabase.state.appointment_email_events[0]?.birthday_reminder_id, "44444444-4444-4444-8444-444444444444");

      const sendResult = await appointmentEmailDeliveryService.processQueuedAppointmentEmails({
        provider,
        now: new Date("2026-06-10T09:02:00.000Z")
      });

      assert.deepEqual(sendResult, {
        processed: 1,
        sent: 1,
        skipped: 0,
        failed: 0
      });
      assert.equal(sentMessages.length, 1);
      assert.match(sentMessages[0]?.subject ?? "", /Happy birthday from Maya Johnson Hair/);
      assert.equal(supabase.state.appointment_email_events[0]?.status, "sent");
      assert.equal(supabase.state.birthday_reminders[0]?.status, "sent");

      const secondQueueResult = await birthdayRemindersService.processQueuedBirthdayEmails(
        new Date("2026-06-10T09:03:00.000Z")
      );
      assert.deepEqual(secondQueueResult, {
        processed: 0,
        queued_emails: 0
      });
      assert.equal(supabase.state.appointment_email_events.length, 1);
    } finally {
      supabase.restore();
    }
  });

  it("snapshots configured birthday reminder templates when queueing birthday reminders", async () => {
    const supabase = installMockSupabase({
      users: [
        {
          id: TEST_USER_ID,
          email: "maya@example.com",
          business_name: "Maya Johnson Hair",
          timezone: "UTC",
          plan_tier: "pro",
          plan_status: "active"
        }
      ],
      clients: [
        {
          id: TEST_CLIENT_ID,
          user_id: TEST_USER_ID,
          first_name: "Jane",
          last_name: "Doe",
          email: "Jane@Example.com",
          birthday: "10/06"
        }
      ],
      appointment_email_templates: [
        {
          id: "birthday-template-1",
          user_id: TEST_USER_ID,
          email_type: "birthday_reminder",
          subject_template: "Happy birthday, {{client_name}}",
          custom_message_block: "Birthday note for {{birthday}}"
        }
      ],
      automation_settings: [
        {
          user_id: TEST_USER_ID,
          key: "birthday_reminders",
          enabled: true
        }
      ],
      birthday_reminder_settings: [
        {
          user_id: TEST_USER_ID,
          approval_required: false
        }
      ],
      birthday_reminders: [],
      appointment_email_events: []
    });

    try {
      const queueResult = await birthdayRemindersService.queueUpcomingForUser(
        TEST_USER_ID,
        new Date("2026-06-01T12:00:00.000Z")
      );

      assert.deepEqual(queueResult, { queued: 1, skipped: 0 });
      assert.equal(supabase.state.birthday_reminders[0]?.subject_snapshot, "Happy birthday, {{client_name}}");
      assert.equal(supabase.state.birthday_reminders[0]?.custom_message_block_snapshot, "Birthday note for {{birthday}}");

      const processResult = await birthdayRemindersService.processQueuedBirthdayEmails(
        new Date("2026-06-10T09:01:00.000Z")
      );

      assert.deepEqual(processResult, { processed: 1, queued_emails: 1 });
      assert.deepEqual(
        (supabase.state.appointment_email_events[0]?.template_data as Record<string, unknown>).email_template,
        {
          subject_template: "Happy birthday, {{client_name}}",
          custom_message_block: "Birthday note for {{birthday}}"
        }
      );
    } finally {
      supabase.restore();
    }
  });

  it("does not queue appointment reminders when automation setting is missing", async () => {
    const supabase = installMockSupabase({
      automation_settings: [],
      appointments: [
        {
          id: "appointment-1",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          appointment_date: "2026-06-11T12:00:00.000Z",
          service_name: "Trim",
          duration_minutes: 45,
          status: "scheduled"
        }
      ],
      appointment_email_events: []
    });

    try {
      const result = await appointmentRemindersService.queueDueForUser(
        TEST_USER_ID,
        new Date("2026-06-10T12:00:00.000Z")
      );

      assert.deepEqual(result, { queued: 0, skipped: 0 });
      assert.equal(supabase.state.appointment_email_events.length, 0);
    } finally {
      supabase.restore();
    }
  });

  it("queues due appointment reminder emails once when automation is enabled", async () => {
    const supabase = installMockSupabase({
      users: [
        {
          id: TEST_USER_ID,
          email: "maya@example.com",
          business_name: "Maya Johnson Hair",
          timezone: "UTC"
        }
      ],
      stylists: [
        {
          user_id: TEST_USER_ID,
          display_name: "Maya Johnson",
          slug: "maya"
        }
      ],
      clients: [
        {
          id: TEST_CLIENT_ID,
          user_id: TEST_USER_ID,
          first_name: "Jane",
          last_name: "Doe",
          email: "jane@example.com"
        },
        {
          id: "client-2",
          user_id: TEST_USER_ID,
          first_name: "Sam",
          last_name: "Lee",
          email: "sam@example.com"
        }
      ],
      automation_settings: [
        {
          user_id: TEST_USER_ID,
          key: "appointment_reminders",
          enabled: true
        }
      ],
      appointments: [
        {
          id: "appointment-due",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          appointment_date: "2026-06-11T12:00:00.000Z",
          service_name: "Trim",
          duration_minutes: 45,
          status: "scheduled"
        },
        {
          id: "appointment-duplicate",
          user_id: TEST_USER_ID,
          client_id: "client-2",
          appointment_date: "2026-06-11T12:10:00.000Z",
          service_name: "Color",
          duration_minutes: 90,
          status: "pending"
        },
        {
          id: "appointment-cancelled",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          appointment_date: "2026-06-11T12:00:00.000Z",
          service_name: "Gloss",
          duration_minutes: 30,
          status: "cancelled"
        },
        {
          id: "appointment-outside-window",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          appointment_date: "2026-06-11T13:00:00.000Z",
          service_name: "Cut",
          duration_minutes: 30,
          status: "scheduled"
        }
      ],
      appointment_email_events: [
        {
          id: "existing-reminder",
          user_id: TEST_USER_ID,
          client_id: "client-2",
          appointment_id: "appointment-duplicate",
          email_type: "appointment_reminder",
          recipient_email: "sam@example.com",
          status: "queued",
          idempotency_key: "appointment_reminder:appointment-duplicate:2026-06-11T12:10:00.000Z",
          created_at: "2026-06-10T11:55:00.000Z"
        }
      ]
    });

    try {
      const result = await appointmentRemindersService.queueDueForUser(
        TEST_USER_ID,
        new Date("2026-06-10T12:00:00.000Z")
      );

      assert.deepEqual(result, { queued: 1, skipped: 1 });
      assert.equal(supabase.state.appointment_email_events.length, 2);
      assert.equal(supabase.state.appointment_email_events[1]?.email_type, "appointment_reminder");
      assert.equal(supabase.state.appointment_email_events[1]?.appointment_id, "appointment-due");
      assert.equal(
        supabase.state.appointment_email_events[1]?.idempotency_key,
        "appointment_reminder:appointment-due:2026-06-11T12:00:00.000Z"
      );
    } finally {
      supabase.restore();
    }
  });

  it("queues global appointment reminders from due appointments instead of the first users", async () => {
    const disabledUserId = "33333333-3333-3333-3333-333333333333";
    const enabledClientId = "44444444-4444-4444-4444-444444444444";
    const supabase = installMockSupabase({
      users: [
        {
          id: disabledUserId,
          email: "disabled@example.com",
          business_name: "Disabled Salon",
          timezone: "UTC"
        },
        {
          id: TEST_USER_ID,
          email: "maya@example.com",
          business_name: "Maya Johnson Hair",
          timezone: "UTC"
        }
      ],
      stylists: [
        {
          user_id: TEST_USER_ID,
          display_name: "Maya Johnson",
          slug: "maya"
        }
      ],
      clients: [
        {
          id: enabledClientId,
          user_id: TEST_USER_ID,
          first_name: "Jane",
          last_name: "Doe",
          email: "jane@example.com"
        }
      ],
      automation_settings: [
        {
          user_id: disabledUserId,
          key: "appointment_reminders",
          enabled: false
        },
        {
          user_id: TEST_USER_ID,
          key: "appointment_reminders",
          enabled: true
        }
      ],
      appointments: [
        {
          id: "enabled-due-appointment",
          user_id: TEST_USER_ID,
          client_id: enabledClientId,
          appointment_date: "2026-06-11T11:55:00.000Z",
          service_name: "Trim",
          duration_minutes: 45,
          status: "scheduled"
        },
        {
          id: "disabled-due-appointment",
          user_id: disabledUserId,
          client_id: "disabled-client",
          appointment_date: "2026-06-11T12:00:00.000Z",
          service_name: "Color",
          duration_minutes: 90,
          status: "scheduled"
        }
      ]
    });

    try {
      const result = await appointmentRemindersService.queueDue(
        new Date("2026-06-10T12:00:00.000Z"),
        { appointmentLimit: 1 }
      );

      assert.deepEqual(result, { processed_users: 1, queued: 1, skipped: 0 });
      assert.equal(supabase.state.appointment_email_events.length, 1);
      assert.equal(supabase.state.appointment_email_events[0]?.user_id, TEST_USER_ID);
      assert.equal(supabase.state.appointment_email_events[0]?.appointment_id, "enabled-due-appointment");
      assert.equal(supabase.state.appointment_email_events[0]?.email_type, "appointment_reminder");
    } finally {
      supabase.restore();
    }
  });

  it("applies separate user and appointment limits for global appointment reminders", async () => {
    const secondUserId = "55555555-5555-4555-8555-555555555555";
    const secondClientId = "66666666-6666-4666-8666-666666666666";
    const supabase = installMockSupabase({
      users: [
        {
          id: TEST_USER_ID,
          email: "maya@example.com",
          business_name: "Maya Johnson Hair",
          timezone: "UTC"
        },
        {
          id: secondUserId,
          email: "taylor@example.com",
          business_name: "Taylor Studio",
          timezone: "UTC"
        }
      ],
      stylists: [
        {
          user_id: TEST_USER_ID,
          display_name: "Maya Johnson",
          slug: "maya"
        },
        {
          user_id: secondUserId,
          display_name: "Taylor Reed",
          slug: "taylor"
        }
      ],
      clients: [
        {
          id: TEST_CLIENT_ID,
          user_id: TEST_USER_ID,
          first_name: "Jane",
          last_name: "Doe",
          email: "jane@example.com"
        },
        {
          id: secondClientId,
          user_id: secondUserId,
          first_name: "Alex",
          last_name: "Rivera",
          email: "alex@example.com"
        }
      ],
      automation_settings: [
        {
          user_id: TEST_USER_ID,
          key: "appointment_reminders",
          enabled: true
        },
        {
          user_id: secondUserId,
          key: "appointment_reminders",
          enabled: true
        }
      ],
      appointments: [
        {
          id: "first-user-first-appointment",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          appointment_date: "2026-06-11T11:55:00.000Z",
          service_name: "Trim",
          duration_minutes: 45,
          status: "scheduled"
        },
        {
          id: "second-user-appointment",
          user_id: secondUserId,
          client_id: secondClientId,
          appointment_date: "2026-06-11T12:00:00.000Z",
          service_name: "Color",
          duration_minutes: 90,
          status: "scheduled"
        },
        {
          id: "first-user-second-appointment",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          appointment_date: "2026-06-11T12:05:00.000Z",
          service_name: "Gloss",
          duration_minutes: 30,
          status: "scheduled"
        }
      ]
    });

    try {
      const result = await appointmentRemindersService.queueDue(
        new Date("2026-06-10T12:00:00.000Z"),
        { userLimit: 1, appointmentLimit: 3 }
      );

      assert.deepEqual(result, { processed_users: 1, queued: 2, skipped: 0 });
      assert.deepEqual(
        supabase.state.appointment_email_events.map((event) => event.appointment_id),
        ["first-user-first-appointment", "first-user-second-appointment"]
      );
    } finally {
      supabase.restore();
    }
  });

  it("does not queue birthday reminders while listing birthday reminder records", async () => {
    mock.timers.enable({ apis: ["Date"], now: new Date("2026-06-06T16:00:00.000Z") });
    const supabase = installMockSupabase({
      users: [
        {
          id: TEST_USER_ID,
          timezone: "UTC",
          business_name: "Maya Johnson Hair",
          plan_tier: "pro",
          plan_status: "active"
        }
      ],
      clients: [
        {
          id: TEST_CLIENT_ID,
          user_id: TEST_USER_ID,
          first_name: "Jane",
          last_name: "Doe",
          email: "jane@example.com",
          birthday: "10/06"
        }
      ],
      birthday_reminders: []
    });

    try {
      const response = await birthdayRemindersService.listForUser(TEST_USER_ID, { limit: 10 });

      assert.deepEqual(response, {
        data: [],
        next_cursor: null
      });
      assert.deepEqual(supabase.state.birthday_reminders, []);
    } finally {
      supabase.restore();
      mock.timers.reset();
    }
  });

  it("does not queue birthday reminders when the automation setting is disabled", async () => {
    const supabase = installMockSupabase({
      automation_settings: [
        {
          id: "automation-setting-1",
          user_id: TEST_USER_ID,
          key: "birthday_reminders",
          enabled: false
        }
      ],
      users: [
        {
          id: TEST_USER_ID,
          timezone: "UTC",
          business_name: "Maya Johnson Hair",
          plan_tier: "pro",
          plan_status: "active"
        }
      ],
      clients: [
        {
          id: TEST_CLIENT_ID,
          user_id: TEST_USER_ID,
          first_name: "Jane",
          last_name: "Doe",
          email: "jane@example.com",
          birthday: "10/06"
        }
      ],
      birthday_reminders: []
    });

    try {
      const result = await birthdayRemindersService.queueUpcomingForUser(
        TEST_USER_ID,
        new Date("2026-06-06T16:00:00.000Z")
      );

      assert.deepEqual(result, {
        queued: 0,
        skipped: 0
      });
      assert.deepEqual(supabase.state.birthday_reminders, []);
    } finally {
      supabase.restore();
    }
  });

  it("paginates birthday reminders with a database-backed cursor", async () => {
    const supabase = installMockSupabase({
      users: [
        {
          id: TEST_USER_ID,
          timezone: "UTC",
          business_name: "Maya Johnson Hair",
          plan_tier: "pro",
          plan_status: "active"
        }
      ],
      birthday_reminders: [
        {
          id: "44444444-4444-4444-8444-444444444444",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          recipient_email: "a@example.com",
          birthday: "10/06",
          birthday_occurrence_date: "2026-06-10",
          scheduled_send_at: "2026-06-10T09:00:00.000Z",
          status: "queued",
          template_data: { client_name: "A Client", days_until: 4 }
        },
        {
          id: "55555555-5555-4555-8555-555555555555",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          recipient_email: "b@example.com",
          birthday: "10/06",
          birthday_occurrence_date: "2026-06-10",
          scheduled_send_at: "2026-06-10T09:00:00.000Z",
          status: "queued",
          template_data: { client_name: "B Client", days_until: 4 }
        },
        {
          id: "66666666-6666-4666-8666-666666666666",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          recipient_email: "c@example.com",
          birthday: "11/06",
          birthday_occurrence_date: "2026-06-11",
          scheduled_send_at: "2026-06-11T09:00:00.000Z",
          status: "queued",
          template_data: { client_name: "C Client", days_until: 5 }
        }
      ]
    });

    try {
      const firstPage = await birthdayRemindersService.listForUser(TEST_USER_ID, { limit: 1 });
      const secondPage = await birthdayRemindersService.listForUser(TEST_USER_ID, {
        limit: 1,
        cursor: firstPage.next_cursor ?? undefined
      });
      const thirdPage = await birthdayRemindersService.listForUser(TEST_USER_ID, {
        limit: 1,
        cursor: secondPage.next_cursor ?? undefined
      });

      assert.deepEqual(firstPage.data.map((reminder) => reminder.reminder_id), ["44444444-4444-4444-8444-444444444444"]);
      assert.deepEqual(secondPage.data.map((reminder) => reminder.reminder_id), ["55555555-5555-4555-8555-555555555555"]);
      assert.deepEqual(thirdPage.data.map((reminder) => reminder.reminder_id), ["66666666-6666-4666-8666-666666666666"]);
      assert.equal(thirdPage.next_cursor, null);
    } finally {
      supabase.restore();
    }
  });

  it("paginates rebook nudges with a cursor beyond the first page", async () => {
    const supabase = installMockSupabase({
      users: [
        {
          id: TEST_USER_ID,
          timezone: "UTC",
          business_name: "Maya Johnson Hair",
          plan_tier: "pro",
          plan_status: "active"
        }
      ],
      rebook_nudges: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          recipient_email: "a@example.com",
          status: "queued",
          send_after: "2026-06-13T10:00:00.000Z",
          rebook_interval_days: 90
        },
        {
          id: "44444444-4444-4444-8444-444444444444",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          recipient_email: "b@example.com",
          status: "queued",
          send_after: "2026-06-12T10:00:00.000Z",
          rebook_interval_days: 90
        },
        {
          id: "55555555-5555-4555-8555-555555555555",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          recipient_email: "c@example.com",
          status: "queued",
          send_after: "2026-06-11T10:00:00.000Z",
          rebook_interval_days: 90
        }
      ]
    });

    try {
      const firstPage = await rebookNudgesService.listForUser(TEST_USER_ID, { limit: 1 });
      const secondPage = await rebookNudgesService.listForUser(TEST_USER_ID, {
        limit: 1,
        cursor: firstPage.next_cursor ?? undefined
      });
      const thirdPage = await rebookNudgesService.listForUser(TEST_USER_ID, {
        limit: 1,
        cursor: secondPage.next_cursor ?? undefined
      });

      assert.equal(firstPage.data[0]?.id, "33333333-3333-4333-8333-333333333333");
      assert.equal(secondPage.data[0]?.id, "44444444-4444-4444-8444-444444444444");
      assert.equal(thirdPage.data[0]?.id, "55555555-5555-4555-8555-555555555555");
    } finally {
      supabase.restore();
    }
  });

  it("does not queue appointment confirmation emails when automation is disabled", async () => {
    const supabase = installMockSupabase({
      users: [
        {
          id: TEST_USER_ID,
          email: "maya@example.com",
          business_name: "Maya Johnson Hair",
          timezone: "UTC"
        }
      ],
      stylists: [
        {
          id: "stylist-1",
          user_id: TEST_USER_ID,
          slug: "maya-johnson",
          display_name: "Maya Johnson"
        }
      ],
      clients: [
        {
          id: TEST_CLIENT_ID,
          user_id: TEST_USER_ID,
          first_name: "Jane",
          last_name: "Doe",
          email: "jane@example.com"
        }
      ],
      appointments: [],
      appointment_email_events: [],
      automation_settings: [
        {
          id: "automation-setting-1",
          user_id: TEST_USER_ID,
          key: "email_confirmations",
          enabled: false
        }
      ]
    });

    try {
      const queued = await appointmentEmailEventsService.queueAppointmentEmail(
        TEST_USER_ID,
        {
          id: "appointment-1",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          appointment_date: "2099-05-12T16:00:00.000Z",
          duration_minutes: 45,
          service_name: "Trim",
          status: "scheduled"
        },
        "appointment_scheduled"
      );

      assert.equal(queued, null);
      assert.equal(supabase.state.appointment_email_events.length, 0);
    } finally {
      supabase.restore();
    }
  });

  it("still queues cancellation emails when email confirmations are disabled", async () => {
    const supabase = installMockSupabase({
      users: [
        {
          id: TEST_USER_ID,
          email: "maya@example.com",
          business_name: "Maya Johnson Hair",
          timezone: "UTC"
        }
      ],
      stylists: [
        {
          id: "stylist-1",
          user_id: TEST_USER_ID,
          slug: "maya-johnson",
          display_name: "Maya Johnson"
        }
      ],
      clients: [
        {
          id: TEST_CLIENT_ID,
          user_id: TEST_USER_ID,
          first_name: "Jane",
          last_name: "Doe",
          email: "jane@example.com"
        }
      ],
      appointments: [],
      appointment_email_events: [],
      automation_settings: [
        {
          id: "automation-setting-1",
          user_id: TEST_USER_ID,
          key: "email_confirmations",
          enabled: false
        }
      ]
    });

    try {
      const queued = await appointmentEmailEventsService.queueAppointmentEmail(
        TEST_USER_ID,
        {
          id: "appointment-1",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          appointment_date: "2099-05-12T16:00:00.000Z",
          duration_minutes: 45,
          service_name: "Trim",
          status: "cancelled"
        },
        "appointment_cancelled",
        { cancelledBy: "stylist" }
      );

      assert.ok(queued);
      assert.equal(supabase.state.appointment_email_events.length, 1);
      assert.equal(supabase.state.appointment_email_events[0]?.email_type, "appointment_cancelled");
    } finally {
      supabase.restore();
    }
  });

  it("skips queued appointment confirmation emails when automation is disabled before processing", async () => {
    const sentMessages: EmailMessage[] = [];
    const provider: EmailProvider = {
      async send(message) {
        sentMessages.push(message);
        return {
          status: "sent",
          provider: "test-provider"
        };
      }
    };
    const supabase = installMockSupabase({
      appointment_email_events: [
        {
          id: "email-event-1",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          email_type: "appointment_pending",
          recipient_email: "jane@example.com",
          status: "queued",
          created_at: "2026-05-10T10:00:00.000Z",
          template_data: {
            recipient_name: "Jane Doe",
            service_name: "Trim",
            appointment_start_time: "2099-05-12T16:00:00.000Z",
            appointment_time_display: "Tuesday, May 12, 2099 at 10:00 AM MDT - 10:45 AM MDT",
            business_display_name: "Maya Johnson Hair",
            duration_minutes: 45
          }
        }
      ],
      automation_settings: [
        {
          id: "automation-setting-1",
          user_id: TEST_USER_ID,
          key: "email_confirmations",
          enabled: false
        }
      ],
      communication_events: []
    });

    try {
      const result = await appointmentEmailDeliveryService.processQueuedAppointmentEmails({
        provider,
        now: new Date("2026-05-10T12:00:00.000Z")
      });

      assert.deepEqual(result, {
        processed: 1,
        sent: 0,
        skipped: 1,
        failed: 0
      });
      assert.equal(sentMessages.length, 0);
      assert.equal(supabase.state.appointment_email_events[0]?.status, "skipped");
      assert.equal(supabase.state.appointment_email_events[0]?.error, "Email confirmations automation disabled");
      assert.equal(supabase.state.communication_events[0]?.status, "skipped_opted_out");
      assert.equal(supabase.state.communication_events[0]?.error_code, "disabled");
    } finally {
      supabase.restore();
    }
  });

  it("refuses to process queued events without a real provider unless noop is explicitly allowed", async () => {
    const supabase = installMockSupabase({
      automation_settings: [
        {
          user_id: TEST_USER_ID,
          key: "email_confirmations",
          enabled: true
        }
      ],
      appointment_email_events: [
        {
          id: "email-event-1",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          email_type: "appointment_confirmed",
          recipient_email: "jane@example.com",
          status: "queued",
          created_at: "2026-05-10T10:00:00.000Z",
          template_data: {
            recipient_name: "Jane Doe",
            service_name: "Trim",
            appointment_start_time: "2099-05-12T16:00:00.000Z"
          }
        }
      ]
    });

    try {
      await assert.rejects(
        () => appointmentEmailDeliveryService.processQueuedAppointmentEmails(),
        (error) => error instanceof Error && error.message === "Email provider is not configured"
      );
      assert.equal(supabase.state.appointment_email_events[0]?.status, "queued");
    } finally {
      supabase.restore();
    }
  });

  it("marks queued events skipped with the explicitly allowed noop provider", async () => {
    const supabase = installMockSupabase({
      automation_settings: [
        {
          user_id: TEST_USER_ID,
          key: "email_confirmations",
          enabled: true
        }
      ],
      appointment_email_events: [
        {
          id: "email-event-1",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          email_type: "appointment_confirmed",
          recipient_email: "jane@example.com",
          status: "queued",
          created_at: "2026-05-10T10:00:00.000Z",
          template_data: {
            recipient_name: "Jane Doe",
            service_name: "Trim",
            appointment_start_time: "2099-05-12T16:00:00.000Z"
          }
        }
      ]
    });

    try {
      const result = await appointmentEmailDeliveryService.processQueuedAppointmentEmails({
        allowNoopProvider: true
      });

      assert.deepEqual(result, {
        processed: 1,
        sent: 0,
        skipped: 1,
        failed: 0
      });
      assert.equal(supabase.state.appointment_email_events[0]?.status, "skipped");
      assert.equal(supabase.state.appointment_email_events[0]?.provider, "noop");
      assert.equal(supabase.state.appointment_email_events[0]?.error, "No email provider configured");
      assert.equal(supabase.state.appointment_email_events[0]?.attempt_count, 1);
    } finally {
      supabase.restore();
    }
  });

  it("marks events failed when a provider throws", async () => {
    const provider: EmailProvider = {
      async send() {
        throw new Error("provider unavailable");
      }
    };
    const supabase = installMockSupabase({
      automation_settings: [
        {
          user_id: TEST_USER_ID,
          key: "email_confirmations",
          enabled: true
        }
      ],
      appointment_email_events: [
        {
          id: "email-event-1",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          email_type: "appointment_cancelled",
          recipient_email: "jane@example.com",
          status: "queued",
          created_at: "2026-05-10T10:00:00.000Z",
          template_data: {
            recipient_name: "Jane Doe",
            service_name: "Trim",
            appointment_start_time: "2099-05-12T16:00:00.000Z",
            cancelled_by: "stylist"
          }
        }
      ]
    });

    try {
      const result = await appointmentEmailDeliveryService.processQueuedAppointmentEmails({ provider });

      assert.deepEqual(result, {
        processed: 1,
        sent: 0,
        skipped: 0,
        failed: 1
      });
      assert.equal(supabase.state.appointment_email_events[0]?.status, "failed");
      assert.equal(supabase.state.appointment_email_events[0]?.error, "provider unavailable");
    } finally {
      supabase.restore();
    }
  });

  it("only claims queued events up to the requested limit", async () => {
    const sentMessages: EmailMessage[] = [];
    const provider: EmailProvider = {
      async send(message) {
        sentMessages.push(message);
        return {
          status: "sent",
          provider: "test-provider"
        };
      }
    };
    const supabase = installMockSupabase({
      automation_settings: [
        {
          user_id: TEST_USER_ID,
          key: "email_confirmations",
          enabled: true
        }
      ],
      appointment_email_events: [
        {
          id: "email-event-1",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          email_type: "appointment_scheduled",
          recipient_email: "first@example.com",
          status: "queued",
          created_at: "2026-05-10T10:00:00.000Z",
          template_data: {
            service_name: "Trim",
            appointment_start_time: "2099-05-12T16:00:00.000Z"
          }
        },
        {
          id: "email-event-2",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          email_type: "appointment_rescheduled",
          recipient_email: "second@example.com",
          status: "queued",
          created_at: "2026-05-10T11:00:00.000Z",
          template_data: {
            service_name: "Color",
            appointment_start_time: "2099-05-13T16:00:00.000Z",
            status: "scheduled"
          }
        }
      ]
    });

    try {
      const result = await appointmentEmailDeliveryService.processQueuedAppointmentEmails({
        provider,
        limit: 1
      });

      assert.equal(result.processed, 1);
      assert.equal(sentMessages.length, 1);
      assert.equal(supabase.state.appointment_email_events[0]?.status, "sent");
      assert.equal(supabase.state.appointment_email_events[0]?.attempt_count, 1);
      assert.equal(supabase.state.appointment_email_events[1]?.status, "queued");
    } finally {
      supabase.restore();
    }
  });

  it("retries failed events and stale sending events without touching fresh sending events", async () => {
    const sentMessages: EmailMessage[] = [];
    const provider: EmailProvider = {
      async send(message) {
        sentMessages.push(message);
        return {
          status: "sent",
          provider: "test-provider"
        };
      }
    };
    const supabase = installMockSupabase({
      automation_settings: [
        {
          user_id: TEST_USER_ID,
          key: "email_confirmations",
          enabled: true
        }
      ],
      appointment_email_events: [
        {
          id: "failed-event",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          email_type: "appointment_scheduled",
          recipient_email: "failed@example.com",
          status: "failed",
          attempt_count: 1,
          created_at: "2026-05-10T10:00:00.000Z",
          last_attempt_at: "2026-05-10T10:30:00.000Z",
          template_data: {
            service_name: "Trim",
            appointment_start_time: "2099-05-12T16:00:00.000Z"
          }
        },
        {
          id: "stale-sending-event",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          email_type: "appointment_rescheduled",
          recipient_email: "stale@example.com",
          status: "sending",
          attempt_count: 1,
          created_at: "2026-05-10T10:01:00.000Z",
          last_attempt_at: "2026-05-10T10:35:00.000Z",
          template_data: {
            service_name: "Color",
            appointment_start_time: "2099-05-13T16:00:00.000Z",
            status: "scheduled"
          }
        },
        {
          id: "fresh-sending-event",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          email_type: "appointment_pending",
          recipient_email: "fresh@example.com",
          status: "sending",
          attempt_count: 1,
          created_at: "2026-05-10T10:02:00.000Z",
          last_attempt_at: "2026-05-10T10:55:00.000Z",
          template_data: {
            service_name: "Gloss",
            appointment_start_time: "2099-05-14T16:00:00.000Z"
          }
        },
        {
          id: "max-attempts-event",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          email_type: "appointment_confirmed",
          recipient_email: "max@example.com",
          status: "failed",
          attempt_count: 3,
          created_at: "2026-05-10T10:03:00.000Z",
          last_attempt_at: "2026-05-10T10:20:00.000Z",
          template_data: {
            service_name: "Cut",
            appointment_start_time: "2099-05-15T16:00:00.000Z"
          }
        }
      ]
    });

    try {
      const result = await appointmentEmailDeliveryService.processQueuedAppointmentEmails({
        provider,
        now: new Date("2026-05-10T11:00:00.000Z"),
        staleSendingAfterMinutes: 15,
        maxAttempts: 3
      });

      assert.deepEqual(result, {
        processed: 2,
        sent: 2,
        skipped: 0,
        failed: 0
      });
      assert.equal(sentMessages.length, 2);
      assert.equal(supabase.state.appointment_email_events[0]?.status, "sent");
      assert.equal(supabase.state.appointment_email_events[0]?.attempt_count, 2);
      assert.equal(supabase.state.appointment_email_events[1]?.status, "sent");
      assert.equal(supabase.state.appointment_email_events[1]?.attempt_count, 2);
      assert.equal(supabase.state.appointment_email_events[2]?.status, "sending");
      assert.equal(supabase.state.appointment_email_events[2]?.attempt_count, 1);
      assert.equal(supabase.state.appointment_email_events[3]?.status, "failed");
      assert.equal(supabase.state.appointment_email_events[3]?.attempt_count, 3);
    } finally {
      supabase.restore();
    }
  });

  it("requires the internal API secret before processing appointment emails", async () => {
    await withInternalApiSecret(undefined, async () => {
      const missingConfigResponse = await runWithErrorHandler(
        (request, res, next) => requireInternalApiSecret(request, res, next),
        createMockRequest()
      );

      assert.equal(missingConfigResponse.statusCode, 503);
      assert.deepEqual(missingConfigResponse.body, {
        error: {
          message: "Internal API secret is not configured",
          details: undefined
        }
      });
    });

    await withInternalApiSecret("test-internal-secret-value", async () => {
      const invalidSecretResponse = await runWithErrorHandler(
        (request, res, next) => requireInternalApiSecret(request, res, next),
        createMockRequest({ headers: { "x-internal-api-secret": "wrong-secret" } })
      );

      assert.equal(invalidSecretResponse.statusCode, 401);
      assert.deepEqual(invalidSecretResponse.body, {
        error: {
          message: "Invalid internal API secret",
          details: undefined
        }
      });
    });
  });

  it("processes queued appointment emails through the internal trigger", async () => {
    const supabase = installMockSupabase({
      automation_settings: [
        {
          user_id: TEST_USER_ID,
          key: "email_confirmations",
          enabled: true
        }
      ],
      appointment_email_events: [
        {
          id: "email-event-1",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          email_type: "appointment_pending",
          recipient_email: "jane@example.com",
          status: "queued",
          created_at: "2026-05-10T10:00:00.000Z",
          template_data: {
            recipient_name: "Jane Doe",
            service_name: "Trim",
            appointment_start_time: "2099-05-12T16:00:00.000Z"
          }
        }
      ]
    });

    try {
      await withInternalApiSecret("test-internal-secret-value", async () => {
        const req = createMockRequest({
          headers: { "x-internal-api-secret": "test-internal-secret-value" },
          query: { limit: "1", allow_noop: true } as never
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

          await internalController.processAppointmentEmails(request, res);
        }, req);

        assert.equal(response.statusCode, 200);
        assert.deepEqual(response.body, {
          data: {
            processed: 1,
            sent: 0,
            skipped: 1,
            failed: 0
          }
        });
        assert.equal(supabase.state.appointment_email_events[0]?.status, "skipped");
        assert.equal(supabase.state.appointment_email_events[0]?.provider, "noop");
      });
    } finally {
      supabase.restore();
    }
  });

  it("skips non-essential email when marketing preferences are disabled", async () => {
    const supabase = installMockSupabase({
      client_communication_preferences: [
        {
          id: "preference-1",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          email: "jane@example.com",
          email_normalized: "jane@example.com",
          email_transactional_enabled: true,
          email_reminders_enabled: true,
          email_marketing_enabled: false,
          email_rebooking_enabled: true,
          opted_out_all_email: false
        }
      ],
      global_email_unsubscribes: []
    });

    try {
      const result = await communicationPreferencesService.canSendCommunication({
        userId: TEST_USER_ID,
        clientId: TEST_CLIENT_ID,
        channel: "email",
        to: "Jane@Example.com",
        messageType: "rebooking_prompt"
      });

      assert.equal(result.canSend, false);
      assert.equal(result.reason, "opted_out");
    } finally {
      supabase.restore();
    }
  });

  it("applies global email unsubscribes across stylists while allowing appointment updates", async () => {
    const otherUserId = "33333333-3333-4333-8333-333333333333";
    const supabase = installMockSupabase({
      global_email_unsubscribes: [
        {
          id: "global-unsubscribe-1",
          email_normalized: "jane@example.com",
          opted_out_at: "2026-05-10T10:00:00.000Z",
          opt_out_source: "unsubscribe_link"
        }
      ],
      client_communication_preferences: [
        {
          id: "other-preference-1",
          user_id: otherUserId,
          client_id: TEST_CLIENT_ID,
          email: "jane@example.com",
          email_normalized: "jane@example.com",
          email_transactional_enabled: true,
          email_reminders_enabled: true,
          email_marketing_enabled: true,
          email_rebooking_enabled: true,
          opted_out_all_email: false
        }
      ]
    });

    try {
      const rebookForOriginalStylist = await communicationPreferencesService.canSendCommunication({
        userId: TEST_USER_ID,
        clientId: TEST_CLIENT_ID,
        channel: "email",
        to: "Jane@Example.com",
        messageType: "rebooking_prompt"
      });
      const birthdayForOtherStylist = await communicationPreferencesService.canSendCommunication({
        userId: otherUserId,
        clientId: TEST_CLIENT_ID,
        channel: "email",
        to: "jane@example.com",
        messageType: "birthday_reminder"
      });
      const confirmationForOtherStylist = await communicationPreferencesService.canSendCommunication({
        userId: otherUserId,
        clientId: TEST_CLIENT_ID,
        channel: "email",
        to: "jane@example.com",
        messageType: "appointment_confirmation"
      });
      const cancellationForOtherStylist = await communicationPreferencesService.canSendCommunication({
        userId: otherUserId,
        clientId: TEST_CLIENT_ID,
        channel: "email",
        to: "jane@example.com",
        messageType: "appointment_cancelled"
      });
      const rescheduleForOtherStylist = await communicationPreferencesService.canSendCommunication({
        userId: otherUserId,
        clientId: TEST_CLIENT_ID,
        channel: "email",
        to: "jane@example.com",
        messageType: "appointment_rescheduled"
      });

      assert.equal(rebookForOriginalStylist.canSend, false);
      assert.equal(rebookForOriginalStylist.reason, "global_unsubscribe");
      assert.equal(birthdayForOtherStylist.canSend, false);
      assert.equal(birthdayForOtherStylist.reason, "global_unsubscribe");
      assert.equal(confirmationForOtherStylist.canSend, true);
      assert.equal(cancellationForOtherStylist.canSend, true);
      assert.equal(rescheduleForOtherStylist.canSend, true);
    } finally {
      supabase.restore();
    }
  });

  it("logs globally unsubscribed non-essential email as skipped", async () => {
    const sentMessages: EmailMessage[] = [];
    const provider: EmailProvider = {
      async send(message) {
        sentMessages.push(message);
        return {
          status: "sent",
          provider: "test-provider"
        };
      }
    };
    const supabase = installMockSupabase({
      global_email_unsubscribes: [
        {
          id: "global-unsubscribe-1",
          email_normalized: "jane@example.com",
          opted_out_at: "2026-05-10T10:00:00.000Z",
          opt_out_source: "unsubscribe_link"
        }
      ],
      appointment_email_events: [
        {
          id: "email-event-1",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          email_type: "rebooking_prompt",
          recipient_email: "jane@example.com",
          status: "queued",
          created_at: "2026-05-10T10:00:00.000Z",
          template_data: {
            recipient_name: "Jane Doe",
            service_name: "Trim",
            last_appointment_time: "2026-02-10T16:00:00.000Z",
            message_type: "rebooking_prompt"
          }
        }
      ],
      client_communication_preferences: [],
      communication_events: []
    });

    try {
      const result = await appointmentEmailDeliveryService.processQueuedAppointmentEmails({
        provider,
        now: new Date("2026-05-10T11:00:00.000Z")
      });

      assert.deepEqual(result, {
        processed: 1,
        sent: 0,
        skipped: 1,
        failed: 0
      });
      assert.equal(sentMessages.length, 0);
      assert.equal(supabase.state.appointment_email_events[0]?.status, "skipped");
      assert.equal(supabase.state.appointment_email_events[0]?.error, "global_unsubscribe");
      assert.equal(supabase.state.communication_events[0]?.status, "skipped_opted_out");
      assert.equal(supabase.state.communication_events[0]?.error_code, "global_unsubscribe");
    } finally {
      supabase.restore();
    }
  });

  it("caches global unsubscribe checks during one queued email processing run", async () => {
    const sentMessages: EmailMessage[] = [];
    const provider: EmailProvider = {
      async send(message) {
        sentMessages.push(message);
        return {
          status: "sent",
          provider: "test-provider"
        };
      }
    };
    const globalLookup = mock.method(
      globalEmailUnsubscribesService,
      "isGloballyUnsubscribed",
      async () => false
    );
    const supabase = installMockSupabase({
      appointment_email_events: [
        {
          id: "email-event-1",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          email_type: "rebooking_prompt",
          recipient_email: "Jane@Example.com",
          status: "queued",
          created_at: "2026-05-10T10:00:00.000Z",
          template_data: {
            recipient_name: "Jane Doe",
            service_name: "Trim",
            last_service_name: "Trim",
            last_appointment_display: "February 10, 2026",
            message_type: "rebooking_prompt"
          }
        },
        {
          id: "email-event-2",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          email_type: "rebooking_prompt",
          recipient_email: "jane@example.com",
          status: "queued",
          created_at: "2026-05-10T10:01:00.000Z",
          template_data: {
            recipient_name: "Jane Doe",
            service_name: "Trim",
            last_service_name: "Trim",
            last_appointment_display: "February 10, 2026",
            message_type: "rebooking_prompt"
          }
        }
      ],
      client_communication_preferences: [
        {
          id: "preference-1",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          email: "jane@example.com",
          email_normalized: "jane@example.com",
          email_transactional_enabled: true,
          email_reminders_enabled: true,
          email_marketing_enabled: true,
          email_rebooking_enabled: true,
          opted_out_all_email: false
        }
      ],
      communication_preference_tokens: []
    });

    try {
      const result = await appointmentEmailDeliveryService.processQueuedAppointmentEmails({
        provider,
        now: new Date("2026-05-10T11:00:00.000Z"),
        limit: 2
      });

      assert.deepEqual(result, {
        processed: 2,
        sent: 2,
        skipped: 0,
        failed: 0
      });
      assert.equal(sentMessages.length, 2);
      assert.equal(globalLookup.mock.callCount(), 1);
    } finally {
      globalLookup.mock.restore();
      supabase.restore();
    }
  });

  it("requires explicit SMS opt-in before allowing reminder texts", async () => {
    const supabase = installMockSupabase({
      client_communication_preferences: [
        {
          id: "preference-1",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          phone: "(720) 555-0100",
          phone_normalized: "+17205550100",
          sms_transactional_enabled: true,
          sms_reminders_enabled: true,
          sms_marketing_enabled: false,
          sms_rebooking_enabled: false,
          opted_out_all_sms: false,
          sms_opted_in_at: null
        }
      ]
    });

    try {
      const missingConsent = await communicationPreferencesService.canSendCommunication({
        userId: TEST_USER_ID,
        clientId: TEST_CLIENT_ID,
        channel: "sms",
        to: "(720) 555-0100",
        messageType: "appointment_reminder"
      });

      assert.equal(missingConsent.canSend, false);
      assert.equal(missingConsent.reason, "missing_sms_consent");

      await communicationPreferencesService.optInSms({
        userId: TEST_USER_ID,
        clientId: TEST_CLIENT_ID,
        phone: "(720) 555-0100",
        source: "booking_page",
        consentText: "I agree to receive appointment text updates."
      });

      const optedIn = await communicationPreferencesService.canSendCommunication({
        userId: TEST_USER_ID,
        clientId: TEST_CLIENT_ID,
        channel: "sms",
        to: "(720) 555-0100",
        messageType: "appointment_reminder"
      });

      assert.equal(optedIn.canSend, true);
      assert.equal(supabase.state.communication_consent_events.length, 1);
      assert.equal(supabase.state.communication_consent_events[0]?.event_type, "opted_in");
    } finally {
      supabase.restore();
    }
  });

  it("disables all SMS preferences on inbound STOP without enabling marketing on START", async () => {
    const supabase = installMockSupabase({
      client_communication_preferences: [
        {
          id: "preference-1",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          phone: "(720) 555-0100",
          phone_normalized: "+17205550100",
          sms_transactional_enabled: true,
          sms_reminders_enabled: true,
          sms_marketing_enabled: true,
          sms_rebooking_enabled: true,
          opted_out_all_sms: false,
          sms_opted_in_at: "2026-05-10T10:00:00.000Z"
        }
      ]
    });

    try {
      const stopReply = await communicationsService.handleInboundSms({
        from: "(720) 555-0100",
        body: "STOP",
        messageSid: "sms-message-1"
      });

      assert.match(stopReply, /unsubscribed/);
      assert.equal(supabase.state.client_communication_preferences[0]?.opted_out_all_sms, true);
      assert.equal(supabase.state.client_communication_preferences[0]?.sms_transactional_enabled, false);
      assert.equal(supabase.state.client_communication_preferences[0]?.sms_marketing_enabled, false);
      assert.equal(supabase.state.communication_consent_events[0]?.event_type, "inbound_stop");
      assert.equal(supabase.state.communication_events[0]?.status, "inbound_stop");

      await communicationsService.handleInboundSms({
        from: "(720) 555-0100",
        body: "START",
        messageSid: "sms-message-2"
      });

      assert.equal(supabase.state.client_communication_preferences[0]?.opted_out_all_sms, false);
      assert.equal(supabase.state.client_communication_preferences[0]?.sms_transactional_enabled, true);
      assert.equal(supabase.state.client_communication_preferences[0]?.sms_reminders_enabled, true);
      assert.equal(supabase.state.client_communication_preferences[0]?.sms_marketing_enabled, false);
      assert.equal(supabase.state.client_communication_preferences[0]?.sms_rebooking_enabled, false);
    } finally {
      supabase.restore();
    }
  });

  it("stores only hashed unsubscribe tokens and applies safe unsubscribe responses", async () => {
    const supabase = installMockSupabase({
      users: [
        {
          id: TEST_USER_ID,
          business_name: "Maya Johnson Hair"
        }
      ],
      client_communication_preferences: [
        {
          id: "preference-1",
          user_id: TEST_USER_ID,
          client_id: TEST_CLIENT_ID,
          email: "jane@example.com",
          email_normalized: "jane@example.com",
          email_transactional_enabled: true,
          email_reminders_enabled: true,
          email_marketing_enabled: true,
          email_rebooking_enabled: true,
          opted_out_all_email: false
        }
      ]
    });

    try {
      const rawToken = await communicationPreferenceTokensService.createCommunicationPreferenceToken({
        userId: TEST_USER_ID,
        clientId: TEST_CLIENT_ID,
        channel: "email",
        contactValue: "jane@example.com",
        messageType: "marketing",
        action: "unsubscribe",
        expiresAt: new Date("2099-01-01T00:00:00.000Z")
      });

      assert.ok(rawToken.length > 20);
      assert.notEqual(supabase.state.communication_preference_tokens[0]?.token_hash, rawToken);
      assert.equal(supabase.state.communication_preference_tokens[0]?.raw_token, undefined);

      const confirmation = await communicationsService.unsubscribe(rawToken, {
        ipAddress: "127.0.0.1",
        userAgent: "test-agent"
      });

      assert.match(confirmation, /unsubscribed/);
      assert.equal(supabase.state.client_communication_preferences[0]?.email_reminders_enabled, false);
      assert.equal(supabase.state.client_communication_preferences[0]?.email_marketing_enabled, false);
      assert.equal(supabase.state.client_communication_preferences[0]?.email_rebooking_enabled, false);
      assert.equal(supabase.state.global_email_unsubscribes.length, 1);
      assert.equal(supabase.state.global_email_unsubscribes[0]?.email_normalized, "jane@example.com");
      assert.equal(supabase.state.global_email_unsubscribes[0]?.triggering_user_id, TEST_USER_ID);
      assert.equal(supabase.state.global_email_unsubscribes[0]?.triggering_client_id, TEST_CLIENT_ID);
      assert.equal(supabase.state.global_email_unsubscribes[0]?.triggering_message_type, "marketing");
      assert.equal(supabase.state.global_email_unsubscribes[0]?.preference_token_id, supabase.state.communication_preference_tokens[0]?.id);
      assert.equal(supabase.state.communication_consent_events[0]?.event_type, "unsubscribe_link_clicked");
      assert.equal(supabase.state.communication_events[0]?.status, "unsubscribed");

      await communicationsService.unsubscribe(rawToken);

      assert.equal(supabase.state.global_email_unsubscribes.length, 1);

      await assert.rejects(
        () => communicationsService.unsubscribe("invalid-token"),
        (error) => error instanceof Error && error.message === "This unsubscribe link is invalid or expired."
      );
    } finally {
      supabase.restore();
    }
  });
});
