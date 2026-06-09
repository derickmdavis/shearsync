import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
const { communicationPreferenceTokensService } =
  require("../services/communicationPreferenceTokens") as typeof import("../services/communicationPreferenceTokens");
const { communicationsService } =
  require("../services/communicationsService") as typeof import("../services/communicationsService");
const { env } = require("../config/env") as typeof import("../config/env");
const { internalController } =
  require("../controllers/internalController") as typeof import("../controllers/internalController");
const { requireInternalApiSecret } =
  require("../middleware/internalAuth") as typeof import("../middleware/internalAuth");
const { errorHandler } = require("../middleware/errorHandler") as typeof import("../middleware/errorHandler");
import type { EmailMessage, EmailProvider } from "../services/appointmentEmailDeliveryService";

const TEST_USER_ID = "11111111-1111-1111-1111-111111111111";
const TEST_CLIENT_ID = "22222222-2222-2222-2222-222222222222";

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

describe("appointment email delivery", () => {
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

  it("refuses to process queued events without a real provider unless noop is explicitly allowed", async () => {
    const supabase = installMockSupabase({
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
      ]
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
      assert.equal(supabase.state.client_communication_preferences[0]?.email_marketing_enabled, false);
      assert.equal(supabase.state.client_communication_preferences[0]?.email_rebooking_enabled, false);
      assert.equal(supabase.state.communication_consent_events[0]?.event_type, "unsubscribe_link_clicked");
      assert.equal(supabase.state.communication_events[0]?.status, "unsubscribed");

      await assert.rejects(
        () => communicationsService.unsubscribe("invalid-token"),
        (error) => error instanceof Error && error.message === "This unsubscribe link is invalid or expired."
      );
    } finally {
      supabase.restore();
    }
  });
});
