import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = process.env.AUTH_MODE ?? "production";
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key";
process.env.SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET ?? "test-public-appointment-management-secret";

const {
  createPublicAppointmentManagementToken,
  resolvePublicAppointmentManagementToken
} =
  require("../lib/publicAppointmentManagement") as typeof import("../lib/publicAppointmentManagement");
const { ApiError } = require("../lib/errors") as typeof import("../lib/errors");

describe("public appointment management tokens", () => {
  it("round-trips appointment management context until the appointment start time", () => {
    const context = {
      appointmentId: "11111111-1111-4111-8111-111111111111",
      clientId: "22222222-2222-4222-8222-222222222222",
      stylistId: "33333333-3333-4333-8333-333333333333",
      appointmentStartTime: "2099-05-08T16:00:00.000Z"
    };

    const token = createPublicAppointmentManagementToken(context);

    assert.deepEqual(resolvePublicAppointmentManagementToken(token), context);
  });

  it("rejects missing, expired, or malformed appointment management tokens", () => {
    assert.throws(
      () => resolvePublicAppointmentManagementToken(undefined),
      (error) => error instanceof ApiError && error.statusCode === 400
    );

    const expiredToken = createPublicAppointmentManagementToken({
      appointmentId: "11111111-1111-4111-8111-111111111111",
      clientId: "22222222-2222-4222-8222-222222222222",
      stylistId: "33333333-3333-4333-8333-333333333333",
      appointmentStartTime: "2020-05-08T16:00:00.000Z"
    });

    assert.throws(
      () => resolvePublicAppointmentManagementToken(expiredToken),
      (error) => error instanceof ApiError && error.statusCode === 400
    );

    assert.throws(
      () => resolvePublicAppointmentManagementToken("not-a-token"),
      (error) => error instanceof ApiError && error.statusCode === 400
    );
  });
});
