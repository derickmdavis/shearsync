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
const { env } = require("../config/env") as typeof import("../config/env");
const { internalController } =
  require("../controllers/internalController") as typeof import("../controllers/internalController");
const { requireInternalApiSecret } =
  require("../middleware/internalAuth") as typeof import("../middleware/internalAuth");
const { errorHandler } = require("../middleware/errorHandler") as typeof import("../middleware/errorHandler");
import type { EmailMessage, EmailProvider } from "../services/appointmentEmailDeliveryService";

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
});
