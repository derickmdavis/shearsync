import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { RedisRestRateLimitStore } from "../middleware/redisRateLimitStore";

describe("RedisRestRateLimitStore", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it("increments a shared counter and sets its expiry only on the first hit", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      assert.equal(String(input), "https://redis.example.com/multi-exec");
      assert.equal(init?.headers && (init.headers as Record<string, string>).Authorization, "Bearer secret");
      assert.deepEqual(JSON.parse(String(init?.body)), [
        ["INCR", "shearsync:rate-limit:availability:203.0.113.10"],
        ["PEXPIRE", "shearsync:rate-limit:availability:203.0.113.10", 60_000, "NX"],
        ["PTTL", "shearsync:rate-limit:availability:203.0.113.10"]
      ]);

      return new Response(JSON.stringify([{ result: 2 }, { result: 0 }, { result: 42_000 }]), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    const store = new RedisRestRateLimitStore({
      url: "https://redis.example.com/",
      token: "secret",
      prefix: "shearsync:rate-limit:",
      windowMs: 60_000
    });

    const result = await store.increment("availability:203.0.113.10");

    assert.equal(fetchMock.mock.callCount(), 1);
    assert.equal(result.totalHits, 2);
    assert.ok(result.resetTime);
    assert.ok(result.resetTime.getTime() > Date.now());
  });
});
