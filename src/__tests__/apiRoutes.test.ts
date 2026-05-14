import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type { NextFunction, Request, Response } from "express";
import {
  addDays,
  getCurrentLocalDate,
  getStartOfLocalDayUtc,
  zonedDateTimeToUtc
} from "../lib/timezone";

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = process.env.AUTH_MODE ?? "production";
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key";
process.env.SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET ?? "test-public-booking-secret";

const { env } = require("../config/env") as typeof import("../config/env");
const { installMockSupabase } = require("./helpers/mockSupabase") as typeof import("./helpers/mockSupabase");
const { supabaseAnon } = require("../lib/supabase") as typeof import("../lib/supabase");
const { appointmentsController } = require("../controllers/appointmentsController") as typeof import("../controllers/appointmentsController");
const { publicController } = require("../controllers/publicController") as typeof import("../controllers/publicController");
const { waitlistController } = require("../controllers/waitlistController") as typeof import("../controllers/waitlistController");
const { servicesController } = require("../controllers/servicesController") as typeof import("../controllers/servicesController");
const { profileController } = require("../controllers/profileController") as typeof import("../controllers/profileController");
const { accountController } = require("../controllers/accountController") as typeof import("../controllers/accountController");
const { authController } = require("../controllers/authController") as typeof import("../controllers/authController");
const { settingsController } = require("../controllers/settingsController") as typeof import("../controllers/settingsController");
const { clientsController } = require("../controllers/clientsController") as typeof import("../controllers/clientsController");
const { entitlementsService } = require("../services/entitlementsService") as typeof import("../services/entitlementsService");
const { parseEnv } = require("../config/env") as typeof import("../config/env");
const { normalizePhone } = require("../lib/phone") as typeof import("../lib/phone");
const { errorHandler } = require("../middleware/errorHandler") as typeof import("../middleware/errorHandler");
const { requireAuth } = require("../middleware/auth") as typeof import("../middleware/auth");
const { validate } = require("../middleware/validate") as typeof import("../middleware/validate");
const {
  createPublicBookingIntakeSchema,
  createPublicBookingSchema,
  getPublicAvailabilitySchema,
  getPublicAvailabilitySlotsSchema,
  getPublicServicesSchema
} =
  require("../validators/publicBookingValidators") as typeof import("../validators/publicBookingValidators");
const {
  createPublicWaitlistEntrySchema,
  createStylistWaitlistEntrySchema,
  updateWaitlistEntrySchema
} = require("../validators/waitlistValidators") as typeof import("../validators/waitlistValidators");
const { createServiceSchema, reorderServicesSchema, updateServiceSchema } =
  require("../validators/serviceValidators") as typeof import("../validators/serviceValidators");
const { createAppointmentSchema, pendingAppointmentDecisionSchema } =
  require("../validators/appointmentValidators") as typeof import("../validators/appointmentValidators");
const { createClientSchema } =
  require("../validators/clientValidators") as typeof import("../validators/clientValidators");
const { replaceAvailabilitySchema, updateBookingRulesSchema, updateProfileSchema, updateBookingSettingsSchema } =
  require("../validators/settingsValidators") as typeof import("../validators/settingsValidators");
const { updateAccountPlanSchema } =
  require("../validators/accountValidators") as typeof import("../validators/accountValidators");
const { uuidParamSchema } = require("../validators/common") as typeof import("../validators/common");
const { profileOverviewQuerySchema } =
  require("../validators/profileValidators") as typeof import("../validators/profileValidators");
const { createPublicAppointmentManagementToken } =
  require("../lib/publicAppointmentManagement") as typeof import("../lib/publicAppointmentManagement");

const userId = "11111111-1111-1111-1111-111111111111";
const otherUserId = "22222222-2222-2222-2222-222222222222";
const ownedServiceId = "33333333-3333-4333-8333-333333333333";
const foreignServiceId = "44444444-4444-4444-8444-444444444444";
const fakeJwt = "eyJhbGciOiJSUzI1NiIsImtpZCI6InRlc3Qta2lkIn0.eyJzdWIiOiIxMTExMTExMS0xMTExLTExMTEtMTExMS0xMTExMTExMTExMTEiLCJlbWFpbCI6Imp3dC11c2VyQGV4YW1wbGUuY29tIiwiYXVkIjoiYXV0aGVudGljYXRlZCIsImlzcyI6Imh0dHBzOi8vZXhhbXBsZS5zdXBhYmFzZS5jby9hdXRoL3YxIn0.signature";

const withAuthConfig = async <T>(
  config: {
    authMode: "dev" | "production";
    enableDevAuthFallback?: boolean;
    devAuthUserId?: string;
    devAuthUserEmail?: string;
  },
  callback: () => Promise<T>
): Promise<T> => {
  const previous = {
    authMode: env.AUTH_MODE,
    enableDevAuthFallback: env.ENABLE_DEV_AUTH_FALLBACK,
    devAuthUserId: env.DEV_AUTH_USER_ID,
    devAuthUserEmail: env.DEV_AUTH_USER_EMAIL
  };

  env.AUTH_MODE = config.authMode;
  env.ENABLE_DEV_AUTH_FALLBACK = config.enableDevAuthFallback ?? false;
  env.DEV_AUTH_USER_ID = config.devAuthUserId;
  env.DEV_AUTH_USER_EMAIL = config.devAuthUserEmail;

  try {
    return await callback();
  } finally {
    env.AUTH_MODE = previous.authMode;
    env.ENABLE_DEV_AUTH_FALLBACK = previous.enableDevAuthFallback;
    env.DEV_AUTH_USER_ID = previous.devAuthUserId;
    env.DEV_AUTH_USER_EMAIL = previous.devAuthUserEmail;
  }
};

const withMockSupabaseClaims = async <T>(
  result: {
    data?: { claims?: { sub?: string; email?: string; aud?: string | string[]; iss?: string } } | null;
    error?: { message: string } | null;
  },
  callback: () => Promise<T>
): Promise<T> => {
  const getClaimsMock = mock.method(supabaseAnon.auth, "getClaims", async () => ({
    data: result.data ?? null,
    error: result.error ?? null
  }));

  try {
    return await callback();
  } finally {
    getClaimsMock.mock.restore();
  }
};

const getNextLocalDay = (startDate: string, targetDayOfWeek: number): string => {
  for (let offset = 0; offset < 14; offset += 1) {
    const dateText = addDays(startDate, offset);
    if (getStartOfLocalDayUtc(dateText, "UTC").getUTCDay() === targetDayOfWeek) {
      return dateText;
    }
  }

  throw new Error("Unable to resolve local day");
};

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

const withBookingContextTokenPlaceholder = <T extends { data: { bookingContextToken: string } }>(payload: T): T => {
  assert.equal(typeof payload.data.bookingContextToken, "string");
  assert.ok(payload.data.bookingContextToken.length > 20);

  return {
    ...payload,
    data: {
      ...payload.data,
      bookingContextToken: "booking-context-token"
    }
  };
};

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
): Promise<MockResponse | null> => {
  let failedResponse: MockResponse | null = null;

  const response = await runWithErrorHandler(
    (request, res, next) =>
      validate(schemas as never)(request, res, (error) => {
        if (error) {
          next(error);
          failedResponse = {
            statusCode: (res as unknown as { statusCode?: number }).statusCode ?? 400,
            body: (res as unknown as { body?: unknown }).body ?? null
          };
        }
      }),
    req
  );

  if (response.body) {
    return response;
  }

  return failedResponse;
};

