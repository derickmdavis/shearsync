import assert from "node:assert/strict";
import type { Server } from "node:http";
import { describe, it } from "node:test";

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = process.env.AUTH_MODE ?? "production";
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key";

const { app } = require("../app") as typeof import("../app");
const { env } = require("../config/env") as typeof import("../config/env");

const listen = (): Promise<Server> => new Promise((resolve) => {
  const server = app.listen(0, "127.0.0.1", () => resolve(server));
});
const close = (server: Server): Promise<void> => new Promise((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve());
});

describe("internal SMS appointment-reminder scheduler", () => {
  it("requires the internal secret and returns zero work while the feature is disabled", async () => {
    const previous = { secret: env.INTERNAL_API_SECRET, enabled: env.SMS_APPOINTMENT_REMINDERS_ENABLED };
    const server = await listen();
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    try {
      env.INTERNAL_API_SECRET = "test-internal-secret-value";
      env.SMS_APPOINTMENT_REMINDERS_ENABLED = false;
      const denied = await fetch(`${baseUrl}/internal/sms/appointment-reminders/process`, { method: "POST" });
      assert.equal(denied.status, 401);

      const response = await fetch(`${baseUrl}/internal/sms/appointment-reminders/process?limit=25`, {
        method: "POST", headers: { "x-internal-api-secret": env.INTERNAL_API_SECRET }
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { data: { considered: 0, queued: 0, skipped: 0, errors: 0 } });
    } finally {
      env.INTERNAL_API_SECRET = previous.secret;
      env.SMS_APPOINTMENT_REMINDERS_ENABLED = previous.enabled;
      await close(server);
    }
  });
});
