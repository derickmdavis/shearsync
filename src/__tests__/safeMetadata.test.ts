import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = process.env.AUTH_MODE ?? "production";
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "service-role-key";

const { getAppEnvironment } = require("../config/env") as typeof import("../config/env");
const { sanitizeMetadata } = require("../lib/safeMetadata") as typeof import("../lib/safeMetadata");

describe("safe metadata", () => {
  it("uses APP_ENV before NODE_ENV and normalizes unknown values", () => {
    assert.equal(getAppEnvironment({ NODE_ENV: "production", APP_ENV: "staging" } as NodeJS.ProcessEnv), "staging");
    assert.equal(getAppEnvironment({ NODE_ENV: "test" } as NodeJS.ProcessEnv), "test");
    assert.equal(getAppEnvironment({ NODE_ENV: "preview" } as NodeJS.ProcessEnv), "development");
  });

  it("redacts sensitive keys and obvious sensitive string values", () => {
    const sanitized = sanitizeMetadata({
      email: "stylist@example.com",
      phone: "303-555-1212",
      nested: {
        signedUrl: "https://example.supabase.co/object/sign/file.png?token=secret",
        payment_url: "https://venmo.com/example",
        note: "Customer wrote jane@example.com from 10.1.2.3 with Bearer abc.def"
      }
    });

    assert.equal(sanitized.email, "[redacted]");
    assert.equal(sanitized.phone, "[redacted]");
    assert.deepEqual(sanitized.nested, {
      signedUrl: "[redacted]",
      payment_url: "[redacted]",
      note: "Customer wrote [redacted] from [redacted] with [redacted]"
    });
  });

  it("preserves safe status values, identifiers, counts, and provider names", () => {
    const sanitized = sanitizeMetadata({
      status: "completed",
      appointment_id: "11111111-1111-4111-8111-111111111111",
      provider: "venmo",
      count: 3,
      has_payment_url: true,
      duration_ms: 42
    });

    assert.deepEqual(sanitized, {
      status: "completed",
      appointment_id: "11111111-1111-4111-8111-111111111111",
      provider: "venmo",
      count: 3,
      has_payment_url: true,
      duration_ms: 42
    });
  });

  it("bounds nested metadata, arrays, strings, and circular references", () => {
    const circular: Record<string, unknown> = { ok: true };
    circular.self = circular;

    const sanitized = sanitizeMetadata({
      deep: { a: { b: { c: { d: { e: "too deep" } } } } },
      list: Array.from({ length: 30 }, (_, index) => index),
      long: "x".repeat(700),
      circular
    });

    const list = sanitized.list as unknown[];
    assert.equal(list.length, 20);
    assert.equal((sanitized.long as string).length, 503);
    assert.deepEqual(sanitized.deep, { a: { b: { c: { d: "[max-depth]" } } } });
    assert.deepEqual(sanitized.circular, { ok: true, self: "[circular]" });
  });
});