describe("API handlers", () => {
  it("defaults auth mode to production and disables dev auth fallback", () => {
    const parsed = parseEnv({
      SUPABASE_URL: env.SUPABASE_URL,
      SUPABASE_ANON_KEY: env.SUPABASE_ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY
    });

    assert.equal(parsed.AUTH_MODE, "production");
    assert.equal(parsed.ENABLE_DEV_AUTH_FALLBACK, false);
  });

  it("rejects production configuration when AUTH_MODE is dev", () => {
    assert.throws(
      () =>
        parseEnv({
          SUPABASE_URL: env.SUPABASE_URL,
          SUPABASE_ANON_KEY: env.SUPABASE_ANON_KEY,
          SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
          NODE_ENV: "production",
          AUTH_MODE: "dev"
        }),
      /AUTH_MODE must be production when NODE_ENV is production/
    );
  });

  it("resolves a valid JWT auth user", async () => {
    await withMockSupabaseClaims(
      {
        data: {
          claims: {
            sub: userId,
            email: "jwt-user@example.com",
            aud: "authenticated",
            iss: `${env.SUPABASE_URL}/auth/v1`
          }
        }
      },
      async () => {
        await withAuthConfig({ authMode: "production" }, async () => {
          const req = createMockRequest({
            headers: {
              authorization: `Bearer ${fakeJwt}`
            }
          });

          const response = await runWithErrorHandler(
            async (request, res, next) => {
              await requireAuth(request, res, next);
              res.status(204).send();
            },
            req
          );

          assert.equal(response.statusCode, 204);
          assert.deepEqual(req.auth, {
            userId,
            email: "jwt-user@example.com",
            source: "jwt"
          });
        });
      }
    );
  });

  it("rejects an invalid JWT", async () => {
    await withMockSupabaseClaims(
      {
        error: {
          message: "invalid JWT: unable to parse or verify signature"
        }
      },
      async () => {
        await withAuthConfig({ authMode: "production" }, async () => {
          const req = createMockRequest({
            headers: {
              authorization: "Bearer not-a-real-token"
            }
          });

          const response = await runWithErrorHandler((request, _res, next) => requireAuth(request, {} as Response, next), req);

          assert.equal(response.statusCode, 401);
          assert.deepEqual(response.body, {
            error: {
              message: "Invalid or expired token",
              details: {
                reason: "invalid JWT: unable to parse or verify signature"
              }
            }
          });
        });
      }
    );
  });

  it("rejects a malformed authorization header", async () => {
    await withAuthConfig({ authMode: "production" }, async () => {
      const req = createMockRequest({
        headers: {
          authorization: "Token something"
        }
      });

      const response = await runWithErrorHandler((request, _res, next) => requireAuth(request, {} as Response, next), req);

      assert.equal(response.statusCode, 401);
      assert.deepEqual(response.body, {
        error: {
          message: "Malformed authorization header",
          details: undefined
        }
      });
    });
  });

  it("uses DEV_AUTH_USER_ID when JWT is missing in dev mode", async () => {
    await withAuthConfig(
      {
        authMode: "dev",
        enableDevAuthFallback: true,
        devAuthUserId: userId,
        devAuthUserEmail: "dev-user@example.com"
      },
      async () => {
        const req = createMockRequest();
        const response = await runWithErrorHandler(
          async (request, res, next) => {
            await requireAuth(request, res, next);
            res.status(204).send();
          },
          req
        );

        assert.equal(response.statusCode, 204);
        assert.deepEqual(req.auth, {
          userId,
          email: "dev-user@example.com",
          source: "dev"
        });
      }
    );
  });

  it("returns 401 when JWT is missing in dev mode without explicit fallback", async () => {
    await withAuthConfig(
      {
        authMode: "dev",
        enableDevAuthFallback: false,
        devAuthUserId: userId
      },
      async () => {
        const req = createMockRequest();
        const response = await runWithErrorHandler((request, _res, next) => requireAuth(request, {} as Response, next), req);

        assert.equal(response.statusCode, 401);
        assert.deepEqual(response.body, {
          error: {
            message: "Missing bearer token",
            details: undefined
          }
        });
      }
    );
  });

  it("returns 401 when JWT is missing in production mode", async () => {
    await withAuthConfig({ authMode: "production" }, async () => {
      const req = createMockRequest();
      const response = await runWithErrorHandler((request, _res, next) => requireAuth(request, {} as Response, next), req);

      assert.equal(response.statusCode, 401);
      assert.deepEqual(response.body, {
        error: {
          message: "Missing bearer token",
          details: undefined
        }
      });
    });
  });

  it("returns 404 when the authenticated user cannot be found", async () => {
    await withAuthConfig({ authMode: "production" }, async () => {
      const req = createMockRequest({
        auth: {
          userId,
          source: "jwt"
        },
        user: {
          id: userId
        }
      });

      const supabase = installMockSupabase({
        users: []
      });

      try {
        const response = await runWithErrorHandler((request, res) => authController.getMe(request, res), req);

        assert.equal(response.statusCode, 404);
        assert.deepEqual(response.body, {
          error: {
            message: "Authenticated user not found",
            details: undefined
          }
        });
      } finally {
        supabase.restore();
      }
    });
  });

  it("validates profile overview query params", async () => {
    const invalidResponse = await runValidation(createMockRequest({ query: { performancePeriod: "year" } }), {
      query: profileOverviewQuerySchema
    });

    assert.equal(invalidResponse?.statusCode, 400);

    const validResponse = await runValidation(createMockRequest({ query: { performancePeriod: "month" } }), {
      query: profileOverviewQuerySchema
    });

    assert.equal(validResponse, null);
  });

  it("normalizes valid public booking phones", () => {
    assert.equal(normalizePhone("(720) 555-0148"), "+17205550148");
    assert.equal(normalizePhone("720-555-0148"), "+17205550148");
    assert.equal(normalizePhone("1 720 555 0148"), "+17205550148");
    assert.equal(normalizePhone("+1 720 555 0148"), "+17205550148");
  });

  it("rejects invalid public booking phones", () => {
    assert.equal(normalizePhone("abc"), null);
    assert.equal(normalizePhone("555-0102"), null);
    assert.equal(normalizePhone("++17205550148"), null);
  });

  it("lists services with the richer catalog shape", async () => {
    const supabase = installMockSupabase({
      services: [
        {
          id: "service-2",
          user_id: userId,
          name: "Color",
          description: "Gloss and tone",
          category: "Color",
          duration_minutes: 90,
          price: 120,
          is_active: true,
          is_default: false,
          sort_order: 2,
          created_at: "2026-01-01T00:00:00.000Z"
        },
        {
          id: "service-1",
          user_id: userId,
          name: "Cut",
          description: "Precision cut",
          category: "Cut",
          duration_minutes: 45,
          price: 65,
          is_active: true,
          is_default: true,
          sort_order: 1,
          created_at: "2026-01-01T00:00:00.000Z"
        }
      ]
    });

    try {
      const req = createMockRequest({ user: { id: userId } as Request["user"] });
      const response = await runWithErrorHandler((request, res) => servicesController.list(request, res), req);

      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.body, {
        data: [
          {
            id: "service-1",
            name: "Cut",
            duration: 45,
            durationMinutes: 45,
            price: 65,
            priceAmount: 65,
            visible: true,
            category: "Cut",
            description: "Precision cut",
            isDefault: true,
            sortOrder: 1
          },
          {
            id: "service-2",
            name: "Color",
            duration: 90,
            durationMinutes: 90,
            price: 120,
            priceAmount: 120,
            visible: true,
            category: "Color",
            description: "Gloss and tone",
            isDefault: false,
            sortOrder: 2
          }
        ]
      });
    } finally {
      supabase.restore();
    }
  });

  it("validates service creation payloads", async () => {
    const req = createMockRequest({
      body: {
        name: "",
        visible: true
      }
    });

    const response = await runWithErrorHandler(validate({ body: createServiceSchema }), req);

    assert.equal(response.statusCode, 400);
    assert.equal((response.body as { error: { message: string } }).error.message, "Validation failed");
  });

  it("accepts the expanded create client payload", async () => {
    const validResponse = await runValidation(
      createMockRequest({
        body: {
          first_name: "Ava",
          last_name: "Martinez",
          preferred_name: "Avi",
          phone: "(555) 218-4401",
          email: "ava@example.com",
          instagram: "@avamartinezhair",
          birthday: "1994-05-12",
          preferred_contact_method: "text",
          notes: "Prefers afternoon appointments.",
          tags: ["VIP", "Blonde"],
          source: "instagram",
          reminder_consent: true
        }
      }),
      { body: createClientSchema }
    );

    assert.equal(validResponse, null);

    const nullableResponse = await runValidation(
      createMockRequest({
        body: {
          first_name: "Ava",
          last_name: "Martinez",
          preferred_name: null,
          instagram: null,
          preferred_contact_method: null,
          tags: null,
          source: null,
          reminder_consent: null,
          total_spend: null,
          last_visit_at: null
        }
      }),
      { body: createClientSchema }
    );

    assert.equal(nullableResponse, null);

    const invalidResponse = await runValidation(
      createMockRequest({
        body: {
          first_name: "Ava",
          last_name: "Martinez",
          preferred_contact_method: "carrier-pigeon"
        }
      }),
      { body: createClientSchema }
    );

    assert.equal(invalidResponse?.statusCode, 400);
  });

  it("returns enriched client list metadata", async () => {
    mock.timers.enable({ apis: ["Date"], now: new Date("2026-04-30T12:00:00.000Z") });
    const futureAppointment = "2026-05-01T12:00:00.000Z";
    const pastAppointment = "2026-04-29T12:00:00.000Z";
    const olderPastAppointment = "2026-01-30T12:00:00.000Z";
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          timezone: "UTC"
        }
      ],
      clients: [
        {
          id: "client-1",
          user_id: userId,
          first_name: "Ava",
          last_name: "Martinez",
          preferred_name: "Avi",
          phone: "(555) 218-4401",
          email: "ava@example.com",
          tags: ["VIP", "Blonde"],
          reminder_consent: true,
          updated_at: "2026-04-27T12:00:00.000Z"
        },
        {
          id: "client-2",
          user_id: userId,
          first_name: "Noah",
          last_name: "Kim",
          updated_at: "2026-04-26T12:00:00.000Z"
        }
      ],
      appointments: [
        {
          id: "appointment-1",
          user_id: userId,
          client_id: "client-1",
          appointment_date: futureAppointment,
          service_name: "Balayage Refresh",
          duration_minutes: 90,
          status: "scheduled"
        },
        {
          id: "appointment-2",
          user_id: userId,
          client_id: "client-1",
          appointment_date: pastAppointment,
          service_name: "Gloss",
          duration_minutes: 60,
          status: "scheduled"
        },
        {
          id: "appointment-3",
          user_id: userId,
          client_id: "client-2",
          appointment_date: olderPastAppointment,
          service_name: "Haircut",
          duration_minutes: 45,
          status: "scheduled"
        }
      ]
    });

    try {
      const req = createMockRequest({ user: { id: userId } as Request["user"] });
      const response = await runWithErrorHandler((request, res) => clientsController.list(request, res), req);

      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.body, {
        data: [
          {
            id: "client-1",
            user_id: userId,
            first_name: "Ava",
            last_name: "Martinez",
            preferred_name: "Avi",
            phone: "(555) 218-4401",
            email: "ava@example.com",
            phone_normalized: null,
            instagram: null,
            preferred_contact_method: null,
            tags: ["VIP", "Blonde"],
            source: null,
            reminder_consent: true,
            total_spend: null,
            last_visit_at: null,
            updated_at: "2026-04-27T12:00:00.000Z",
            next_appointment_at: futureAppointment,
            has_future_appointment: true,
            needs_rebook: false,
            last_service: "Gloss"
          },
          {
            id: "client-2",
            user_id: userId,
            first_name: "Noah",
            last_name: "Kim",
            preferred_name: null,
            phone_normalized: null,
            instagram: null,
            preferred_contact_method: null,
            tags: null,
            source: null,
            reminder_consent: null,
            total_spend: null,
            last_visit_at: null,
            updated_at: "2026-04-26T12:00:00.000Z",
            next_appointment_at: null,
            has_future_appointment: false,
            needs_rebook: true,
            last_service: "Haircut"
          }
        ]
      });
    } finally {
      supabase.restore();
      mock.timers.reset();
    }
  });

  it("creates clients with the expanded persisted fields", async () => {
    const supabase = installMockSupabase({
      clients: [],
      appointments: []
    });

    try {
      const req = createMockRequest({
        user: { id: userId } as Request["user"],
        body: {
          first_name: "Ava",
          last_name: "Martinez",
          preferred_name: "Avi",
          phone: "(555) 218-4401",
          email: "ava@example.com",
          instagram: "@avamartinezhair",
          preferred_contact_method: "text",
          notes: "Prefers afternoon appointments.",
          tags: ["VIP", "Blonde", "VIP"],
          source: "instagram",
          reminder_consent: true
        }
      });

      const response = await runWithErrorHandler((request, res) => clientsController.create(request, res), req);
      const createdClient = (response.body as { data: Record<string, unknown> }).data;

      assert.equal(response.statusCode, 201);
      assert.equal(createdClient.preferred_name, "Avi");
      assert.equal(createdClient.instagram, "avamartinezhair");
      assert.equal(createdClient.preferred_contact_method, "text");
      assert.deepEqual(createdClient.tags, ["VIP", "Blonde"]);
      assert.equal(createdClient.source, "instagram");
      assert.equal(createdClient.reminder_consent, true);
      assert.equal(createdClient.phone_normalized, "+15552184401");
      assert.equal(createdClient.next_appointment_at, null);
      assert.equal(createdClient.has_future_appointment, false);
      assert.equal(createdClient.needs_rebook, false);
      assert.equal(createdClient.last_service, null);
    } finally {
      supabase.restore();
    }
  });

  it("creates, updates, deletes, and reorders services", async () => {
    const supabase = installMockSupabase({
      services: [
        {
          id: "55555555-5555-4555-8555-555555555555",
          user_id: userId,
          name: "Cut",
          description: "Precision cut",
          category: "Cut",
          duration_minutes: 45,
          price: 65,
          is_active: true,
          is_default: true,
          sort_order: 1,
          created_at: "2026-01-01T00:00:00.000Z"
        },
        {
          id: "66666666-6666-4666-8666-666666666666",
          user_id: userId,
          name: "Blowout",
          description: null,
          category: "Style",
          duration_minutes: 30,
          price: 40,
          is_active: true,
          is_default: false,
          sort_order: 2,
          created_at: "2026-01-02T00:00:00.000Z"
        }
      ]
    });

    try {
      const createReq = createMockRequest({
        user: { id: userId } as Request["user"],
        body: createServiceSchema.parse({
          name: "Balayage",
          durationMinutes: 150,
          priceAmount: 180,
          category: "Color",
          description: "Optional client-facing notes",
          visible: true
        })
      });
      const createResponse = await runWithErrorHandler((request, res) => servicesController.create(request, res), createReq);

      assert.equal(createResponse.statusCode, 201);
      const created = (createResponse.body as {
        data: {
          id: string;
          name: string;
          duration: number;
          durationMinutes: number;
          price: number;
          priceAmount: number;
          visible: boolean;
          category?: string;
          description?: string;
          isDefault: boolean;
          sortOrder: number;
        };
      }).data;
      assert.equal(created.name, "Balayage");
      assert.equal(created.sortOrder, 3);

      const updateReq = createMockRequest({
        user: { id: userId } as Request["user"],
        params: { id: created.id },
        body: updateServiceSchema.parse({
          price: 195,
          visible: false,
          description: "Updated description"
        })
      });
      await runWithErrorHandler(validate({ params: uuidParamSchema, body: updateServiceSchema }), updateReq);
      const updateResponse = await runWithErrorHandler((request, res) => servicesController.update(request, res), updateReq);

      assert.equal(updateResponse.statusCode, 200);
      assert.deepEqual((updateResponse.body as { data: object }).data, {
        ...created,
        price: 195,
        priceAmount: 195,
        visible: false,
        description: "Updated description"
      });

      const reorderReq = createMockRequest({
        user: { id: userId } as Request["user"],
        body: reorderServicesSchema.parse({
          serviceIds: [created.id, "66666666-6666-4666-8666-666666666666", "55555555-5555-4555-8555-555555555555"]
        })
      });
      const reorderResponse = await runWithErrorHandler((request, res) => servicesController.reorder(request, res), reorderReq);

      assert.equal(reorderResponse.statusCode, 200);
      assert.deepEqual(
        (reorderResponse.body as { data: Array<{ id: string; sortOrder: number }> }).data.map((service) => ({
          id: service.id,
          sortOrder: service.sortOrder
        })),
        [
          { id: created.id, sortOrder: 1 },
          { id: "66666666-6666-4666-8666-666666666666", sortOrder: 2 },
          { id: "55555555-5555-4555-8555-555555555555", sortOrder: 3 }
        ]
      );

      const deleteReq = createMockRequest({
        user: { id: userId } as Request["user"],
        params: { id: created.id }
      });
      await runWithErrorHandler(validate({ params: uuidParamSchema }), deleteReq);
      const deleteResponse = await runWithErrorHandler((request, res) => servicesController.delete(request, res), deleteReq);

      assert.equal(deleteResponse.statusCode, 204);
      assert.equal(supabase.state.services.some((service) => service.id === created.id), false);
    } finally {
      supabase.restore();
    }
  });

  it("enforces service ownership on update and reorder", async () => {
    const supabase = installMockSupabase({
      services: [
        {
          id: ownedServiceId,
          user_id: userId,
          name: "Cut",
          description: null,
          category: "Cut",
          duration_minutes: 45,
          price: 65,
          is_active: true,
          is_default: false,
          sort_order: 1
        },
        {
          id: foreignServiceId,
          user_id: otherUserId,
          name: "Foreign",
          description: null,
          category: "Cut",
          duration_minutes: 45,
          price: 65,
          is_active: true,
          is_default: false,
          sort_order: 1
        }
      ]
    });

    try {
      const updateReq = createMockRequest({
        user: { id: userId } as Request["user"],
        params: { id: foreignServiceId },
        body: updateServiceSchema.parse({
          price: 75
        })
      });
      const updateResponse = await runWithErrorHandler((request, res) => servicesController.update(request, res), updateReq);
      assert.equal(updateResponse.statusCode, 404);

      const reorderReq = createMockRequest({
        user: { id: userId } as Request["user"],
        body: reorderServicesSchema.parse({
          serviceIds: [ownedServiceId, foreignServiceId]
        })
      });
      const reorderResponse = await runWithErrorHandler((request, res) => servicesController.reorder(request, res), reorderReq);

      assert.equal(reorderResponse.statusCode, 400);
      assert.deepEqual(reorderResponse.body, {
        error: {
          message: "serviceIds must all belong to services owned by the authenticated user",
          details: undefined
        }
      });
    } finally {
      supabase.restore();
    }
  });

  it("returns an expanded public stylist profile", async () => {
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "maya@example.com",
          business_name: "Maya Johnson Hair",
          phone_number: "555-0101",
          timezone: "America/Denver",
          plan_tier: "pro",
          plan_status: "active"
        }
      ],
      stylists: [
        {
          id: "stylist-1",
          user_id: userId,
          slug: "maya-johnson",
          display_name: "Maya Johnson",
          bio: "Lived-in color specialist",
          cover_photo_url: "https://example.com/cover.jpg",
          booking_enabled: true
        }
      ]
    });

    try {
      const req = createMockRequest({ params: { slug: "maya-johnson" } });
      const response = await runWithErrorHandler((request, res) => publicController.getStylist(request, res), req);

      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.body, {
        data: {
          id: "stylist-1",
          slug: "maya-johnson",
          display_name: "Maya Johnson",
          bio: "Lived-in color specialist",
          cover_photo_url: "https://example.com/cover.jpg",
          booking_enabled: true,
          business_name: "Maya Johnson Hair",
          phone_number: "555-0101",
          timezone: "America/Denver",
          features: {
            waitlistEnabled: true
          }
        }
      });
    } finally {
      supabase.restore();
    }
  });

  it("still returns the public stylist profile when online booking is disabled", async () => {
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "maya@example.com",
          business_name: "Maya Johnson Hair",
          timezone: "America/Denver",
          plan_tier: "basic",
          plan_status: "active"
        }
      ],
      stylists: [
        {
          id: "stylist-1",
          user_id: userId,
          slug: "maya-johnson",
          display_name: "Maya Johnson",
          booking_enabled: false
        }
      ]
    });

    try {
      const req = createMockRequest({ params: { slug: "maya-johnson" } });
      const response = await runWithErrorHandler((request, res) => publicController.getStylist(request, res), req);

      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.body, {
        data: {
          id: "stylist-1",
          slug: "maya-johnson",
          display_name: "Maya Johnson",
          bio: null,
          cover_photo_url: null,
          booking_enabled: false,
          business_name: "Maya Johnson Hair",
          phone_number: null,
          timezone: "America/Denver",
          features: {
            waitlistEnabled: false
          }
        }
      });
    } finally {
      supabase.restore();
    }
  });

  it("returns public waitlist metadata by stylist plan", async () => {
    for (const [planTier, expected] of [
      ["basic", false],
      ["pro", true],
      ["premium", true]
    ] as const) {
      const supabase = installMockSupabase({
        users: [
          {
            id: userId,
            email: `${planTier}@example.com`,
            timezone: "America/Denver",
            plan_tier: planTier,
            plan_status: "active"
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
        ]
      });

      try {
        const req = createMockRequest({ params: { slug: "maya-johnson" } });
        const response = await runWithErrorHandler((request, res) => publicController.getStylist(request, res), req);

        assert.equal(response.statusCode, 200);
        assert.equal(
          ((response.body as { data: { features: { waitlistEnabled: boolean } } }).data.features.waitlistEnabled),
          expected
        );
      } finally {
        supabase.restore();
      }
    }
  });

  it("rejects public waitlist creation for a Basic stylist", async () => {
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "basic@example.com",
          timezone: "UTC",
          plan_tier: "basic",
          plan_status: "active"
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
      waitlist_entries: []
    });

    try {
      const req = createMockRequest({
        params: { slug: "maya-johnson" },
        body: createPublicWaitlistEntrySchema.parse({
          requestedDate: getCurrentLocalDate("UTC"),
          clientName: "Ava Martinez",
          clientEmail: "ava@example.com"
        })
      });
      const response = await runWithErrorHandler((request, res) => publicController.createWaitlistEntry(request, res), req);

      assert.equal(response.statusCode, 403);
      assert.equal((response.body as { error: { message: string } }).error.message, "Waitlist is not available for this stylist.");
      assert.equal(supabase.state.waitlist_entries.length, 0);
    } finally {
      supabase.restore();
    }
  });

  it("creates a public waitlist entry for a Pro stylist", async () => {
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "pro@example.com",
          timezone: "UTC",
          plan_tier: "pro",
          plan_status: "active"
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
      services: [
        {
          id: ownedServiceId,
          user_id: userId,
          name: "Color",
          duration_minutes: 90,
          price: 150,
          is_active: true,
          is_default: false,
          sort_order: 1
        }
      ],
      clients: [],
      waitlist_entries: []
    });

    try {
      const req = createMockRequest({
        params: { slug: "maya-johnson" },
        body: createPublicWaitlistEntrySchema.parse({
          requestedDate: getCurrentLocalDate("UTC"),
          serviceId: ownedServiceId,
          requestedTimePreference: "Morning preferred",
          clientName: "Ava Martinez",
          clientEmail: "AVA@EXAMPLE.COM",
          clientPhone: "(555) 555-1212",
          note: "Anytime after 10am."
        })
      });
      const response = await runWithErrorHandler((request, res) => publicController.createWaitlistEntry(request, res), req);
      const entry = (response.body as { data: { id: string; clientEmail: string; clientPhone: string; status: string } }).data;

      assert.equal(response.statusCode, 201);
      assert.equal(entry.clientEmail, "ava@example.com");
      assert.equal(entry.clientPhone, "+15555551212");
      assert.equal(entry.status, "active");
      assert.equal(supabase.state.waitlist_entries.length, 1);
      assert.equal(supabase.state.waitlist_entries[0]?.source, "public_booking");
    } finally {
      supabase.restore();
    }
  });

  it("validates public waitlist contact and date input", async () => {
    const missingNameReq = createMockRequest({
      body: {
        requestedDate: getCurrentLocalDate("UTC"),
        clientEmail: "ava@example.com"
      }
    });
    const missingNameResponse = await runValidation(missingNameReq, { body: createPublicWaitlistEntrySchema });
    assert.equal(missingNameResponse?.statusCode, 400);

    const missingContactReq = createMockRequest({
      body: {
        requestedDate: getCurrentLocalDate("UTC"),
        clientName: "Ava Martinez"
      }
    });
    const missingContactResponse = await runValidation(missingContactReq, { body: createPublicWaitlistEntrySchema });
    assert.equal(missingContactResponse?.statusCode, 400);

    const invalidDateReq = createMockRequest({
      body: {
        requestedDate: "2026-02-31",
        clientName: "Ava Martinez",
        clientEmail: "ava@example.com"
      }
    });
    const invalidDateResponse = await runValidation(invalidDateReq, { body: createPublicWaitlistEntrySchema });
    assert.equal(invalidDateResponse?.statusCode, 400);
  });

  it("rejects public waitlist creation for past dates and foreign services", async () => {
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "pro@example.com",
          timezone: "UTC",
          plan_tier: "pro",
          plan_status: "active"
        },
        {
          id: otherUserId,
          email: "other@example.com"
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
      services: [
        {
          id: foreignServiceId,
          user_id: otherUserId,
          name: "Foreign Color",
          duration_minutes: 90,
          price: 150,
          is_active: true,
          is_default: false,
          sort_order: 1
        }
      ],
      waitlist_entries: []
    });

    try {
      const pastReq = createMockRequest({
        params: { slug: "maya-johnson" },
        body: createPublicWaitlistEntrySchema.parse({
          requestedDate: "2000-01-01",
          clientName: "Ava Martinez",
          clientEmail: "ava@example.com"
        })
      });
      const pastResponse = await runWithErrorHandler((request, res) => publicController.createWaitlistEntry(request, res), pastReq);
      assert.equal(pastResponse.statusCode, 400);
      assert.equal((pastResponse.body as { error: { message: string } }).error.message, "Requested date must be today or later.");

      const foreignServiceReq = createMockRequest({
        params: { slug: "maya-johnson" },
        body: createPublicWaitlistEntrySchema.parse({
          requestedDate: getCurrentLocalDate("UTC"),
          serviceId: foreignServiceId,
          clientName: "Ava Martinez",
          clientEmail: "ava@example.com"
        })
      });
      const foreignServiceResponse = await runWithErrorHandler(
        (request, res) => publicController.createWaitlistEntry(request, res),
        foreignServiceReq
      );
      assert.equal(foreignServiceResponse.statusCode, 400);
      assert.equal((foreignServiceResponse.body as { error: { message: string } }).error.message, "Service does not belong to this stylist.");
    } finally {
      supabase.restore();
    }
  });

  it("allows authenticated stylists to list only their waitlist entries", async () => {
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "pro@example.com",
          timezone: "UTC",
          plan_tier: "pro",
          plan_status: "active"
        }
      ],
      waitlist_entries: [
        {
          id: "55555555-5555-4555-8555-555555555555",
          user_id: userId,
          client_id: null,
          service_id: ownedServiceId,
          requested_date: getCurrentLocalDate("UTC"),
          requested_time_preference: "Morning",
          client_name: "Ava Martinez",
          client_email: "ava@example.com",
          client_phone: null,
          note: null,
          status: "active",
          source: "public_booking",
          created_at: "2026-06-01T12:00:00.000Z",
          updated_at: "2026-06-01T12:00:00.000Z"
        },
        {
          id: "66666666-6666-4666-8666-666666666666",
          user_id: otherUserId,
          client_id: null,
          service_id: null,
          requested_date: getCurrentLocalDate("UTC"),
          requested_time_preference: null,
          client_name: "Other Client",
          client_email: "other@example.com",
          client_phone: null,
          note: null,
          status: "active",
          source: "public_booking",
          created_at: "2026-06-01T12:00:00.000Z",
          updated_at: "2026-06-01T12:00:00.000Z"
        }
      ]
    });

    try {
      const req = createMockRequest({
        user: { id: userId } as Request["user"],
        query: {}
      });
      const response = await runWithErrorHandler((request, res) => waitlistController.list(request, res), req);
      const entries = (response.body as { data: Array<{ id: string }> }).data;

      assert.equal(response.statusCode, 200);
      assert.equal(entries.length, 1);
      assert.equal(entries[0]?.id, "55555555-5555-4555-8555-555555555555");
    } finally {
      supabase.restore();
    }
  });

  it("returns 404 when a stylist accesses another stylist's waitlist entry", async () => {
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "pro@example.com",
          plan_tier: "pro",
          plan_status: "active"
        }
      ],
      waitlist_entries: [
        {
          id: "66666666-6666-4666-8666-666666666666",
          user_id: otherUserId,
          client_id: null,
          service_id: null,
          requested_date: getCurrentLocalDate("UTC"),
          requested_time_preference: null,
          client_name: "Other Client",
          client_email: "other@example.com",
          client_phone: null,
          note: null,
          status: "active",
          source: "public_booking",
          created_at: "2026-06-01T12:00:00.000Z",
          updated_at: "2026-06-01T12:00:00.000Z"
        }
      ]
    });

    try {
      const req = createMockRequest({
        user: { id: userId } as Request["user"],
        params: { id: "66666666-6666-4666-8666-666666666666" }
      });
      const response = await runWithErrorHandler((request, res) => waitlistController.get(request, res), req);

      assert.equal(response.statusCode, 404);
      assert.equal((response.body as { error: { message: string } }).error.message, "Waitlist entry not found");
    } finally {
      supabase.restore();
    }
  });

  it("allows authenticated stylists to update waitlist status and delete entries", async () => {
    const entryId = "55555555-5555-4555-8555-555555555555";
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "pro@example.com",
          timezone: "UTC",
          plan_tier: "pro",
          plan_status: "active"
        }
      ],
      waitlist_entries: [
        {
          id: entryId,
          user_id: userId,
          client_id: null,
          service_id: null,
          requested_date: getCurrentLocalDate("UTC"),
          requested_time_preference: null,
          client_name: "Ava Martinez",
          client_email: "ava@example.com",
          client_phone: null,
          note: null,
          status: "active",
          source: "public_booking",
          created_at: "2026-06-01T12:00:00.000Z",
          updated_at: "2026-06-01T12:00:00.000Z"
        }
      ]
    });

    try {
      const updateReq = createMockRequest({
        user: { id: userId } as Request["user"],
        params: { id: entryId },
        body: updateWaitlistEntrySchema.parse({ status: "contacted" })
      });
      const updateResponse = await runWithErrorHandler((request, res) => waitlistController.update(request, res), updateReq);
      assert.equal(updateResponse.statusCode, 200);
      assert.equal((updateResponse.body as { data: { status: string } }).data.status, "contacted");

      const deleteReq = createMockRequest({
        user: { id: userId } as Request["user"],
        params: { id: entryId }
      });
      const deleteResponse = await runWithErrorHandler((request, res) => waitlistController.delete(request, res), deleteReq);
      assert.equal(deleteResponse.statusCode, 204);
      assert.equal(supabase.state.waitlist_entries.length, 0);
    } finally {
      supabase.restore();
    }
  });

  it("blocks Basic authenticated stylists from creating waitlist entries", async () => {
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "basic@example.com",
          timezone: "UTC",
          plan_tier: "basic",
          plan_status: "active"
        }
      ],
      waitlist_entries: []
    });

    try {
      const req = createMockRequest({
        user: { id: userId } as Request["user"],
        body: createStylistWaitlistEntrySchema.parse({
          requestedDate: getCurrentLocalDate("UTC"),
          clientName: "Ava Martinez",
          clientEmail: "ava@example.com"
        })
      });
      const response = await runWithErrorHandler((request, res) => waitlistController.create(request, res), req);

      assert.equal(response.statusCode, 403);
      assert.equal((response.body as { error: { message: string } }).error.message, "Waitlist is not available for the current plan.");
      assert.equal(supabase.state.waitlist_entries.length, 0);
    } finally {
      supabase.restore();
    }
  });

  it("rejects public services when online booking is disabled", async () => {
    const supabase = installMockSupabase({
      stylists: [
        {
          id: "stylist-1",
          user_id: userId,
          slug: "maya-johnson",
          display_name: "Maya Johnson",
          booking_enabled: false
        }
      ],
      services: [
        {
          id: ownedServiceId,
          user_id: userId,
          name: "Silk Press",
          duration_minutes: 60,
          price: 95,
          is_active: true,
          is_default: false,
          sort_order: 1
        }
      ]
    });

    try {
      const req = createMockRequest({
        params: { slug: "maya-johnson" },
        query: getPublicServicesSchema.parse({})
      });
      const response = await runWithErrorHandler((request, res) => publicController.getServices(request, res), req);

      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.body, {
        error: {
          message: "Online booking is not enabled for this stylist",
          details: undefined
        }
      });
    } finally {
      supabase.restore();
    }
  });

  it("rejects raw public availability when online booking is disabled", async () => {
    const supabase = installMockSupabase({
      stylists: [
        {
          id: "stylist-1",
          user_id: userId,
          slug: "maya-johnson",
          display_name: "Maya Johnson",
          booking_enabled: false
        }
      ],
      availability: [
        {
          id: "availability-1",
          user_id: userId,
          day_of_week: 1,
          start_time: "09:00:00",
          end_time: "17:00:00",
          is_active: true
        }
      ]
    });

    try {
      const req = createMockRequest({ params: { slug: "maya-johnson" } });
      const response = await runWithErrorHandler((request, res) => publicController.getAvailability(request, res), req);

      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.body, {
        error: {
          message: "Online booking is not enabled for this stylist",
          details: undefined
        }
      });
    } finally {
      supabase.restore();
    }
  });

  it("rejects public slots when online booking is disabled", async () => {
    const today = getCurrentLocalDate("UTC");
    const monday = getNextLocalDay(addDays(today, 1), 1);
    const supabase = installMockSupabase({
      stylists: [
        {
          id: "stylist-1",
          user_id: userId,
          slug: "maya-johnson",
          display_name: "Maya Johnson",
          booking_enabled: false
        }
      ]
    });

    try {
      const req = createMockRequest({
        params: { slug: "maya-johnson" },
        query: getPublicAvailabilitySlotsSchema.parse({
          service_id: ownedServiceId,
          date: monday
        })
      });
      const response = await runWithErrorHandler((request, res) => publicController.getAvailabilitySlots(request, res), req);

      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.body, {
        error: {
          message: "Online booking is not enabled for this stylist",
          details: undefined
        }
      });
    } finally {
      supabase.restore();
    }
  });

  it("returns backend-generated public slots that fit availability and avoid overlaps", async () => {
    const today = getCurrentLocalDate("UTC");
    const monday = getNextLocalDay(addDays(today, 1), 1);
    const existingAppointmentIso = zonedDateTimeToUtc(monday, "UTC", 10, 0, 0, 0).toISOString();
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "maya@example.com",
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
          lead_time_hours: 0,
          same_day_booking_allowed: true,
          same_day_booking_cutoff: "23:59:00",
          max_booking_window_days: 3650,
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
          new_client_booking_window_days: 3650,
          restrict_services_for_new_clients: false,
          restricted_service_ids: []
        }
      ],
      services: [
        {
          id: ownedServiceId,
          user_id: userId,
          name: "Silk Press",
          duration_minutes: 60,
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
          day_of_week: 1,
          start_time: "09:00:00",
          end_time: "12:00:00",
          is_active: true
        }
      ],
      appointments: [
        {
          id: "appt-1",
          user_id: userId,
          client_id: "client-1",
          appointment_date: existingAppointmentIso,
          duration_minutes: 60,
          status: "scheduled"
        }
      ]
    });

    try {
      const req = createMockRequest({
        params: { slug: "maya-johnson" },
        query: getPublicAvailabilitySlotsSchema.parse({
          service_id: ownedServiceId,
          date: monday
        })
      });
      const response = await runWithErrorHandler((request, res) => publicController.getAvailabilitySlots(request, res), req);

      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.body, {
        data: {
          date: monday,
          timezone: "UTC",
          service: {
            id: ownedServiceId,
            name: "Silk Press",
            duration_minutes: 60,
            price: 95
          },
          slots: [
            {
              start: `${monday}T09:00:00+00:00`,
              end: `${monday}T10:00:00+00:00`
            },
            {
              start: `${monday}T11:00:00+00:00`,
              end: `${monday}T12:00:00+00:00`
            }
          ]
        }
      });
    } finally {
      supabase.restore();
    }
  });

  it("filters public services using the booking context token", async () => {
    const supabase = installMockSupabase({
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
          restrict_services_for_new_clients: true,
          restricted_service_ids: [ownedServiceId]
        }
      ],
      services: [
        {
          id: ownedServiceId,
          user_id: userId,
          name: "Silk Press",
          duration_minutes: 60,
          price: 95,
          is_active: true,
          is_default: false,
          sort_order: 1
        },
        {
          id: "service-2",
          user_id: userId,
          name: "Consultation",
          duration_minutes: 30,
          price: 25,
          is_active: true,
          is_default: false,
          sort_order: 2
        }
      ],
      clients: [
        {
          id: "client-1",
          user_id: userId,
          first_name: "Jane",
          last_name: "Smith",
          email: "jane@example.com",
          phone: "7205550103",
          phone_normalized: "+17205550103"
        }
      ]
    });

    try {
      const newClientIntakeRequest = createMockRequest({
        body: createPublicBookingIntakeSchema.parse({
          stylist_slug: "maya-johnson",
          full_name: "New Guest",
          phone: "(720) 555-0199",
          email: "new@example.com"
        })
      });
      const newClientIntakeResponse = await runWithErrorHandler(
        (request, res) => publicController.createBookingIntake(request, res),
        newClientIntakeRequest
      );
      const newClientToken = (
        newClientIntakeResponse.body as { data: { bookingContextToken: string } }
      ).data.bookingContextToken;

      const returningClientIntakeRequest = createMockRequest({
        body: createPublicBookingIntakeSchema.parse({
          stylist_slug: "maya-johnson",
          full_name: "Jane Smith",
          phone: "(720) 555-0103",
          email: "jane@example.com"
        })
      });
      const returningClientIntakeResponse = await runWithErrorHandler(
        (request, res) => publicController.createBookingIntake(request, res),
        returningClientIntakeRequest
      );
      const returningClientToken = (
        returningClientIntakeResponse.body as { data: { bookingContextToken: string } }
      ).data.bookingContextToken;

      const newClientServicesResponse = await runWithErrorHandler(
        (request, res) => publicController.getServices(request, res),
        createMockRequest({
          params: { slug: "maya-johnson" },
          query: getPublicServicesSchema.parse({
            booking_context_token: newClientToken
          })
        })
      );

      assert.equal(newClientServicesResponse.statusCode, 200);
      assert.deepEqual(newClientServicesResponse.body, {
        data: [
          {
            id: "service-2",
            user_id: userId,
            name: "Consultation",
            duration_minutes: 30,
            price: 25,
            is_active: true,
            is_default: false,
            sort_order: 2
          }
        ]
      });

      const returningClientServicesResponse = await runWithErrorHandler(
        (request, res) => publicController.getServices(request, res),
        createMockRequest({
          params: { slug: "maya-johnson" },
          query: getPublicServicesSchema.parse({
            booking_context_token: returningClientToken
          })
        })
      );

      assert.equal(returningClientServicesResponse.statusCode, 200);
      assert.deepEqual(returningClientServicesResponse.body, {
        data: [
          {
            id: ownedServiceId,
            user_id: userId,
            name: "Silk Press",
            duration_minutes: 60,
            price: 95,
            is_active: true,
            is_default: false,
            sort_order: 1
          },
          {
            id: "service-2",
            user_id: userId,
            name: "Consultation",
            duration_minutes: 30,
            price: 25,
            is_active: true,
            is_default: false,
            sort_order: 2
          }
        ]
      });
    } finally {
      supabase.restore();
    }
  });

  it("filters raw public availability using the booking context token", async () => {
    const supabase = installMockSupabase({
      stylists: [
        {
          id: "stylist-1",
          user_id: userId,
          slug: "maya-johnson",
          display_name: "Maya Johnson",
          booking_enabled: true
        }
      ],
      availability: [
        {
          id: "availability-1",
          user_id: userId,
          day_of_week: 1,
          start_time: "09:00:00",
          end_time: "10:00:00",
          is_active: true,
          client_audience: "all"
        },
        {
          id: "availability-2",
          user_id: userId,
          day_of_week: 1,
          start_time: "10:00:00",
          end_time: "11:00:00",
          is_active: true,
          client_audience: "new"
        },
        {
          id: "availability-3",
          user_id: userId,
          day_of_week: 1,
          start_time: "11:00:00",
          end_time: "12:00:00",
          is_active: true,
          client_audience: "returning"
        }
      ],
      clients: [
        {
          id: "client-1",
          user_id: userId,
          first_name: "Jane",
          last_name: "Smith",
          email: "jane@example.com",
          phone: "7205550103",
          phone_normalized: "+17205550103"
        }
      ]
    });

    try {
      const newClientIntakeResponse = await runWithErrorHandler(
        (request, res) => publicController.createBookingIntake(request, res),
        createMockRequest({
          body: createPublicBookingIntakeSchema.parse({
            stylist_slug: "maya-johnson",
            full_name: "New Guest",
            phone: "(720) 555-0199",
            email: "new@example.com"
          })
        })
      );
      const newClientToken = (
        newClientIntakeResponse.body as { data: { bookingContextToken: string } }
      ).data.bookingContextToken;

      const returningClientIntakeResponse = await runWithErrorHandler(
        (request, res) => publicController.createBookingIntake(request, res),
        createMockRequest({
          body: createPublicBookingIntakeSchema.parse({
            stylist_slug: "maya-johnson",
            full_name: "Jane Smith",
            phone: "(720) 555-0103",
            email: "jane@example.com"
          })
        })
      );
      const returningClientToken = (
        returningClientIntakeResponse.body as { data: { bookingContextToken: string } }
      ).data.bookingContextToken;

      const newClientAvailabilityResponse = await runWithErrorHandler(
        (request, res) => publicController.getAvailability(request, res),
        createMockRequest({
          params: { slug: "maya-johnson" },
          query: getPublicAvailabilitySchema.parse({
            booking_context_token: newClientToken
          })
        })
      );

      assert.equal(newClientAvailabilityResponse.statusCode, 200);
      assert.deepEqual(newClientAvailabilityResponse.body, {
        data: [
          {
            id: "availability-1",
            user_id: userId,
            day_of_week: 1,
            start_time: "09:00:00",
            end_time: "10:00:00",
            is_active: true,
            client_audience: "all"
          },
          {
            id: "availability-2",
            user_id: userId,
            day_of_week: 1,
            start_time: "10:00:00",
            end_time: "11:00:00",
            is_active: true,
            client_audience: "new"
          }
        ]
      });

      const returningClientAvailabilityResponse = await runWithErrorHandler(
        (request, res) => publicController.getAvailability(request, res),
        createMockRequest({
          params: { slug: "maya-johnson" },
          query: getPublicAvailabilitySchema.parse({
            booking_context_token: returningClientToken
          })
        })
      );

      assert.equal(returningClientAvailabilityResponse.statusCode, 200);
      assert.deepEqual(returningClientAvailabilityResponse.body, {
        data: [
          {
            id: "availability-1",
            user_id: userId,
            day_of_week: 1,
            start_time: "09:00:00",
            end_time: "10:00:00",
            is_active: true,
            client_audience: "all"
          },
          {
            id: "availability-3",
            user_id: userId,
            day_of_week: 1,
            start_time: "11:00:00",
            end_time: "12:00:00",
            is_active: true,
            client_audience: "returning"
          }
        ]
      });
    } finally {
      supabase.restore();
    }
  });

  it("blocks overlapping appointments instead of only exact timestamp collisions", async () => {
    const appointmentDate = "2026-05-05T10:00:00.000Z";
    const overlappingDate = "2026-05-05T10:30:00.000Z";
    const supabase = installMockSupabase({
      clients: [
        {
          id: "77777777-7777-4777-8777-777777777777",
          user_id: userId,
          first_name: "Jane",
          last_name: "Doe"
        }
      ],
      appointments: [
        {
          id: "appt-1",
          user_id: userId,
          client_id: "77777777-7777-4777-8777-777777777777",
          appointment_date: appointmentDate,
          duration_minutes: 60,
          status: "scheduled"
        }
      ]
    });

    try {
      const req = createMockRequest({
        user: { id: userId } as Request["user"],
        body: createAppointmentSchema.parse({
          client_id: "77777777-7777-4777-8777-777777777777",
          appointment_date: overlappingDate,
          service_name: "Trim",
          duration_minutes: 30,
          price: 45
        })
      });

      const response = await runWithErrorHandler((request, res) => appointmentsController.create(request, res), req);

      assert.equal(response.statusCode, 409);
      assert.deepEqual(response.body, {
        error: {
          message: "This time slot is already booked.",
          details: undefined
        }
      });
    } finally {
      supabase.restore();
    }
  });

  it("returns internal appointment context that ignores availability and only filters overlaps", async () => {
    const date = "2026-05-05";
    const busyStart = "2026-05-05T10:00:00.000Z";
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "maya@example.com",
          timezone: "UTC"
        }
      ],
      appointments: [
        {
          id: "appt-1",
          user_id: userId,
          client_id: "77777777-7777-4777-8777-777777777777",
          appointment_date: busyStart,
          duration_minutes: 60,
          status: "scheduled"
        }
      ]
    });

    try {
      const req = createMockRequest({
        user: { id: userId } as Request["user"],
        query: {
          date,
          durationMinutes: "60"
        }
      });

      const response = await runWithErrorHandler((request, res) => appointmentsController.getInternalContext(request, res), req);
      const payload = response.body as {
        data: {
          date: string;
          availableSlots: Array<{ start: string; end: string; label: string }>;
          existingAppointments: Array<{ start: string; end: string }>;
          blockedTimes: unknown[];
        };
      };

      assert.equal(response.statusCode, 200);
      assert.equal(payload.data.date, date);
      assert.deepEqual(payload.data.existingAppointments, [
        {
          start: "2026-05-05T10:00:00+00:00",
          end: "2026-05-05T11:00:00+00:00"
        }
      ]);
      assert.deepEqual(payload.data.blockedTimes, []);
      assert.equal(payload.data.availableSlots.some((slot) => slot.start === "2026-05-05T09:00:00+00:00"), true);
      assert.equal(payload.data.availableSlots.some((slot) => slot.start === "2026-05-05T10:00:00+00:00"), false);
      assert.equal(payload.data.availableSlots.some((slot) => slot.start === "2026-05-05T10:30:00+00:00"), false);
      assert.equal(payload.data.availableSlots.some((slot) => slot.start === "2026-05-05T11:00:00+00:00"), true);
    } finally {
      supabase.restore();
    }
  });

  it("stores internal booking_source by default for authenticated appointment creation", async () => {
    const appointmentDate = "2026-05-06T13:00:00.000Z";
    const supabase = installMockSupabase({
      clients: [
        {
          id: "77777777-7777-4777-8777-777777777777",
          user_id: userId,
          first_name: "Jane",
          last_name: "Doe"
        }
      ],
      appointments: []
    });

    try {
      const req = createMockRequest({
        user: { id: userId } as Request["user"],
        body: createAppointmentSchema.parse({
          client_id: "77777777-7777-4777-8777-777777777777",
          appointment_date: appointmentDate,
          service_name: "Trim",
          duration_minutes: 30,
          price: 45
        })
      });

      const response = await runWithErrorHandler((request, res) => appointmentsController.create(request, res), req);
      const createdAppointment = (response.body as { data: Record<string, unknown> }).data;

      assert.equal(response.statusCode, 201);
      assert.equal(createdAppointment.booking_source, "internal");
      assert.equal(supabase.state.appointments[0]?.booking_source, "internal");
    } finally {
      supabase.restore();
    }
  });

  it("still returns slots when a new client booking would require approval", async () => {
    const today = getCurrentLocalDate("UTC");
    const monday = getNextLocalDay(addDays(today, 1), 1);
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "maya@example.com",
          business_name: "Maya Johnson Hair",
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
          lead_time_hours: 0,
          same_day_booking_allowed: true,
          same_day_booking_cutoff: "23:59:00",
          max_booking_window_days: 3650,
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
          id: ownedServiceId,
          user_id: userId,
          name: "Silk Press",
          duration_minutes: 60,
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
          day_of_week: 1,
          start_time: "09:00:00",
          end_time: "12:00:00",
          is_active: true
        }
      ],
      clients: []
    });

    try {
      const req = createMockRequest({
        params: { slug: "maya-johnson" },
        query: getPublicAvailabilitySlotsSchema.parse({
          service_id: ownedServiceId,
          date: monday
        })
      });

      const response = await runWithErrorHandler((request, res) => publicController.getAvailabilitySlots(request, res), req);

      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.body, {
        data: {
          date: monday,
          timezone: "UTC",
          service: {
            id: ownedServiceId,
            name: "Silk Press",
            duration_minutes: 60,
            price: 95
          },
          slots: [
            {
              start: `${monday}T09:00:00+00:00`,
              end: `${monday}T10:00:00+00:00`
            },
            {
              start: `${monday}T09:15:00+00:00`,
              end: `${monday}T10:15:00+00:00`
            },
            {
              start: `${monday}T09:30:00+00:00`,
              end: `${monday}T10:30:00+00:00`
            },
            {
              start: `${monday}T09:45:00+00:00`,
              end: `${monday}T10:45:00+00:00`
            },
            {
              start: `${monday}T10:00:00+00:00`,
              end: `${monday}T11:00:00+00:00`
            },
            {
              start: `${monday}T10:15:00+00:00`,
              end: `${monday}T11:15:00+00:00`
            },
            {
              start: `${monday}T10:30:00+00:00`,
              end: `${monday}T11:30:00+00:00`
            },
            {
              start: `${monday}T10:45:00+00:00`,
              end: `${monday}T11:45:00+00:00`
            },
            {
              start: `${monday}T11:00:00+00:00`,
              end: `${monday}T12:00:00+00:00`
            }
          ]
        }
      });
    } finally {
      supabase.restore();
    }
  });

  it("uses the booking context token to apply returning-client slot rules", async () => {
    const today = getCurrentLocalDate("UTC");
    const monday = getNextLocalDay(addDays(today, 1), 1);
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "maya@example.com",
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
          lead_time_hours: 0,
          same_day_booking_allowed: true,
          same_day_booking_cutoff: "23:59:00",
          max_booking_window_days: 3650,
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
          restrict_services_for_new_clients: true,
          restricted_service_ids: [ownedServiceId]
        }
      ],
      services: [
        {
          id: ownedServiceId,
          user_id: userId,
          name: "Silk Press",
          duration_minutes: 60,
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
          day_of_week: 1,
          start_time: "09:00:00",
          end_time: "12:00:00",
          is_active: true
        }
      ],
      clients: [
        {
          id: "client-1",
          user_id: userId,
          first_name: "Jane",
          last_name: "Smith",
          email: "jane@example.com",
          phone: "7205550103",
          phone_normalized: "+17205550103"
        }
      ]
    });

    try {
      const newClientIntakeResponse = await runWithErrorHandler(
        (request, res) => publicController.createBookingIntake(request, res),
        createMockRequest({
          body: createPublicBookingIntakeSchema.parse({
            stylist_slug: "maya-johnson",
            full_name: "New Guest",
            phone: "(720) 555-0199",
            email: "new@example.com"
          })
        })
      );
      const newClientToken = (
        newClientIntakeResponse.body as { data: { bookingContextToken: string } }
      ).data.bookingContextToken;

      const returningClientIntakeResponse = await runWithErrorHandler(
        (request, res) => publicController.createBookingIntake(request, res),
        createMockRequest({
          body: createPublicBookingIntakeSchema.parse({
            stylist_slug: "maya-johnson",
            full_name: "Jane Smith",
            phone: "(720) 555-0103",
            email: "jane@example.com"
          })
        })
      );
      const returningClientToken = (
        returningClientIntakeResponse.body as { data: { bookingContextToken: string } }
      ).data.bookingContextToken;

      const newClientSlotsResponse = await runWithErrorHandler(
        (request, res) => publicController.getAvailabilitySlots(request, res),
        createMockRequest({
          params: { slug: "maya-johnson" },
          query: getPublicAvailabilitySlotsSchema.parse({
            service_id: ownedServiceId,
            date: monday,
            booking_context_token: newClientToken
          })
        })
      );

      assert.equal(newClientSlotsResponse.statusCode, 200);
      assert.deepEqual(newClientSlotsResponse.body, {
        data: {
          date: monday,
          timezone: "UTC",
          service: {
            id: ownedServiceId,
            name: "Silk Press",
            duration_minutes: 60,
            price: 95
          },
          slots: []
        }
      });

      const returningClientSlotsResponse = await runWithErrorHandler(
        (request, res) => publicController.getAvailabilitySlots(request, res),
        createMockRequest({
          params: { slug: "maya-johnson" },
          query: getPublicAvailabilitySlotsSchema.parse({
            service_id: ownedServiceId,
            date: monday,
            booking_context_token: returningClientToken
          })
        })
      );

      assert.equal(returningClientSlotsResponse.statusCode, 200);
      assert.deepEqual(returningClientSlotsResponse.body, {
        data: {
          date: monday,
          timezone: "UTC",
          service: {
            id: ownedServiceId,
            name: "Silk Press",
            duration_minutes: 60,
            price: 95
          },
          slots: [
            {
              start: `${monday}T09:00:00+00:00`,
              end: `${monday}T10:00:00+00:00`
            },
            {
              start: `${monday}T09:15:00+00:00`,
              end: `${monday}T10:15:00+00:00`
            },
            {
              start: `${monday}T09:30:00+00:00`,
              end: `${monday}T10:30:00+00:00`
            },
            {
              start: `${monday}T09:45:00+00:00`,
              end: `${monday}T10:45:00+00:00`
            },
            {
              start: `${monday}T10:00:00+00:00`,
              end: `${monday}T11:00:00+00:00`
            },
            {
              start: `${monday}T10:15:00+00:00`,
              end: `${monday}T11:15:00+00:00`
            },
            {
              start: `${monday}T10:30:00+00:00`,
              end: `${monday}T11:30:00+00:00`
            },
            {
              start: `${monday}T10:45:00+00:00`,
              end: `${monday}T11:45:00+00:00`
            },
            {
              start: `${monday}T11:00:00+00:00`,
              end: `${monday}T12:00:00+00:00`
            }
          ]
        }
      });
    } finally {
      supabase.restore();
    }
  });

  it("uses audience-specific availability windows for new versus returning clients", async () => {
    const today = getCurrentLocalDate("UTC");
    const monday = getNextLocalDay(addDays(today, 1), 1);
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "maya@example.com",
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
          lead_time_hours: 0,
          same_day_booking_allowed: true,
          same_day_booking_cutoff: "23:59:00",
          max_booking_window_days: 3650,
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
      services: [
        {
          id: ownedServiceId,
          user_id: userId,
          name: "Silk Press",
          duration_minutes: 60,
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
          day_of_week: 1,
          start_time: "09:00:00",
          end_time: "10:00:00",
          is_active: true,
          client_audience: "all"
        },
        {
          id: "availability-2",
          user_id: userId,
          day_of_week: 1,
          start_time: "10:00:00",
          end_time: "11:00:00",
          is_active: true,
          client_audience: "new"
        },
        {
          id: "availability-3",
          user_id: userId,
          day_of_week: 1,
          start_time: "11:00:00",
          end_time: "12:00:00",
          is_active: true,
          client_audience: "returning"
        }
      ],
      clients: [
        {
          id: "client-1",
          user_id: userId,
          first_name: "Jane",
          last_name: "Smith",
          email: "jane@example.com",
          phone: "7205550103",
          phone_normalized: "+17205550103"
        }
      ]
    });

    try {
      const newClientIntakeResponse = await runWithErrorHandler(
        (request, res) => publicController.createBookingIntake(request, res),
        createMockRequest({
          body: createPublicBookingIntakeSchema.parse({
            stylist_slug: "maya-johnson",
            full_name: "New Guest",
            phone: "(720) 555-0199",
            email: "new@example.com"
          })
        })
      );
      const newClientToken = (
        newClientIntakeResponse.body as { data: { bookingContextToken: string } }
      ).data.bookingContextToken;

      const returningClientIntakeResponse = await runWithErrorHandler(
        (request, res) => publicController.createBookingIntake(request, res),
        createMockRequest({
          body: createPublicBookingIntakeSchema.parse({
            stylist_slug: "maya-johnson",
            full_name: "Jane Smith",
            phone: "(720) 555-0103",
            email: "jane@example.com"
          })
        })
      );
      const returningClientToken = (
        returningClientIntakeResponse.body as { data: { bookingContextToken: string } }
      ).data.bookingContextToken;

      const newClientSlotsResponse = await runWithErrorHandler(
        (request, res) => publicController.getAvailabilitySlots(request, res),
        createMockRequest({
          params: { slug: "maya-johnson" },
          query: getPublicAvailabilitySlotsSchema.parse({
            service_id: ownedServiceId,
            date: monday,
            booking_context_token: newClientToken
          })
        })
      );

      assert.equal(newClientSlotsResponse.statusCode, 200);
      assert.deepEqual(newClientSlotsResponse.body, {
        data: {
          date: monday,
          timezone: "UTC",
          service: {
            id: ownedServiceId,
            name: "Silk Press",
            duration_minutes: 60,
            price: 95
          },
          slots: [
            {
              start: `${monday}T09:00:00+00:00`,
              end: `${monday}T10:00:00+00:00`
            },
            {
              start: `${monday}T10:00:00+00:00`,
              end: `${monday}T11:00:00+00:00`
            }
          ]
        }
      });

      const returningClientSlotsResponse = await runWithErrorHandler(
        (request, res) => publicController.getAvailabilitySlots(request, res),
        createMockRequest({
          params: { slug: "maya-johnson" },
          query: getPublicAvailabilitySlotsSchema.parse({
            service_id: ownedServiceId,
            date: monday,
            booking_context_token: returningClientToken
          })
        })
      );

      assert.equal(returningClientSlotsResponse.statusCode, 200);
      assert.deepEqual(returningClientSlotsResponse.body, {
        data: {
          date: monday,
          timezone: "UTC",
          service: {
            id: ownedServiceId,
            name: "Silk Press",
            duration_minutes: 60,
            price: 95
          },
          slots: [
            {
              start: `${monday}T09:00:00+00:00`,
              end: `${monday}T10:00:00+00:00`
            },
            {
              start: `${monday}T11:00:00+00:00`,
              end: `${monday}T12:00:00+00:00`
            }
          ]
        }
      });
    } finally {
      supabase.restore();
    }
  });

  it("applies audience-specific availability rules during final public booking creation", async () => {
    const today = getCurrentLocalDate("UTC");
    const monday = getNextLocalDay(addDays(today, 1), 1);
    const returningOnlySlotIso = zonedDateTimeToUtc(monday, "UTC", 11, 0, 0, 0).toISOString();
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "maya@example.com",
          business_name: "Maya Johnson Hair",
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
          lead_time_hours: 0,
          same_day_booking_allowed: true,
          same_day_booking_cutoff: "23:59:00",
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
      services: [
        {
          id: ownedServiceId,
          user_id: userId,
          name: "Silk Press",
          duration_minutes: 60,
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
          day_of_week: 1,
          start_time: "09:00:00",
          end_time: "10:00:00",
          is_active: true,
          client_audience: "all"
        },
        {
          id: "availability-2",
          user_id: userId,
          day_of_week: 1,
          start_time: "11:00:00",
          end_time: "12:00:00",
          is_active: true,
          client_audience: "returning"
        }
      ],
      clients: [
        {
          id: "client-1",
          user_id: userId,
          first_name: "Jane",
          last_name: "Smith",
          email: "jane@example.com",
          phone: "7205550103",
          phone_normalized: "+17205550103"
        }
      ],
      appointments: []
    });

    try {
      const newClientResponse = await runWithErrorHandler(
        (request, res) => publicController.createBooking(request, res),
        createMockRequest({
          body: createPublicBookingSchema.parse({
            stylist_slug: "maya-johnson",
            service_id: ownedServiceId,
            requested_datetime: returningOnlySlotIso,
            guest_first_name: "New",
            guest_last_name: "Guest",
            guest_email: "new@example.com",
            guest_phone: "(720) 555-0199"
          })
        })
      );

      assert.equal(newClientResponse.statusCode, 409);
      assert.deepEqual(newClientResponse.body, {
        error: {
          message: "Requested time is no longer available",
          details: undefined
        }
      });

      const returningClientResponse = await runWithErrorHandler(
        (request, res) => publicController.createBooking(request, res),
        createMockRequest({
          body: createPublicBookingSchema.parse({
            stylist_slug: "maya-johnson",
            service_id: ownedServiceId,
            requested_datetime: returningOnlySlotIso,
            guest_first_name: "Jane",
            guest_last_name: "Smith",
            guest_email: "jane@example.com",
            guest_phone: "(720) 555-0103"
          })
        })
      );

      assert.equal(returningClientResponse.statusCode, 201);
      assert.equal((returningClientResponse.body as { data: { appointment_date: string } }).data.appointment_date, returningOnlySlotIso);
    } finally {
      supabase.restore();
    }
  });

  it("creates pending public bookings when a new client requires approval", async () => {
    const today = getCurrentLocalDate("UTC");
    const monday = getNextLocalDay(addDays(today, 1), 1);
    const requestedDateTime = zonedDateTimeToUtc(monday, "UTC", 9, 0, 0, 0).toISOString();
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "maya@example.com",
          business_name: "Maya Johnson Hair",
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
          lead_time_hours: 0,
          same_day_booking_allowed: true,
          same_day_booking_cutoff: "23:59:00",
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
          id: ownedServiceId,
          user_id: userId,
          name: "Silk Press",
          duration_minutes: 60,
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
          day_of_week: 1,
          start_time: "09:00:00",
          end_time: "12:00:00",
          is_active: true
        }
      ],
      clients: []
    });

    try {
      const req = createMockRequest({
        body: createPublicBookingSchema.parse({
          stylist_slug: "maya-johnson",
          service_id: ownedServiceId,
          requested_datetime: requestedDateTime,
          guest_first_name: "New",
          guest_last_name: "Client",
          guest_email: "new@example.com",
          guest_phone: "(720) 555-0102"
        })
      });

      const response = await runWithErrorHandler((request, res) => publicController.createBooking(request, res), req);

      assert.equal(response.statusCode, 201);
      assert.deepEqual(response.body, {
        data: {
          appointment_id: supabase.state.appointments[0]?.id,
          client_id: supabase.state.clients[0]?.id,
          stylist_slug: "maya-johnson",
          stylist_display_name: "Maya Johnson",
          business_name: "Maya Johnson Hair",
          service_id: ownedServiceId,
          service_name: "Silk Press",
          service_duration_minutes: 60,
          service_price: 95,
          appointment_date: requestedDateTime,
          appointment_end: `${monday}T10:00:00+00:00`,
          business_timezone: "UTC",
          status: "pending"
        }
      });
      assert.equal(supabase.state.appointments[0]?.status, "pending");
      assert.equal(supabase.state.clients[0]?.phone_normalized, "+17205550102");
      assert.equal(supabase.state.appointment_email_events.length, 1);
      assert.equal(supabase.state.appointment_email_events[0]?.email_type, "appointment_pending");
      assert.equal(supabase.state.appointment_email_events[0]?.recipient_email, "new@example.com");
      assert.equal(
        supabase.state.appointment_email_events[0]?.idempotency_key,
        `appointment_pending:${supabase.state.appointments[0]?.id}`
      );
    } finally {
      supabase.restore();
    }
  });

  it("still returns far-future public slots when newClientBookingWindowDays is 0", async () => {
    const today = getCurrentLocalDate("UTC");
    const futureMonday = getNextLocalDay(addDays(today, 45), 1);
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "maya@example.com",
          business_name: "Maya Johnson Hair",
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
          lead_time_hours: 0,
          same_day_booking_allowed: true,
          same_day_booking_cutoff: "23:59:00",
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
          new_client_booking_window_days: 0,
          restrict_services_for_new_clients: false,
          restricted_service_ids: []
        }
      ],
      services: [
        {
          id: ownedServiceId,
          user_id: userId,
          name: "Silk Press",
          duration_minutes: 60,
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
          day_of_week: 1,
          start_time: "09:00:00",
          end_time: "12:00:00",
          is_active: true
        }
      ],
      clients: []
    });

    try {
      const req = createMockRequest({
        params: { slug: "maya-johnson" },
        query: getPublicAvailabilitySlotsSchema.parse({
          service_id: ownedServiceId,
          date: futureMonday
        })
      });

      const response = await runWithErrorHandler((request, res) => publicController.getAvailabilitySlots(request, res), req);
      const slots = (response.body as { data: { slots: Array<{ start: string; end: string }> } }).data.slots;

      assert.equal(response.statusCode, 200);
      assert.equal(slots.length > 0, true);
      assert.deepEqual(slots[0], {
        start: `${futureMonday}T09:00:00+00:00`,
        end: `${futureMonday}T10:00:00+00:00`
      });
    } finally {
      supabase.restore();
    }
  });

  it("allows far-future public bookings when newClientBookingWindowDays is 0", async () => {
    const today = getCurrentLocalDate("UTC");
    const futureMonday = getNextLocalDay(addDays(today, 45), 1);
    const requestedDateTime = zonedDateTimeToUtc(futureMonday, "UTC", 9, 0, 0, 0).toISOString();
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "maya@example.com",
          business_name: "Maya Johnson Hair",
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
          lead_time_hours: 0,
          same_day_booking_allowed: true,
          same_day_booking_cutoff: "23:59:00",
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
          new_client_booking_window_days: 0,
          restrict_services_for_new_clients: false,
          restricted_service_ids: []
        }
      ],
      services: [
        {
          id: ownedServiceId,
          user_id: userId,
          name: "Silk Press",
          duration_minutes: 60,
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
          day_of_week: 1,
          start_time: "09:00:00",
          end_time: "12:00:00",
          is_active: true
        }
      ],
      clients: []
    });

    try {
      const req = createMockRequest({
        body: createPublicBookingSchema.parse({
          stylist_slug: "maya-johnson",
          service_id: ownedServiceId,
          requested_datetime: requestedDateTime,
          guest_first_name: "Future",
          guest_last_name: "Client",
          guest_email: "future@example.com",
          guest_phone: "(720) 555-0103"
        })
      });

      const response = await runWithErrorHandler((request, res) => publicController.createBooking(request, res), req);

      assert.equal(response.statusCode, 201);
      assert.equal((response.body as { data: { status: string } }).data.status, "scheduled");
      assert.equal(supabase.state.appointments[0]?.appointment_date, requestedDateTime);
    } finally {
      supabase.restore();
    }
  });

  it("returns matched booking intake data for an existing client by normalized phone", async () => {
    const supabase = installMockSupabase({
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
          name: "Haircut",
          duration_minutes: 60,
          price: 80,
          is_active: true,
          is_default: false,
          sort_order: 1
        },
        {
          id: "service-2",
          user_id: userId,
          name: "Consultation",
          duration_minutes: 30,
          price: 0,
          is_active: true,
          is_default: true,
          sort_order: 2
        }
      ],
      clients: [
        {
          id: "client-1",
          user_id: userId,
          first_name: "Jane",
          last_name: "Smith",
          email: "jane@example.com",
          phone: "7205550148",
          phone_normalized: "+17205550148"
        }
      ],
      appointments: [
        {
          id: "appt-1",
          user_id: userId,
          client_id: "client-1",
          appointment_date: "2026-05-01T10:00:00.000Z",
          duration_minutes: 60,
          service_name: "Haircut",
          status: "completed"
        }
      ]
    });

    try {
      const req = createMockRequest({
        body: createPublicBookingIntakeSchema.parse({
          stylist_slug: "maya-johnson",
          full_name: "Jane Smith",
          phone: "(720) 555-0148",
          email: "jane@example.com"
        })
      });

      const response = await runWithErrorHandler((request, res) => publicController.createBookingIntake(request, res), req);

      assert.equal(response.statusCode, 200);
      assert.deepEqual(withBookingContextTokenPlaceholder(response.body as { data: { bookingContextToken: string } }), {
        data: {
          matchStatus: "matched",
          clientFound: true,
          isExistingClient: true,
          bookingContextToken: "booking-context-token",
          bookingEnabled: true,
          client: {
            id: "client-1",
            firstName: "Jane",
            lastName: "Smith",
            email: "jane@example.com",
            phoneMasked: "***-***-0148"
          },
          submittedContact: {
            fullName: "Jane Smith",
            phoneNormalized: "+17205550148",
            email: "jane@example.com"
          },
          recommendedService: {
            serviceId: "service-1",
            serviceName: "Haircut",
            reason: "last_completed_service"
          },
          bookingBehavior: {
            requiresApproval: false,
            restrictedToNewClientRules: false,
            canUseReturningClientRules: true,
            message: "Welcome back — you can book directly."
          }
        }
      });
    } finally {
      supabase.restore();
    }
  });

  it("returns not_found booking intake data for an unknown phone", async () => {
    const supabase = installMockSupabase({
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
      clients: []
    });

    try {
      const req = createMockRequest({
        body: createPublicBookingIntakeSchema.parse({
          stylist_slug: "maya-johnson",
          full_name: "Jane Smith",
          phone: "(720) 555-0199",
          email: "jane@example.com"
        })
      });

      const response = await runWithErrorHandler((request, res) => publicController.createBookingIntake(request, res), req);

      assert.equal(response.statusCode, 200);
      assert.deepEqual(withBookingContextTokenPlaceholder(response.body as { data: { bookingContextToken: string } }), {
        data: {
          matchStatus: "not_found",
          clientFound: false,
          isExistingClient: false,
          bookingContextToken: "booking-context-token",
          bookingEnabled: true,
          client: {
            firstName: "Jane",
            lastName: "Smith",
            email: "jane@example.com",
            phoneMasked: "***-***-0199"
          },
          submittedContact: {
            fullName: "Jane Smith",
            phoneNormalized: "+17205550199",
            email: "jane@example.com"
          },
          recommendedService: null,
          bookingBehavior: {
            requiresApproval: true,
            restrictedToNewClientRules: true,
            canUseReturningClientRules: false,
            message: "New client appointments may require approval."
          }
        }
      });
    } finally {
      supabase.restore();
    }
  });

  it("returns ambiguous booking intake data for duplicate normalized phones under the same stylist", async () => {
    const supabase = installMockSupabase({
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
      clients: [
        {
          id: "client-1",
          user_id: userId,
          first_name: "Jane",
          last_name: "Smith",
          phone_normalized: "+17205550148"
        },
        {
          id: "client-2",
          user_id: userId,
          first_name: "Janet",
          last_name: "Smith",
          phone_normalized: "+17205550148"
        }
      ]
    });

    try {
      const req = createMockRequest({
        body: createPublicBookingIntakeSchema.parse({
          stylist_slug: "maya-johnson",
          full_name: "Jane Smith",
          phone: "(720) 555-0148",
          email: "jane@example.com"
        })
      });

      const response = await runWithErrorHandler((request, res) => publicController.createBookingIntake(request, res), req);

      assert.equal(response.statusCode, 200);
      assert.deepEqual(withBookingContextTokenPlaceholder(response.body as { data: { bookingContextToken: string } }), {
        data: {
          matchStatus: "ambiguous",
          clientFound: false,
          isExistingClient: false,
          bookingContextToken: "booking-context-token",
          bookingEnabled: true,
          candidateCount: 2,
          client: {
            firstName: "Jane",
            lastName: "Smith",
            email: "jane@example.com",
            phoneMasked: "***-***-0148"
          },
          submittedContact: {
            fullName: "Jane Smith",
            phoneNormalized: "+17205550148",
            email: "jane@example.com"
          },
          recommendedService: null,
          bookingBehavior: {
            requiresApproval: true,
            restrictedToNewClientRules: true,
            canUseReturningClientRules: false,
            message: "We need a little more information before confirming returning-client status."
          },
          nextStep: "collect_email_or_name"
        }
      });
    } finally {
      supabase.restore();
    }
  });

  it("scopes booking intake matches to the requested stylist only", async () => {
    const supabase = installMockSupabase({
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
      clients: [
        {
          id: "client-foreign",
          user_id: otherUserId,
          first_name: "Jane",
          last_name: "Smith",
          phone_normalized: "+17205550148"
        }
      ]
    });

    try {
      const req = createMockRequest({
        body: createPublicBookingIntakeSchema.parse({
          stylist_slug: "maya-johnson",
          full_name: "Jane Smith",
          phone: "(720) 555-0148",
          email: "jane@example.com"
        })
      });

      const response = await runWithErrorHandler((request, res) => publicController.createBookingIntake(request, res), req);

      assert.equal((response.body as { data: { matchStatus: string } }).data.matchStatus, "not_found");
    } finally {
      supabase.restore();
    }
  });

  it("falls back to email matching for booking intake when phone does not match", async () => {
    const supabase = installMockSupabase({
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
      clients: [
        {
          id: "client-1",
          user_id: userId,
          first_name: "Jane",
          last_name: "Smith",
          email: "jane@example.com",
          phone_normalized: "+17205550148"
        }
      ],
      appointments: []
    });

    try {
      const req = createMockRequest({
        body: createPublicBookingIntakeSchema.parse({
          stylist_slug: "maya-johnson",
          full_name: "Jane Smith",
          phone: "(720) 555-0199",
          email: "jane@example.com"
        })
      });

      const response = await runWithErrorHandler((request, res) => publicController.createBookingIntake(request, res), req);

      assert.equal((response.body as { data: { matchStatus: string } }).data.matchStatus, "matched");
    } finally {
      supabase.restore();
    }
  });

  it("does not recommend inactive or deleted services during booking intake", async () => {
    const supabase = installMockSupabase({
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
      clients: [
        {
          id: "client-1",
          user_id: userId,
          first_name: "Jane",
          last_name: "Smith",
          phone_normalized: "+17205550148"
        }
      ],
      appointments: [
        {
          id: "appt-1",
          user_id: userId,
          client_id: "client-1",
          appointment_date: "2026-05-01T10:00:00.000Z",
          duration_minutes: 60,
          service_name: "Retired Service",
          status: "completed"
        }
      ]
    });

    try {
      const req = createMockRequest({
        body: createPublicBookingIntakeSchema.parse({
          stylist_slug: "maya-johnson",
          full_name: "Jane Smith",
          phone: "(720) 555-0148",
          email: ""
        })
      });

      const response = await runWithErrorHandler((request, res) => publicController.createBookingIntake(request, res), req);

      assert.equal((response.body as { data: { recommendedService: unknown } }).data.recommendedService, null);
    } finally {
      supabase.restore();
    }
  });

  it("does not require approval previews for returning clients when new-client approval is disabled", async () => {
    const supabase = installMockSupabase({
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
      services: [
        {
          id: "service-1",
          user_id: userId,
          name: "Consultation",
          duration_minutes: 30,
          price: 0,
          is_active: true,
          is_default: true,
          sort_order: 1
        }
      ],
      clients: [
        {
          id: "client-1",
          user_id: userId,
          first_name: "Jane",
          last_name: "Smith",
          phone_normalized: "+17205550148"
        }
      ],
      appointments: []
    });

    try {
      const returningReq = createMockRequest({
        body: createPublicBookingIntakeSchema.parse({
          stylist_slug: "maya-johnson",
          full_name: "Jane Smith",
          phone: "(720) 555-0148",
          email: ""
        })
      });
      const returningResponse = await runWithErrorHandler(
        (request, res) => publicController.createBookingIntake(request, res),
        returningReq
      );

      assert.equal(
        (returningResponse.body as { data: { bookingBehavior: { requiresApproval: boolean } } }).data.bookingBehavior.requiresApproval,
        false
      );
    } finally {
      supabase.restore();
    }
  });

  it("lets the owner accept or reject a pending appointment with an explicit decision endpoint", async () => {
    const pendingAppointmentId = "88888888-8888-4888-8888-888888888888";
    const scheduledAppointmentId = "99999999-9999-4999-8999-999999999999";
    const clientId = "77777777-7777-4777-8777-777777777777";
    const supabase = installMockSupabase({
      clients: [
        {
          id: clientId,
          user_id: userId,
          first_name: "Jane",
          last_name: "Doe",
          email: "jane@example.com"
        }
      ],
      appointments: [
        {
          id: pendingAppointmentId,
          user_id: userId,
          client_id: clientId,
          appointment_date: "2026-05-05T10:00:00.000Z",
          duration_minutes: 60,
          service_name: "Silk Press",
          status: "pending"
        },
        {
          id: scheduledAppointmentId,
          user_id: userId,
          client_id: clientId,
          appointment_date: "2026-05-06T10:00:00.000Z",
          duration_minutes: 60,
          service_name: "Trim",
          status: "scheduled"
        }
      ]
    });

    try {
      const acceptReq = createMockRequest({
        user: { id: userId } as Request["user"],
        params: { id: pendingAppointmentId },
        body: pendingAppointmentDecisionSchema.parse({
          decision: "accept"
        })
      });

      const acceptResponse = await runWithErrorHandler(
        (request, res) => appointmentsController.applyPendingDecision(request, res),
        acceptReq
      );

      assert.equal(acceptResponse.statusCode, 200);
      assert.equal((acceptResponse.body as { data: { status: string } }).data.status, "scheduled");
      assert.equal(
        supabase.state.appointments.find((appointment) => appointment.id === pendingAppointmentId)?.status,
        "scheduled"
      );
      assert.equal(supabase.state.appointment_email_events.length, 1);
      assert.equal(supabase.state.appointment_email_events[0]?.email_type, "appointment_confirmed");
      assert.equal(supabase.state.appointment_email_events[0]?.recipient_email, "jane@example.com");
      assert.equal(
        supabase.state.appointment_email_events[0]?.idempotency_key,
        `appointment_confirmed:${pendingAppointmentId}`
      );

      const rejectReq = createMockRequest({
        user: { id: userId } as Request["user"],
        params: { id: scheduledAppointmentId },
        body: pendingAppointmentDecisionSchema.parse({
          decision: "reject"
        })
      });

      const rejectResponse = await runWithErrorHandler(
        (request, res) => appointmentsController.applyPendingDecision(request, res),
        rejectReq
      );

      assert.equal(rejectResponse.statusCode, 400);
      assert.deepEqual(rejectResponse.body, {
        error: {
          message: "Only pending appointments can be accepted or rejected",
          details: undefined
        }
      });
    } finally {
      supabase.restore();
    }
  });

  it("creates public bookings with a richer confirmation payload", async () => {
    const today = getCurrentLocalDate("UTC");
    const monday = getNextLocalDay(addDays(today, 1), 1);
    const requestedDateTime = zonedDateTimeToUtc(monday, "UTC", 9, 0, 0, 0).toISOString();
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "maya@example.com",
          business_name: "Maya Johnson Hair",
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
          lead_time_hours: 0,
          same_day_booking_allowed: true,
          same_day_booking_cutoff: "23:59:00",
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
          new_client_booking_window_days: 3650,
          restrict_services_for_new_clients: false,
          restricted_service_ids: []
        }
      ],
      services: [
        {
          id: ownedServiceId,
          user_id: userId,
          name: "Silk Press",
          duration_minutes: 60,
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
          day_of_week: 1,
          start_time: "09:00:00",
          end_time: "12:00:00",
          is_active: true
        }
      ],
      clients: [
        {
          id: "client-1",
          user_id: userId,
          first_name: "Jane",
          last_name: "Doe",
          email: "old-jane@example.com",
          phone: "720-555-0103",
          phone_normalized: "+17205550103"
        }
      ],
      appointments: []
    });

    try {
      const req = createMockRequest({
        body: createPublicBookingSchema.parse({
          stylist_slug: "maya-johnson",
          service_id: ownedServiceId,
          requested_datetime: requestedDateTime,
          guest_first_name: "Jane",
          guest_last_name: "Doe",
          guest_email: "jane@example.com",
          guest_phone: "(720) 555-0103",
          notes: "First available please"
        })
      });

      const response = await runWithErrorHandler((request, res) => publicController.createBooking(request, res), req);

      assert.equal(response.statusCode, 201);
      assert.deepEqual(response.body, {
        data: {
          appointment_id: supabase.state.appointments[0]?.id,
          client_id: "client-1",
          stylist_slug: "maya-johnson",
          stylist_display_name: "Maya Johnson",
          business_name: "Maya Johnson Hair",
          service_id: ownedServiceId,
          service_name: "Silk Press",
          service_duration_minutes: 60,
          service_price: 95,
          appointment_date: requestedDateTime,
          appointment_end: `${monday}T10:00:00+00:00`,
          business_timezone: "UTC",
          status: "scheduled"
        }
      });
      assert.equal(supabase.state.appointments.length, 1);
      assert.equal(supabase.state.appointments[0]?.client_id, "client-1");
      assert.equal(supabase.state.appointments[0]?.booking_source, "public");
      assert.equal(supabase.state.appointment_email_events.length, 1);
      assert.equal(supabase.state.appointment_email_events[0]?.email_type, "appointment_scheduled");
      assert.equal(supabase.state.appointment_email_events[0]?.recipient_email, "jane@example.com");
      assert.equal(supabase.state.clients[0]?.email, "old-jane@example.com");
      assert.equal(
        supabase.state.appointment_email_events[0]?.idempotency_key,
        `appointment_scheduled:${supabase.state.appointments[0]?.id}`
      );
      const templateData = supabase.state.appointment_email_events[0]?.template_data as Record<string, unknown>;
      assert.equal(templateData.business_display_name, "Maya Johnson Hair");
      assert.equal(templateData.business_name, "Maya Johnson Hair");
      assert.equal(templateData.stylist_display_name, "Maya Johnson");
      assert.equal(templateData.business_email, "maya@example.com");
      assert.equal(templateData.business_timezone, "UTC");
      assert.equal(templateData.appointment_start_time, requestedDateTime);
      assert.equal(templateData.appointment_end_time, `${monday}T10:00:00.000Z`);
      assert.equal(templateData.appointment_end_display, "10:00 AM UTC");
      assert.match(String(templateData.appointment_time_display), /Monday, .* at 9:00 AM UTC - 10:00 AM UTC/);
    } finally {
      supabase.restore();
    }
  });

  it("uses the submitted public booking email when an existing matched client has no stored email", async () => {
    const today = getCurrentLocalDate("UTC");
    const monday = getNextLocalDay(addDays(today, 1), 1);
    const requestedDateTime = zonedDateTimeToUtc(monday, "UTC", 9, 0, 0, 0).toISOString();
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "maya@example.com",
          business_name: "Maya Johnson Hair",
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
          lead_time_hours: 0,
          same_day_booking_allowed: true,
          same_day_booking_cutoff: "23:59:00",
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
          new_client_booking_window_days: 3650,
          restrict_services_for_new_clients: false,
          restricted_service_ids: []
        }
      ],
      services: [
        {
          id: ownedServiceId,
          user_id: userId,
          name: "Silk Press",
          duration_minutes: 60,
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
          day_of_week: 1,
          start_time: "09:00:00",
          end_time: "12:00:00",
          is_active: true
        }
      ],
      clients: [
        {
          id: "client-1",
          user_id: userId,
          first_name: "Jane",
          last_name: "Doe",
          email: "",
          phone: "720-555-0103",
          phone_normalized: "+17205550103"
        }
      ],
      appointments: [],
      appointment_email_events: []
    });

    try {
      const response = await runWithErrorHandler(
        (request, res) => publicController.createBooking(request, res),
        createMockRequest({
          body: createPublicBookingSchema.parse({
            stylist_slug: "maya-johnson",
            service_id: ownedServiceId,
            requested_datetime: requestedDateTime,
            guest_first_name: "Jane",
            guest_last_name: "Doe",
            guest_email: "jane@example.com",
            guest_phone: "(720) 555-0103"
          })
        })
      );

      assert.equal(response.statusCode, 201);
      assert.equal(supabase.state.clients[0]?.email, "jane@example.com");
      assert.equal(supabase.state.appointment_email_events.length, 1);
      assert.equal(supabase.state.appointment_email_events[0]?.recipient_email, "jane@example.com");
      assert.equal(supabase.state.appointment_email_events[0]?.email_type, "appointment_scheduled");
    } finally {
      supabase.restore();
    }
  });

  it("returns a public managed appointment from a valid management token", async () => {
    const appointmentId = "88888888-8888-4888-8888-888888888888";
    const clientId = "77777777-7777-4777-8777-777777777777";
    const appointmentStartTime = "2099-05-11T15:00:00.000Z";
    const token = createPublicAppointmentManagementToken({
      appointmentId,
      clientId,
      stylistId: userId,
      appointmentStartTime
    });
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "maya@example.com",
          business_name: "Maya Johnson Hair",
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
      clients: [
        {
          id: clientId,
          user_id: userId,
          first_name: "Jane",
          last_name: "Doe",
          email: "jane@example.com"
        }
      ],
      appointments: [
        {
          id: appointmentId,
          user_id: userId,
          client_id: clientId,
          appointment_date: appointmentStartTime,
          duration_minutes: 60,
          service_name: "Silk Press",
          price: 95,
          status: "scheduled"
        }
      ]
    });

    try {
      const req = createMockRequest({ params: { token } });
      const response = await runWithErrorHandler(
        (request, res) => publicController.getManagedAppointment(request, res),
        req
      );

      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.body, {
        data: {
          appointment_id: appointmentId,
          client_id: clientId,
          stylist_id: userId,
          stylist_slug: "maya-johnson",
          stylist_display_name: "Maya Johnson",
          business_name: "Maya Johnson Hair",
          client_name: "Jane Doe",
          service_name: "Silk Press",
          service_duration_minutes: 60,
          service_price: 95,
          appointment_date: appointmentStartTime,
          appointment_end: "2099-05-11T16:00:00+00:00",
          business_timezone: "UTC",
          status: "scheduled",
          can_cancel: true,
          can_reschedule: true
        }
      });
    } finally {
      supabase.restore();
    }
  });

  it("cancels a public managed appointment from a valid management token", async () => {
    const appointmentId = "88888888-8888-4888-8888-888888888888";
    const clientId = "77777777-7777-4777-8777-777777777777";
    const appointmentStartTime = "2099-05-11T15:00:00.000Z";
    const token = createPublicAppointmentManagementToken({
      appointmentId,
      clientId,
      stylistId: userId,
      appointmentStartTime
    });
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "maya@example.com",
          business_name: "Maya Johnson Hair",
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
      clients: [
        {
          id: clientId,
          user_id: userId,
          first_name: "Jane",
          last_name: "Doe",
          email: "jane@example.com"
        }
      ],
      appointments: [
        {
          id: appointmentId,
          user_id: userId,
          client_id: clientId,
          appointment_date: appointmentStartTime,
          duration_minutes: 60,
          service_name: "Silk Press",
          price: 95,
          status: "pending"
        }
      ],
      activity_events: []
    });

    try {
      const req = createMockRequest({ params: { token } });
      const response = await runWithErrorHandler(
        (request, res) => publicController.cancelManagedAppointment(request, res),
        req
      );

      assert.equal(response.statusCode, 200);
      assert.equal((response.body as { data: { status: string; can_cancel: boolean } }).data.status, "cancelled");
      assert.equal((response.body as { data: { status: string; can_cancel: boolean } }).data.can_cancel, false);
      assert.equal(supabase.state.appointments[0]?.status, "cancelled");
      assert.equal(supabase.state.activity_events[0]?.activity_type, "appointment_cancelled");
      assert.deepEqual(supabase.state.activity_events[0]?.metadata, {
        client_name: "Jane Doe",
        service_name: "Silk Press",
        appointment_start_time: appointmentStartTime,
        cancelled_by: "client"
      });
      assert.equal(supabase.state.appointment_email_events.length, 1);
      assert.equal(supabase.state.appointment_email_events[0]?.email_type, "appointment_cancelled");
      assert.equal(supabase.state.appointment_email_events[0]?.recipient_email, "jane@example.com");
      assert.equal(
        supabase.state.appointment_email_events[0]?.idempotency_key,
        `appointment_cancelled:${appointmentId}`
      );
      assert.equal(
        (supabase.state.appointment_email_events[0]?.template_data as { cancelled_by?: string } | undefined)?.cancelled_by,
        "client"
      );
      const templateData = supabase.state.appointment_email_events[0]?.template_data as Record<string, unknown>;
      assert.equal(templateData.business_display_name, "Maya Johnson Hair");
      assert.equal(templateData.appointment_start_time, appointmentStartTime);
      assert.equal(templateData.appointment_end_time, "2099-05-11T16:00:00.000Z");
      assert.match(String(templateData.appointment_time_display), /May 11, 2099 at 3:00 PM UTC - 4:00 PM UTC/);
    } finally {
      supabase.restore();
    }
  });

  it("rejects expired, mismatched, and cancelled public appointment management links", async () => {
    const appointmentId = "88888888-8888-4888-8888-888888888888";
    const clientId = "77777777-7777-4777-8777-777777777777";
    const appointmentStartTime = "2099-05-11T15:00:00.000Z";
    const validShapeWrongClientToken = createPublicAppointmentManagementToken({
      appointmentId,
      clientId: otherUserId,
      stylistId: userId,
      appointmentStartTime
    });
    const expiredToken = createPublicAppointmentManagementToken({
      appointmentId,
      clientId,
      stylistId: userId,
      appointmentStartTime: "2020-05-11T15:00:00.000Z"
    });
    const cancelledToken = createPublicAppointmentManagementToken({
      appointmentId,
      clientId,
      stylistId: userId,
      appointmentStartTime
    });
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "maya@example.com",
          business_name: "Maya Johnson Hair",
          timezone: "UTC"
        }
      ],
      clients: [
        {
          id: clientId,
          user_id: userId,
          first_name: "Jane",
          last_name: "Doe"
        }
      ],
      appointments: [
        {
          id: appointmentId,
          user_id: userId,
          client_id: clientId,
          appointment_date: appointmentStartTime,
          duration_minutes: 60,
          service_name: "Silk Press",
          price: 95,
          status: "cancelled"
        }
      ]
    });

    try {
      const expiredResponse = await runWithErrorHandler(
        (request, res) => publicController.getManagedAppointment(request, res),
        createMockRequest({ params: { token: expiredToken } })
      );
      assert.equal(expiredResponse.statusCode, 400);
      assert.deepEqual(expiredResponse.body, {
        error: {
          message: "Appointment management link is invalid or expired",
          details: undefined
        }
      });

      const mismatchResponse = await runWithErrorHandler(
        (request, res) => publicController.getManagedAppointment(request, res),
        createMockRequest({ params: { token: validShapeWrongClientToken } })
      );
      assert.equal(mismatchResponse.statusCode, 400);
      assert.deepEqual(mismatchResponse.body, {
        error: {
          message: "Appointment management link is invalid or expired",
          details: undefined
        }
      });

      const cancelledResponse = await runWithErrorHandler(
        (request, res) => publicController.getManagedAppointment(request, res),
        createMockRequest({ params: { token: cancelledToken } })
      );
      assert.equal(cancelledResponse.statusCode, 400);
      assert.deepEqual(cancelledResponse.body, {
        error: {
          message: "Appointment can no longer be managed",
          details: undefined
        }
      });
    } finally {
      supabase.restore();
    }
  });

  it("reschedules a pending public managed appointment and keeps it pending", async () => {
    const appointmentId = "88888888-8888-4888-8888-888888888888";
    const clientId = "77777777-7777-4777-8777-777777777777";
    const oldStartTime = "2099-05-11T15:00:00.000Z";
    const newDate = getNextLocalDay("2099-05-12", 1);
    const requestedDateTime = zonedDateTimeToUtc(newDate, "UTC", 10, 0, 0, 0).toISOString();
    const token = createPublicAppointmentManagementToken({
      appointmentId,
      clientId,
      stylistId: userId,
      appointmentStartTime: oldStartTime
    });
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "maya@example.com",
          business_name: "Maya Johnson Hair",
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
          lead_time_hours: 0,
          same_day_booking_allowed: true,
          same_day_booking_cutoff: "23:59:00",
          max_booking_window_days: 36500,
          cancellation_window_hours: 24,
          late_cancellation_fee_enabled: false,
          late_cancellation_fee_type: "flat",
          late_cancellation_fee_value: 0,
          allow_cancellation_after_cutoff: false,
          reschedule_window_hours: 0,
          max_reschedules: null,
          same_day_rescheduling_allowed: false,
          preserve_appointment_history: true,
          new_client_approval_required: true,
          new_client_booking_window_days: 36500,
          restrict_services_for_new_clients: false,
          restricted_service_ids: []
        }
      ],
      availability: [
        {
          id: "availability-1",
          user_id: userId,
          day_of_week: 1,
          start_time: "09:00:00",
          end_time: "12:00:00",
          client_audience: "all",
          is_active: true
        }
      ],
      clients: [
        {
          id: clientId,
          user_id: userId,
          first_name: "Jane",
          last_name: "Doe",
          email: "jane@example.com"
        }
      ],
      appointments: [
        {
          id: appointmentId,
          user_id: userId,
          client_id: clientId,
          appointment_date: oldStartTime,
          duration_minutes: 60,
          service_name: "Silk Press",
          price: 95,
          status: "pending"
        }
      ],
      activity_events: [],
      appointment_email_events: []
    });

    try {
      const response = await runWithErrorHandler(
        (request, res) => publicController.rescheduleManagedAppointment(request, res),
        createMockRequest({
          params: { token },
          body: { requested_datetime: requestedDateTime }
        })
      );

      assert.equal(response.statusCode, 200);
      assert.equal((response.body as { data: { status: string } }).data.status, "pending");
      assert.equal(supabase.state.appointments[0]?.appointment_date, requestedDateTime);
      assert.equal(supabase.state.appointments[0]?.status, "pending");
      assert.equal(supabase.state.activity_events[0]?.activity_type, "appointment_rescheduled");
      assert.equal(supabase.state.appointment_email_events[0]?.email_type, "appointment_rescheduled");
      assert.equal(
        supabase.state.appointment_email_events[0]?.idempotency_key,
        `appointment_rescheduled:${appointmentId}:${requestedDateTime}`
      );
      assert.equal(
        (supabase.state.appointment_email_events[0]?.template_data as { status?: string } | undefined)?.status,
        "pending"
      );
    } finally {
      supabase.restore();
    }
  });

  it("moves a scheduled first appointment back to pending when current rules require new-client approval", async () => {
    const appointmentId = "88888888-8888-4888-8888-888888888888";
    const clientId = "77777777-7777-4777-8777-777777777777";
    const oldStartTime = "2099-05-11T15:00:00.000Z";
    const newDate = getNextLocalDay("2099-05-12", 1);
    const requestedDateTime = zonedDateTimeToUtc(newDate, "UTC", 10, 0, 0, 0).toISOString();
    const token = createPublicAppointmentManagementToken({
      appointmentId,
      clientId,
      stylistId: userId,
      appointmentStartTime: oldStartTime
    });
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "maya@example.com",
          business_name: "Maya Johnson Hair",
          timezone: "UTC"
        }
      ],
      booking_rules: [
        {
          id: "rules-1",
          user_id: userId,
          lead_time_hours: 0,
          same_day_booking_allowed: true,
          same_day_booking_cutoff: "23:59:00",
          max_booking_window_days: 36500,
          cancellation_window_hours: 24,
          late_cancellation_fee_enabled: false,
          late_cancellation_fee_type: "flat",
          late_cancellation_fee_value: 0,
          allow_cancellation_after_cutoff: false,
          reschedule_window_hours: 0,
          max_reschedules: null,
          same_day_rescheduling_allowed: false,
          preserve_appointment_history: true,
          new_client_approval_required: true,
          new_client_booking_window_days: 36500,
          restrict_services_for_new_clients: false,
          restricted_service_ids: []
        }
      ],
      availability: [
        {
          id: "availability-1",
          user_id: userId,
          day_of_week: 1,
          start_time: "09:00:00",
          end_time: "12:00:00",
          client_audience: "all",
          is_active: true
        }
      ],
      clients: [
        {
          id: clientId,
          user_id: userId,
          first_name: "Jane",
          last_name: "Doe",
          email: "jane@example.com"
        }
      ],
      appointments: [
        {
          id: appointmentId,
          user_id: userId,
          client_id: clientId,
          appointment_date: oldStartTime,
          duration_minutes: 60,
          service_name: "Silk Press",
          price: 95,
          status: "scheduled"
        }
      ],
      appointment_email_events: []
    });

    try {
      const response = await runWithErrorHandler(
        (request, res) => publicController.rescheduleManagedAppointment(request, res),
        createMockRequest({
          params: { token },
          body: { requested_datetime: requestedDateTime }
        })
      );

      assert.equal(response.statusCode, 200);
      assert.equal((response.body as { data: { status: string } }).data.status, "pending");
      assert.equal(supabase.state.appointments[0]?.status, "pending");
      assert.equal(
        (supabase.state.appointment_email_events[0]?.template_data as { status?: string } | undefined)?.status,
        "pending"
      );
    } finally {
      supabase.restore();
    }
  });

  it("keeps a completed client's rescheduled appointment scheduled even when new-client approval is enabled", async () => {
    const appointmentId = "88888888-8888-4888-8888-888888888888";
    const completedAppointmentId = "99999999-9999-4999-8999-999999999999";
    const clientId = "77777777-7777-4777-8777-777777777777";
    const oldStartTime = "2099-05-11T15:00:00.000Z";
    const newDate = getNextLocalDay("2099-05-12", 1);
    const requestedDateTime = zonedDateTimeToUtc(newDate, "UTC", 10, 0, 0, 0).toISOString();
    const token = createPublicAppointmentManagementToken({
      appointmentId,
      clientId,
      stylistId: userId,
      appointmentStartTime: oldStartTime
    });
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "maya@example.com",
          business_name: "Maya Johnson Hair",
          timezone: "UTC"
        }
      ],
      booking_rules: [
        {
          id: "rules-1",
          user_id: userId,
          lead_time_hours: 0,
          same_day_booking_allowed: true,
          same_day_booking_cutoff: "23:59:00",
          max_booking_window_days: 36500,
          cancellation_window_hours: 24,
          late_cancellation_fee_enabled: false,
          late_cancellation_fee_type: "flat",
          late_cancellation_fee_value: 0,
          allow_cancellation_after_cutoff: false,
          reschedule_window_hours: 0,
          max_reschedules: null,
          same_day_rescheduling_allowed: false,
          preserve_appointment_history: true,
          new_client_approval_required: true,
          new_client_booking_window_days: 36500,
          restrict_services_for_new_clients: false,
          restricted_service_ids: []
        }
      ],
      availability: [
        {
          id: "availability-1",
          user_id: userId,
          day_of_week: 1,
          start_time: "09:00:00",
          end_time: "12:00:00",
          client_audience: "all",
          is_active: true
        }
      ],
      clients: [
        {
          id: clientId,
          user_id: userId,
          first_name: "Jane",
          last_name: "Doe",
          email: "jane@example.com"
        }
      ],
      appointments: [
        {
          id: completedAppointmentId,
          user_id: userId,
          client_id: clientId,
          appointment_date: "2026-05-01T15:00:00.000Z",
          duration_minutes: 60,
          service_name: "Trim",
          price: 65,
          status: "completed"
        },
        {
          id: appointmentId,
          user_id: userId,
          client_id: clientId,
          appointment_date: oldStartTime,
          duration_minutes: 60,
          service_name: "Silk Press",
          price: 95,
          status: "scheduled"
        }
      ],
      appointment_email_events: []
    });

    try {
      const response = await runWithErrorHandler(
        (request, res) => publicController.rescheduleManagedAppointment(request, res),
        createMockRequest({
          params: { token },
          body: { requested_datetime: requestedDateTime }
        })
      );

      assert.equal(response.statusCode, 200);
      assert.equal((response.body as { data: { status: string } }).data.status, "scheduled");
      assert.equal(
        supabase.state.appointments.find((appointment) => appointment.id === appointmentId)?.status,
        "scheduled"
      );
      assert.equal(
        (supabase.state.appointment_email_events[0]?.template_data as { status?: string } | undefined)?.status,
        "scheduled"
      );
    } finally {
      supabase.restore();
    }
  });

  it("rejects a public managed appointment reschedule when the requested time is unavailable", async () => {
    const appointmentId = "88888888-8888-4888-8888-888888888888";
    const clientId = "77777777-7777-4777-8777-777777777777";
    const oldStartTime = "2099-05-11T15:00:00.000Z";
    const newDate = getNextLocalDay("2099-05-12", 1);
    const requestedDateTime = zonedDateTimeToUtc(newDate, "UTC", 14, 0, 0, 0).toISOString();
    const token = createPublicAppointmentManagementToken({
      appointmentId,
      clientId,
      stylistId: userId,
      appointmentStartTime: oldStartTime
    });
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "maya@example.com",
          business_name: "Maya Johnson Hair",
          timezone: "UTC"
        }
      ],
      booking_rules: [
        {
          id: "rules-1",
          user_id: userId,
          lead_time_hours: 0,
          same_day_booking_allowed: true,
          same_day_booking_cutoff: "23:59:00",
          max_booking_window_days: 36500,
          cancellation_window_hours: 24,
          late_cancellation_fee_enabled: false,
          late_cancellation_fee_type: "flat",
          late_cancellation_fee_value: 0,
          allow_cancellation_after_cutoff: false,
          reschedule_window_hours: 0,
          max_reschedules: null,
          same_day_rescheduling_allowed: false,
          preserve_appointment_history: true,
          new_client_approval_required: false,
          new_client_booking_window_days: 36500,
          restrict_services_for_new_clients: false,
          restricted_service_ids: []
        }
      ],
      availability: [
        {
          id: "availability-1",
          user_id: userId,
          day_of_week: 1,
          start_time: "09:00:00",
          end_time: "12:00:00",
          client_audience: "all",
          is_active: true
        }
      ],
      clients: [
        {
          id: clientId,
          user_id: userId,
          first_name: "Jane",
          last_name: "Doe",
          email: "jane@example.com"
        }
      ],
      appointments: [
        {
          id: appointmentId,
          user_id: userId,
          client_id: clientId,
          appointment_date: oldStartTime,
          duration_minutes: 60,
          service_name: "Silk Press",
          price: 95,
          status: "scheduled"
        }
      ],
      appointment_email_events: []
    });

    try {
      const response = await runWithErrorHandler(
        (request, res) => publicController.rescheduleManagedAppointment(request, res),
        createMockRequest({
          params: { token },
          body: { requested_datetime: requestedDateTime }
        })
      );

      assert.equal(response.statusCode, 409);
      assert.deepEqual(response.body, {
        error: {
          message: "Requested time is no longer available",
          details: undefined
        }
      });
      assert.equal(supabase.state.appointments[0]?.appointment_date, oldStartTime);
      assert.equal(supabase.state.appointment_email_events.length, 0);
    } finally {
      supabase.restore();
    }
  });

  it("normalizes a public booking request to the business timezone when the submitted offset is stale", async () => {
    const sunday = getNextLocalDay("2030-05-01", 0);
    const canonicalRequestedDateTime = zonedDateTimeToUtc(sunday, "America/Denver", 15, 30, 0, 0).toISOString();
    const submittedRequestedDateTime = `${sunday}T15:30:00-07:00`;
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "maya@example.com",
          business_name: "Maya Johnson Hair",
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
          max_booking_window_days: 3650,
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
          new_client_booking_window_days: 3650,
          restrict_services_for_new_clients: false,
          restricted_service_ids: []
        }
      ],
      services: [
        {
          id: ownedServiceId,
          user_id: userId,
          name: "Silk Press",
          duration_minutes: 60,
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
          start_time: "15:00:00",
          end_time: "17:00:00",
          is_active: true
        }
      ],
      clients: []
    });

    try {
      const req = createMockRequest({
        body: createPublicBookingSchema.parse({
          stylist_slug: "maya-johnson",
          service_id: ownedServiceId,
          requested_datetime: submittedRequestedDateTime,
          guest_first_name: "Jane",
          guest_last_name: "Doe",
          guest_email: "jane@example.com",
          guest_phone: "720-555-0103"
        })
      });

      const response = await runWithErrorHandler((request, res) => publicController.createBooking(request, res), req);

      assert.equal(response.statusCode, 201);
      assert.equal(supabase.state.appointments[0]?.appointment_date, canonicalRequestedDateTime);
      assert.deepEqual(response.body, {
        data: {
          appointment_id: supabase.state.appointments[0]?.id,
          client_id: supabase.state.clients[0]?.id,
          stylist_slug: "maya-johnson",
          stylist_display_name: "Maya Johnson",
          business_name: "Maya Johnson Hair",
          service_id: ownedServiceId,
          service_name: "Silk Press",
          service_duration_minutes: 60,
          service_price: 95,
          appointment_date: canonicalRequestedDateTime,
          appointment_end: `${sunday}T16:30:00-06:00`,
          business_timezone: "America/Denver",
          status: "scheduled"
        }
      });
    } finally {
      supabase.restore();
    }
  });

  it("treats a repeated public booking submission for the same slot as idempotent", async () => {
    const today = getCurrentLocalDate("UTC");
    const monday = getNextLocalDay(addDays(today, 1), 1);
    const requestedDateTime = zonedDateTimeToUtc(monday, "UTC", 9, 0, 0, 0).toISOString();
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "maya@example.com",
          business_name: "Maya Johnson Hair",
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
          lead_time_hours: 0,
          same_day_booking_allowed: true,
          same_day_booking_cutoff: "23:59:00",
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
          new_client_booking_window_days: 90,
          restrict_services_for_new_clients: false,
          restricted_service_ids: []
        }
      ],
      services: [
        {
          id: ownedServiceId,
          user_id: userId,
          name: "Silk Press",
          duration_minutes: 60,
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
          day_of_week: 1,
          start_time: "09:00:00",
          end_time: "12:00:00",
          is_active: true
        }
      ],
      clients: [],
      appointments: []
    });

    try {
      const bookingBody = createPublicBookingSchema.parse({
        stylist_slug: "maya-johnson",
        service_id: ownedServiceId,
        requested_datetime: requestedDateTime,
        guest_first_name: "Jane",
        guest_last_name: "Doe",
        guest_email: "jane@example.com",
        guest_phone: "720-555-0103",
        notes: "Please keep volume."
      });

      const firstReq = createMockRequest({ body: bookingBody });
      const firstResponse = await runWithErrorHandler((request, res) => publicController.createBooking(request, res), firstReq);

      assert.equal(firstResponse.statusCode, 201);
      assert.equal(supabase.state.appointments.length, 1);

      const secondReq = createMockRequest({ body: bookingBody });
      const secondResponse = await runWithErrorHandler((request, res) => publicController.createBooking(request, res), secondReq);

      assert.equal(secondResponse.statusCode, 201);
      assert.deepEqual(secondResponse.body, firstResponse.body);
      assert.equal(supabase.state.appointments.length, 1);
    } finally {
      supabase.restore();
    }
  });

  it("treats a repeated pending public booking submission as idempotent", async () => {
    const today = getCurrentLocalDate("UTC");
    const monday = getNextLocalDay(addDays(today, 1), 1);
    const requestedDateTime = zonedDateTimeToUtc(monday, "UTC", 9, 0, 0, 0).toISOString();
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "maya@example.com",
          business_name: "Maya Johnson Hair",
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
          lead_time_hours: 0,
          same_day_booking_allowed: true,
          same_day_booking_cutoff: "23:59:00",
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
          new_client_booking_window_days: 90,
          restrict_services_for_new_clients: false,
          restricted_service_ids: []
        }
      ],
      services: [
        {
          id: ownedServiceId,
          user_id: userId,
          name: "Silk Press",
          duration_minutes: 60,
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
          day_of_week: 1,
          start_time: "09:00:00",
          end_time: "12:00:00",
          is_active: true
        }
      ],
      clients: [],
      appointments: []
    });

    try {
      const bookingBody = createPublicBookingSchema.parse({
        stylist_slug: "maya-johnson",
        service_id: ownedServiceId,
        requested_datetime: requestedDateTime,
        guest_first_name: "Jane",
        guest_last_name: "Doe",
        guest_email: "jane@example.com",
        guest_phone: "720-555-0103",
        notes: "Please keep volume."
      });

      const firstReq = createMockRequest({ body: bookingBody });
      const firstResponse = await runWithErrorHandler((request, res) => publicController.createBooking(request, res), firstReq);

      assert.equal(firstResponse.statusCode, 201);
      assert.equal((supabase.state.appointments[0]?.status as string | undefined), "pending");

      const secondReq = createMockRequest({ body: bookingBody });
      const secondResponse = await runWithErrorHandler((request, res) => publicController.createBooking(request, res), secondReq);

      assert.equal(secondResponse.statusCode, 201);
      assert.deepEqual(secondResponse.body, firstResponse.body);
      assert.equal(supabase.state.appointments.length, 1);
    } finally {
      supabase.restore();
    }
  });

  it("still rejects a public booking when another client already took the slot", async () => {
    const today = getCurrentLocalDate("UTC");
    const monday = getNextLocalDay(addDays(today, 1), 1);
    const requestedDateTime = zonedDateTimeToUtc(monday, "UTC", 9, 0, 0, 0).toISOString();
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "maya@example.com",
          business_name: "Maya Johnson Hair",
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
          lead_time_hours: 0,
          same_day_booking_allowed: true,
          same_day_booking_cutoff: "23:59:00",
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
          new_client_booking_window_days: 90,
          restrict_services_for_new_clients: false,
          restricted_service_ids: []
        }
      ],
      services: [
        {
          id: ownedServiceId,
          user_id: userId,
          name: "Silk Press",
          duration_minutes: 60,
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
          day_of_week: 1,
          start_time: "09:00:00",
          end_time: "12:00:00",
          is_active: true
        }
      ],
      clients: [],
      appointments: []
    });

    try {
      const firstReq = createMockRequest({
        body: createPublicBookingSchema.parse({
          stylist_slug: "maya-johnson",
          service_id: ownedServiceId,
          requested_datetime: requestedDateTime,
          guest_first_name: "Jane",
          guest_last_name: "Doe",
          guest_email: "jane@example.com",
          guest_phone: "720-555-0103",
          notes: "Please keep volume."
        })
      });
      const firstResponse = await runWithErrorHandler((request, res) => publicController.createBooking(request, res), firstReq);

      assert.equal(firstResponse.statusCode, 201);
      assert.equal(supabase.state.appointments.length, 1);

      const secondReq = createMockRequest({
        body: createPublicBookingSchema.parse({
          stylist_slug: "maya-johnson",
          service_id: ownedServiceId,
          requested_datetime: requestedDateTime,
          guest_first_name: "Janet",
          guest_last_name: "Smith",
          guest_email: "janet@example.com",
          guest_phone: "720-555-0199",
          notes: "Please keep volume."
        })
      });
      const secondResponse = await runWithErrorHandler((request, res) => publicController.createBooking(request, res), secondReq);

      assert.equal(secondResponse.statusCode, 409);
      assert.deepEqual(secondResponse.body, {
        error: {
          message: "Requested time is no longer available",
          details: undefined
        }
      });
      assert.equal(supabase.state.appointments.length, 1);
    } finally {
      supabase.restore();
    }
  });

  it("returns a conflict when a submitted public booking no longer fits current availability", async () => {
    const today = getCurrentLocalDate("UTC");
    const monday = getNextLocalDay(addDays(today, 1), 1);
    const requestedDateTime = zonedDateTimeToUtc(monday, "UTC", 12, 0, 0, 0).toISOString();
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "maya@example.com",
          business_name: "Maya Johnson Hair",
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
          lead_time_hours: 0,
          same_day_booking_allowed: true,
          same_day_booking_cutoff: "23:59:00",
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
          new_client_booking_window_days: 90,
          restrict_services_for_new_clients: false,
          restricted_service_ids: []
        }
      ],
      services: [
        {
          id: ownedServiceId,
          user_id: userId,
          name: "Silk Press",
          duration_minutes: 60,
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
          day_of_week: 1,
          start_time: "09:00:00",
          end_time: "12:00:00",
          is_active: true
        }
      ],
      clients: [],
      appointments: []
    });

    try {
      const req = createMockRequest({
        body: createPublicBookingSchema.parse({
          stylist_slug: "maya-johnson",
          service_id: ownedServiceId,
          requested_datetime: requestedDateTime,
          guest_first_name: "Jane",
          guest_last_name: "Doe",
          guest_email: "jane@example.com",
          guest_phone: "720-555-0103",
          notes: "Please keep volume."
        })
      });

      const response = await runWithErrorHandler((request, res) => publicController.createBooking(request, res), req);

      assert.equal(response.statusCode, 409);
      assert.deepEqual(response.body, {
        error: {
          message: "Requested time is no longer available",
          details: undefined
        }
      });
      assert.equal(supabase.state.appointments.length, 0);
    } finally {
      supabase.restore();
    }
  });

  it("matches final public bookings by normalized phone when stored and submitted formats differ", async () => {
    const today = getCurrentLocalDate("UTC");
    const monday = getNextLocalDay(addDays(today, 1), 1);
    const requestedDateTime = zonedDateTimeToUtc(monday, "UTC", 11, 0, 0, 0).toISOString();
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "maya@example.com",
          business_name: "Maya Johnson Hair",
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
          lead_time_hours: 0,
          same_day_booking_allowed: true,
          same_day_booking_cutoff: "23:59:00",
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
          new_client_booking_window_days: 90,
          restrict_services_for_new_clients: false,
          restricted_service_ids: []
        }
      ],
      services: [
        {
          id: ownedServiceId,
          user_id: userId,
          name: "Silk Press",
          duration_minutes: 60,
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
          day_of_week: 1,
          start_time: "09:00:00",
          end_time: "15:00:00",
          is_active: true
        }
      ],
      clients: [
        {
          id: "client-1",
          user_id: userId,
          first_name: "Jane",
          last_name: "Doe",
          email: "another@example.com",
          phone: "7205550104",
          phone_normalized: "+17205550104"
        }
      ],
      appointments: []
    });

    try {
      const req = createMockRequest({
        body: createPublicBookingSchema.parse({
          stylist_slug: "maya-johnson",
          service_id: ownedServiceId,
          requested_datetime: requestedDateTime,
          guest_first_name: "Jane",
          guest_last_name: "Doe",
          guest_email: "jane@example.com",
          guest_phone: "(720) 555-0104"
        })
      });

      const response = await runWithErrorHandler((request, res) => publicController.createBooking(request, res), req);

      assert.equal(response.statusCode, 201);
      assert.equal(supabase.state.appointments[0]?.client_id, "client-1");
      assert.equal(supabase.state.clients.length, 1);
    } finally {
      supabase.restore();
    }
  });

  it("returns Basic entitlements by default when plan fields are missing", async () => {
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "owner@example.com"
        }
      ]
    });

    try {
      const req = createMockRequest({ user: { id: userId } as Request["user"] });
      const response = await runWithErrorHandler((request, res) => accountController.getPlan(request, res), req);
      const plan = (response.body as { data: Record<string, unknown> }).data;

      assert.equal(response.statusCode, 200);
      assert.equal(plan.tier, "basic");
      assert.equal(plan.status, "active");
      assert.equal(plan.displayName, "Basic");
      assert.equal(plan.smsMonthlyLimit, 0);
      assert.equal(plan.smsUsedThisMonth, 0);
      assert.equal(plan.smsRemainingThisMonth, 0);
      assert.deepEqual(plan.features, {
        bookingPage: true,
        crm: true,
        emailReminders: true,
        smsReminders: false,
        waitlist: false,
        customCoverPhoto: false,
        customSlug: false,
        googleCalendarSync: false,
        weeklyBusinessRecap: false,
        clientExport: false
      });
    } finally {
      supabase.restore();
    }
  });

  it("returns Pro entitlements with the expected feature set", async () => {
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "owner@example.com",
          plan_tier: "pro",
          plan_status: "active",
          sms_monthly_limit: 100,
          sms_used_this_month: 12
        }
      ]
    });

    try {
      const req = createMockRequest({ user: { id: userId } as Request["user"] });
      const response = await runWithErrorHandler((request, res) => accountController.getPlan(request, res), req);
      const plan = (response.body as { data: Record<string, unknown> }).data;

      assert.equal(plan.tier, "pro");
      assert.equal(plan.smsMonthlyLimit, 100);
      assert.equal(plan.smsRemainingThisMonth, 88);
      assert.deepEqual(plan.features, {
        bookingPage: true,
        crm: true,
        emailReminders: true,
        smsReminders: true,
        waitlist: true,
        customCoverPhoto: true,
        customSlug: false,
        googleCalendarSync: false,
        weeklyBusinessRecap: false,
        clientExport: false
      });
    } finally {
      supabase.restore();
    }
  });

  it("returns Premium entitlements with the expected feature set", async () => {
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "owner@example.com",
          plan_tier: "premium",
          plan_status: "trialing",
          sms_monthly_limit: 300,
          sms_used_this_month: 25
        }
      ]
    });

    try {
      const req = createMockRequest({ user: { id: userId } as Request["user"] });
      const response = await runWithErrorHandler((request, res) => accountController.getPlan(request, res), req);
      const plan = (response.body as { data: Record<string, unknown> }).data;

      assert.equal(plan.tier, "premium");
      assert.equal(plan.status, "trialing");
      assert.equal(plan.smsMonthlyLimit, 300);
      assert.equal(plan.smsRemainingThisMonth, 275);
      assert.deepEqual(plan.features, {
        bookingPage: true,
        crm: true,
        emailReminders: true,
        smsReminders: true,
        waitlist: true,
        customCoverPhoto: true,
        customSlug: true,
        googleCalendarSync: true,
        weeklyBusinessRecap: true,
        clientExport: true
      });
    } finally {
      supabase.restore();
    }
  });

  it("updates the current user's plan and sms limit through the account plan endpoint", async () => {
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "owner@example.com",
          plan_tier: "basic",
          plan_status: "active",
          sms_monthly_limit: 0,
          sms_used_this_month: 0
        }
      ]
    });

    try {
      const req = createMockRequest({
        user: { id: userId } as Request["user"],
        body: updateAccountPlanSchema.parse({
          tier: "pro",
          status: "past_due"
        })
      });
      const response = await runWithErrorHandler((request, res) => accountController.updatePlan(request, res), req);
      const plan = (response.body as { data: Record<string, unknown> }).data;

      assert.equal(response.statusCode, 200);
      assert.equal(plan.tier, "pro");
      assert.equal(plan.status, "past_due");
      assert.equal(plan.smsMonthlyLimit, 100);
      assert.equal(supabase.state.users[0]?.plan_tier, "pro");
      assert.equal(supabase.state.users[0]?.plan_status, "past_due");
      assert.equal(supabase.state.users[0]?.sms_monthly_limit, 100);
      assert.equal(typeof supabase.state.users[0]?.plan_updated_at, "string");
    } finally {
      supabase.restore();
    }
  });

  it("blocks Basic from updating booking cover photos", async () => {
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "owner@example.com",
          plan_tier: "basic",
          plan_status: "active"
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
      ]
    });

    try {
      const req = createMockRequest({
        user: { id: userId } as Request["user"],
        body: updateBookingSettingsSchema.parse({
          cover_photo_url: "https://example.com/new-cover.jpg"
        })
      });
      const response = await runWithErrorHandler((request, res) => settingsController.updateBooking(request, res), req);

      assert.equal(response.statusCode, 403);
      assert.equal((response.body as { error: { message: string } }).error.message, "This feature is not available for the current plan.");
    } finally {
      supabase.restore();
    }
  });

  it("allows Pro to update booking cover photos", async () => {
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "owner@example.com",
          plan_tier: "pro",
          plan_status: "active"
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
      ]
    });

    try {
      const req = createMockRequest({
        user: { id: userId } as Request["user"],
        body: updateBookingSettingsSchema.parse({
          cover_photo_url: "https://example.com/new-cover.jpg"
        })
      });
      const response = await runWithErrorHandler((request, res) => settingsController.updateBooking(request, res), req);

      assert.equal(response.statusCode, 200);
      assert.equal((response.body as { data: { cover_photo_url: string } }).data.cover_photo_url, "https://example.com/new-cover.jpg");
    } finally {
      supabase.restore();
    }
  });

  it("blocks Pro from changing a custom booking slug", async () => {
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "owner@example.com",
          plan_tier: "pro",
          plan_status: "active"
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
      ]
    });

    try {
      const req = createMockRequest({
        user: { id: userId } as Request["user"],
        body: updateBookingSettingsSchema.parse({
          slug: "maya-color-studio"
        })
      });
      const response = await runWithErrorHandler((request, res) => settingsController.updateBooking(request, res), req);

      assert.equal(response.statusCode, 403);
    } finally {
      supabase.restore();
    }
  });

  it("allows Premium to change a custom booking slug", async () => {
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "owner@example.com",
          plan_tier: "premium",
          plan_status: "active"
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
      ]
    });

    try {
      const req = createMockRequest({
        user: { id: userId } as Request["user"],
        body: updateBookingSettingsSchema.parse({
          slug: "maya-color-studio"
        })
      });
      const response = await runWithErrorHandler((request, res) => settingsController.updateBooking(request, res), req);

      assert.equal(response.statusCode, 200);
      assert.equal((response.body as { data: { slug: string } }).data.slug, "maya-color-studio");
    } finally {
      supabase.restore();
    }
  });

  it("bootstraps missing user and booking settings rows for a new authenticated user", async () => {
    const supabase = installMockSupabase({
      users: [],
      stylists: []
    });

    try {
      const req = createMockRequest({
        user: {
          id: userId,
          email: "new.stylist@example.com"
        } as Request["user"],
        body: updateBookingSettingsSchema.parse({
          booking_enabled: true
        })
      });
      const response = await runWithErrorHandler((request, res) => settingsController.updateBooking(request, res), req);

      assert.equal(response.statusCode, 200);
      assert.equal((response.body as { data: { booking_enabled: boolean } }).data.booking_enabled, true);
      assert.equal(supabase.state.users.length, 1);
      assert.equal(supabase.state.stylists.length, 1);
      assert.equal(supabase.state.users[0]?.email, "new.stylist@example.com");
      assert.equal((supabase.state.stylists[0]?.slug as string).length > 0, true);
      assert.equal((supabase.state.stylists[0]?.display_name as string).length > 0, true);
    } finally {
      supabase.restore();
    }
  });

  it("bootstraps missing user and booking rules rows for a new authenticated user", async () => {
    const supabase = installMockSupabase({
      users: [],
      booking_rules: []
    });

    try {
      const req = createMockRequest({
        user: {
          id: userId,
          email: "new.rules@example.com"
        } as Request["user"],
        body: updateBookingRulesSchema.parse({
          newClientBookingWindowDays: 0
        })
      });
      const response = await runWithErrorHandler((request, res) => settingsController.updateBookingRules(request, res), req);

      assert.equal(response.statusCode, 200);
      assert.equal(supabase.state.users.length, 1);
      assert.equal(supabase.state.booking_rules.length, 1);
      assert.equal(
        (response.body as { data: { newClientBookingWindowDays: number } }).data.newClientBookingWindowDays,
        0
      );
    } finally {
      supabase.restore();
    }
  });

  it("returns bootstrapped booking settings for a new authenticated user", async () => {
    const supabase = installMockSupabase({
      users: [],
      stylists: []
    });

    try {
      const req = createMockRequest({
        user: {
          id: userId,
          email: "fresh-booking@example.com"
        } as Request["user"]
      });
      const response = await runWithErrorHandler((request, res) => settingsController.getBooking(request, res), req);

      assert.equal(response.statusCode, 200);
      assert.equal(supabase.state.users.length, 1);
      assert.equal(supabase.state.stylists.length, 1);
      assert.equal(
        (response.body as { data: { booking_enabled: boolean } }).data.booking_enabled,
        false
      );
    } finally {
      supabase.restore();
    }
  });

  it("blocks Basic from using SMS entitlements", async () => {
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "owner@example.com",
          plan_tier: "basic",
          plan_status: "active",
          sms_monthly_limit: 0,
          sms_used_this_month: 0
        }
      ]
    });

    try {
      await assert.rejects(
        () => entitlementsService.assertSmsAvailable(userId),
        (error: unknown) => (error as { message?: string }).message === "SMS limit reached for current plan."
      );
    } finally {
      supabase.restore();
    }
  });

  it("blocks over-limit Pro or Premium SMS usage", async () => {
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "owner@example.com",
          plan_tier: "pro",
          plan_status: "active",
          sms_monthly_limit: 100,
          sms_used_this_month: 100
        }
      ]
    });

    try {
      await assert.rejects(
        () => entitlementsService.assertSmsAvailable(userId),
        (error: unknown) => (error as { message?: string }).message === "SMS limit reached for current plan."
      );
    } finally {
      supabase.restore();
    }
  });

  it("returns default-safe profile overview sections when configuration is sparse", async () => {
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "owner@example.com",
          timezone: "UTC"
        }
      ],
      stylists: [],
      booking_rules: [],
      services: [],
      availability: [],
      appointments: []
    });

    try {
      const req = createMockRequest({ user: { id: userId } as Request["user"] });
      const response = await runWithErrorHandler((request, res) => profileController.getOverview(request, res), req);

      assert.equal(response.statusCode, 200);
      const overview = (response.body as {
        data: {
          profile: { displayName: string };
          availability: unknown[];
          availabilitySettings: { days: unknown[] };
          services: unknown[];
          messagingSettings: unknown[];
          settingsSummary: { services: { badge: string } };
        };
      }).data;
      assert.equal(overview.profile.displayName, "owner@example.com");
      assert.deepEqual(overview.availability, []);
      assert.equal(overview.availabilitySettings.days.length, 7);
      assert.deepEqual(overview.services, []);
      assert.deepEqual(overview.messagingSettings, []);
      assert.equal(overview.settingsSummary.services.badge, "0 services");
      assert.equal(supabase.state.booking_rules.length, 1);
    } finally {
      supabase.restore();
    }
  });

  it("accepts newClientBookingWindowDays = 0 in booking rules updates", async () => {
    const supabase = installMockSupabase({
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
      ]
    });

    try {
      const req = createMockRequest({
        user: { id: userId } as Request["user"],
        body: updateBookingRulesSchema.parse({
          newClientBookingWindowDays: 0
        })
      });
      const response = await runWithErrorHandler((request, res) => settingsController.updateBookingRules(request, res), req);

      assert.equal(response.statusCode, 200);
      assert.equal(
        (response.body as { data: { newClientBookingWindowDays: number } }).data.newClientBookingWindowDays,
        0
      );
      assert.equal(supabase.state.booking_rules[0]?.new_client_booking_window_days, 0);
    } finally {
      supabase.restore();
    }
  });

  it("updates editable profile display fields without allowing tier changes through profile settings", async () => {
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "maya@example.com",
          full_name: "Maya Johnson",
          business_name: "Maya Johnson Hair",
          plan_tier: "pro",
          plan_status: "active",
          location_label: "Old Location",
          avatar_image_id: "old-avatar",
          timezone: "UTC"
        }
      ]
    });

    try {
      const req = createMockRequest({
        user: { id: userId } as Request["user"],
        body: updateProfileSchema.parse({
          location_label: "Denver, CO",
          avatar_image_id: "avatar-456",
          plan_tier: "premium"
        })
      });
      const response = await runWithErrorHandler((request, res) => settingsController.updateProfile(request, res), req);
      const profile = (response.body as { data: Record<string, unknown> }).data;

      assert.equal(response.statusCode, 200);
      assert.equal(profile.location_label, "Denver, CO");
      assert.equal(profile.avatar_image_id, "avatar-456");
      assert.equal(profile.plan_tier, "pro");
      assert.equal(supabase.state.users[0]?.location_label, "Denver, CO");
      assert.equal(supabase.state.users[0]?.avatar_image_id, "avatar-456");
      assert.equal(supabase.state.users[0]?.plan_tier, "pro");
    } finally {
      supabase.restore();
    }
  });

  it("returns normalized weekly availability settings for the authenticated user", async () => {
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "owner@example.com",
          timezone: "America/Denver"
        }
      ],
      availability: [
        {
          id: "a1",
          user_id: userId,
          day_of_week: 1,
          start_time: "09:00:00",
          end_time: "12:00:00",
          is_active: true,
          client_audience: "all"
        },
        {
          id: "a2",
          user_id: userId,
          day_of_week: 1,
          start_time: "13:00:00",
          end_time: "17:00:00",
          is_active: true,
          client_audience: "returning"
        },
        {
          id: "a3",
          user_id: userId,
          day_of_week: 6,
          start_time: "10:00:00",
          end_time: "14:00:00",
          is_active: true,
          client_audience: "new"
        }
      ]
    });

    try {
      const req = createMockRequest({ user: { id: userId } as Request["user"] });
      const response = await runWithErrorHandler((request, res) => settingsController.getAvailability(request, res), req);

      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.body, {
        data: {
          timezone: "America/Denver",
          days: [
            { dayOfWeek: 0, isOpen: false, windows: [] },
            {
              dayOfWeek: 1,
              isOpen: true,
              windows: [
                { startTime: "09:00", endTime: "12:00", clientAudience: "all" },
                { startTime: "13:00", endTime: "17:00", clientAudience: "returning" }
              ]
            },
            { dayOfWeek: 2, isOpen: false, windows: [] },
            { dayOfWeek: 3, isOpen: false, windows: [] },
            { dayOfWeek: 4, isOpen: false, windows: [] },
            { dayOfWeek: 5, isOpen: false, windows: [] },
            {
              dayOfWeek: 6,
              isOpen: true,
              windows: [{ startTime: "10:00", endTime: "14:00", clientAudience: "new" }]
            }
          ]
        }
      });
    } finally {
      supabase.restore();
    }
  });

  it("replaces weekly availability settings with a full-week payload", async () => {
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "owner@example.com",
          timezone: "America/Chicago"
        }
      ],
      availability: [
        { id: "a1", user_id: userId, day_of_week: 1, start_time: "09:00:00", end_time: "17:00:00", is_active: true },
        { id: "a2", user_id: userId, day_of_week: 2, start_time: "09:00:00", end_time: "17:00:00", is_active: true }
      ]
    });

    try {
      const payload = {
        days: [
          { dayOfWeek: 0, isOpen: false, windows: [] },
          {
            dayOfWeek: 1,
            isOpen: true,
            windows: [
              { startTime: "08:30", endTime: "12:00" },
              { startTime: "12:00", endTime: "15:00", clientAudience: "returning" }
            ]
          },
          { dayOfWeek: 2, isOpen: true, windows: [{ startTime: "09:00", endTime: "17:00", clientAudience: "new" }] },
          { dayOfWeek: 3, isOpen: true, windows: [{ startTime: "11:00", endTime: "18:00" }] },
          { dayOfWeek: 4, isOpen: false, windows: [] },
          { dayOfWeek: 5, isOpen: true, windows: [{ startTime: "10:00", endTime: "15:00", clientAudience: "returning" }] },
          { dayOfWeek: 6, isOpen: false, windows: [] }
        ]
      };

      const validationResponse = await runValidation(createMockRequest({ body: payload }), {
        body: replaceAvailabilitySchema
      });
      assert.equal(validationResponse, null);

      const req = createMockRequest({
        user: { id: userId } as Request["user"],
        body: payload
      });
      const response = await runWithErrorHandler((request, res) => settingsController.replaceAvailability(request, res), req);

      assert.equal(response.statusCode, 200);
      assert.deepEqual((response.body as { data: { timezone: string } }).data.timezone, "America/Chicago");
      assert.deepEqual(
        supabase.state.availability
          .filter((row) => row.user_id === userId)
          .map((row) => ({
            day_of_week: row.day_of_week,
            start_time: row.start_time,
            end_time: row.end_time,
            is_active: row.is_active,
            client_audience: row.client_audience
          }))
          .sort((left, right) =>
            Number(left.day_of_week) - Number(right.day_of_week) ||
            String(left.start_time).localeCompare(String(right.start_time)) ||
            String(left.client_audience).localeCompare(String(right.client_audience))
          ),
        [
          { day_of_week: 1, start_time: "08:30", end_time: "12:00", is_active: true, client_audience: "all" },
          { day_of_week: 1, start_time: "12:00", end_time: "15:00", is_active: true, client_audience: "returning" },
          { day_of_week: 2, start_time: "09:00", end_time: "17:00", is_active: true, client_audience: "new" },
          { day_of_week: 3, start_time: "11:00", end_time: "18:00", is_active: true, client_audience: "all" },
          { day_of_week: 5, start_time: "10:00", end_time: "15:00", is_active: true, client_audience: "returning" }
        ]
      );
    } finally {
      supabase.restore();
    }
  });

  it("rejects overlapping availability windows during replacement", async () => {
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "owner@example.com",
          timezone: "UTC"
        }
      ],
      availability: []
    });

    try {
      const req = createMockRequest({
        user: { id: userId } as Request["user"],
        body: {
          days: [
            { dayOfWeek: 0, isOpen: false, windows: [] },
            {
              dayOfWeek: 1,
              isOpen: true,
              windows: [
                { startTime: "09:00", endTime: "12:00" },
                { startTime: "11:30", endTime: "14:00" }
              ]
            },
            { dayOfWeek: 2, isOpen: false, windows: [] },
            { dayOfWeek: 3, isOpen: false, windows: [] },
            { dayOfWeek: 4, isOpen: false, windows: [] },
            { dayOfWeek: 5, isOpen: false, windows: [] },
            { dayOfWeek: 6, isOpen: false, windows: [] }
          ]
        }
      });
      const response = await runWithErrorHandler((request, res) => settingsController.replaceAvailability(request, res), req);

      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.body, {
        error: {
          message: "Availability windows cannot overlap for day 1 and audience all",
          details: undefined
        }
      });
    } finally {
      supabase.restore();
    }
  });

  it("allows overlapping availability windows during replacement when audiences differ", async () => {
    const supabase = installMockSupabase({
      users: [
        {
          id: userId,
          email: "owner@example.com",
          timezone: "UTC"
        }
      ],
      availability: []
    });

    try {
      const req = createMockRequest({
        user: { id: userId } as Request["user"],
        body: {
          days: [
            { dayOfWeek: 0, isOpen: false, windows: [] },
            {
              dayOfWeek: 1,
              isOpen: true,
              windows: [
                { startTime: "09:00", endTime: "12:00", clientAudience: "new" },
                { startTime: "09:00", endTime: "12:00", clientAudience: "returning" }
              ]
            },
            { dayOfWeek: 2, isOpen: false, windows: [] },
            { dayOfWeek: 3, isOpen: false, windows: [] },
            { dayOfWeek: 4, isOpen: false, windows: [] },
            { dayOfWeek: 5, isOpen: false, windows: [] },
            { dayOfWeek: 6, isOpen: false, windows: [] }
          ]
        }
      });
      const response = await runWithErrorHandler((request, res) => settingsController.replaceAvailability(request, res), req);

      assert.equal(response.statusCode, 200);
      assert.deepEqual(
        supabase.state.availability
          .filter((row) => row.user_id === userId)
          .map((row) => ({
            day_of_week: row.day_of_week,
            start_time: row.start_time,
            end_time: row.end_time,
            client_audience: row.client_audience
          }))
          .sort((left, right) => String(left.client_audience).localeCompare(String(right.client_audience))),
        [
          { day_of_week: 1, start_time: "09:00", end_time: "12:00", client_audience: "new" },
          { day_of_week: 1, start_time: "09:00", end_time: "12:00", client_audience: "returning" }
        ]
      );
    } finally {
      supabase.restore();
    }
  });
});
