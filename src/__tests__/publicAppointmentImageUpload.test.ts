import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = process.env.AUTH_MODE ?? "production";
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key";
process.env.SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET ?? "test-public-appointment-image-upload-secret";

const {
  createPublicAppointmentImageUploadToken,
  getPublicAppointmentImageUploadExpiresAt,
  resolvePublicAppointmentImageUploadToken
} =
  require("../lib/publicAppointmentImageUpload") as typeof import("../lib/publicAppointmentImageUpload");
const { ApiError } = require("../lib/errors") as typeof import("../lib/errors");

describe("public appointment image upload tokens", () => {
  it("round-trips reference photo upload context until the appointment start time", () => {
    const context = {
      appointmentId: "11111111-1111-4111-8111-111111111111",
      clientId: "22222222-2222-4222-8222-222222222222",
      stylistId: "33333333-3333-4333-8333-333333333333",
      appointmentStartTime: "2099-05-08T16:00:00.000Z",
      tokenId: "44444444-4444-4444-8444-444444444444"
    };

    const token = createPublicAppointmentImageUploadToken(context);

    assert.deepEqual(resolvePublicAppointmentImageUploadToken(token), context);
    assert.equal(getPublicAppointmentImageUploadExpiresAt(context.appointmentStartTime), context.appointmentStartTime);
  });

  it("rejects missing, expired, or malformed reference photo upload tokens", () => {
    assert.throws(
      () => resolvePublicAppointmentImageUploadToken(undefined),
      (error) => error instanceof ApiError && error.statusCode === 400
    );

    const expiredToken = createPublicAppointmentImageUploadToken({
      appointmentId: "11111111-1111-4111-8111-111111111111",
      clientId: "22222222-2222-4222-8222-222222222222",
      stylistId: "33333333-3333-4333-8333-333333333333",
      appointmentStartTime: "2020-05-08T16:00:00.000Z"
    });

    assert.throws(
      () => resolvePublicAppointmentImageUploadToken(expiredToken),
      (error) => error instanceof ApiError && error.statusCode === 400
    );

    assert.throws(
      () => resolvePublicAppointmentImageUploadToken("not-a-token"),
      (error) => error instanceof ApiError && error.statusCode === 400
    );
  });
});
