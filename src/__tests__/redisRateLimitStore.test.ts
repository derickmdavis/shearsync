import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RedisClientType } from "redis";
import { RedisRateLimitStore } from "../middleware/redisRateLimitStore";

describe("RedisRateLimitStore", () => {
  it("increments a shared counter and sets its expiry only on the first hit", async () => {
    const commands: Array<Array<string | number>> = [];
    const transaction = {
      incr(key: string) {
        commands.push(["INCR", key]);
        return transaction;
      },
      pExpire(key: string, windowMs: number, mode: string) {
        commands.push(["PEXPIRE", key, windowMs, mode]);
        return transaction;
      },
      pTTL(key: string) {
        commands.push(["PTTL", key]);
        return transaction;
      },
      async exec() {
        return [2, 0, 42_000];
      }
    };
    const client = {
      multi: () => transaction
    } as unknown as RedisClientType;
    const store = new RedisRateLimitStore({
      getClient: async () => client,
      prefix: "shearsync:rate-limit:",
      windowMs: 60_000
    });

    const result = await store.increment("availability:203.0.113.10");

    assert.deepEqual(commands, [
      ["INCR", "shearsync:rate-limit:availability:203.0.113.10"],
      ["PEXPIRE", "shearsync:rate-limit:availability:203.0.113.10", 60_000, "NX"],
      ["PTTL", "shearsync:rate-limit:availability:203.0.113.10"]
    ]);
    assert.equal(result.totalHits, 2);
    assert.ok(result.resetTime);
    assert.ok(result.resetTime.getTime() > Date.now());
  });
});
