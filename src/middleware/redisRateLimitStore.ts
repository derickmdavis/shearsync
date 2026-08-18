import type { IncrementResponse, Store } from "express-rate-limit";
import type { RedisClientType } from "redis";

interface RedisRateLimitStoreOptions {
  getClient: () => Promise<RedisClientType>;
  prefix: string;
  windowMs: number;
}

const asNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }

  return null;
};

/**
 * A shared express-rate-limit store backed by Railway Redis. The increment and
 * expiry operations run in one Redis transaction, so every API instance
 * observes the same counter and a restart does not clear limits.
 */
export class RedisRateLimitStore implements Store {
  readonly localKeys = false;

  private readonly getClient: () => Promise<RedisClientType>;
  private readonly keyPrefix: string;
  private readonly windowMs: number;

  constructor({ getClient, prefix, windowMs }: RedisRateLimitStoreOptions) {
    this.getClient = getClient;
    this.keyPrefix = prefix;
    this.windowMs = windowMs;
  }

  async increment(key: string): Promise<IncrementResponse> {
    const fullKey = this.withPrefix(key);
    const client = await this.getClient();
    const replies = await client
      .multi()
      .incr(fullKey)
      .pExpire(fullKey, this.windowMs, "NX")
      .pTTL(fullKey)
      .exec();
    const totalHits = asNumber(replies[0]);
    const ttl = asNumber(replies[2]);

    if (totalHits === null || totalHits < 1 || ttl === null) {
      throw new Error("Rate-limit Redis returned an invalid counter response");
    }

    return {
      totalHits,
      resetTime: new Date(Date.now() + (ttl > 0 ? ttl : this.windowMs))
    };
  }

  async decrement(key: string): Promise<void> {
    const client = await this.getClient();
    await client.decr(this.withPrefix(key));
  }

  async resetKey(key: string): Promise<void> {
    const client = await this.getClient();
    await client.del(this.withPrefix(key));
  }

  private withPrefix(key: string): string {
    return `${this.keyPrefix}${key}`;
  }
}
