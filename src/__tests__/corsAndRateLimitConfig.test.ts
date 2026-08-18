import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = process.env.AUTH_MODE ?? "production";
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key";

const { parseEnv } = require("../config/env") as typeof import("../config/env");
const { isCorsOriginAllowed } = require("../app") as typeof import("../app");

const requiredEnvironment = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  AUTH_MODE: "production",
  NODE_ENV: "production"
};

describe("production CORS and rate-limit configuration", () => {
  it("requires an explicit browser-origin allowlist in production", () => {
    assert.throws(
      () => parseEnv({ ...requiredEnvironment }),
      /CLIENT_APP_URL or WEB_APP_URL is required/
    );
  });

  it("requires Redis REST credentials in production", () => {
    assert.throws(
      () => parseEnv({ ...requiredEnvironment, CLIENT_APP_URL: "https://app.example.com" }),
      /RATE_LIMIT_REDIS_REST_URL and RATE_LIMIT_REDIS_REST_TOKEN are required/
    );
  });

  it("requires both Redis REST configuration values when either is set", () => {
    assert.throws(
      () =>
        parseEnv({
          ...requiredEnvironment,
          CLIENT_APP_URL: "https://app.example.com",
          RATE_LIMIT_REDIS_REST_URL: "https://rate-limit.example.com"
        }),
      /must be configured together/
    );
  });

  it("rejects unknown browser origins in production", () => {
    assert.equal(
      isCorsOriginAllowed({
        origin: "https://untrusted.example.com",
        origins: ["https://app.example.com"],
        nodeEnv: "production"
      }),
      false
    );
    assert.equal(
      isCorsOriginAllowed({
        origin: "https://app.example.com",
        origins: ["https://app.example.com"],
        nodeEnv: "production"
      }),
      true
    );
  });
});
