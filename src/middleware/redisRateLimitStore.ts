import type { IncrementResponse, Store } from "express-rate-limit";

interface RedisRestRateLimitStoreOptions {
  url: string;
  token: string;
  prefix: string;
  windowMs: number;
}

type RedisPipelineReply = {
  result?: unknown;
  error?: string;
};

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
 * A shared express-rate-limit store for Redis REST gateways such as Upstash.
 *
 * The increment and expiry operations are sent as one Redis transaction, so
 * every API instance observes the same counter and a restart does not clear
 * limits.
 */
export class RedisRestRateLimitStore implements Store {
  readonly localKeys = false;

  private readonly url: string;
  private readonly token: string;
  private readonly keyPrefix: string;
  private readonly windowMs: number;

  constructor({ url, token, prefix, windowMs }: RedisRestRateLimitStoreOptions) {
    this.url = url.replace(/\/$/, "");
    this.token = token;
    this.keyPrefix = prefix;
    this.windowMs = windowMs;
  }

  async increment(key: string): Promise<IncrementResponse> {
    const fullKey = this.withPrefix(key);
    const replies = await this.transaction([
      ["INCR", fullKey],
      ["PEXPIRE", fullKey, this.windowMs, "NX"],
      ["PTTL", fullKey]
    ]);
    const totalHits = asNumber(replies[0]);
    const ttl = asNumber(replies[2]);

    if (totalHits === null || totalHits < 1 || ttl === null) {
      throw new Error("Rate-limit Redis gateway returned an invalid counter response");
    }

    return {
      totalHits,
      resetTime: new Date(Date.now() + (ttl > 0 ? ttl : this.windowMs))
    };
  }

  async decrement(key: string): Promise<void> {
    await this.transaction([["DECR", this.withPrefix(key)]]);
  }

  async resetKey(key: string): Promise<void> {
    await this.transaction([["DEL", this.withPrefix(key)]]);
  }

  private withPrefix(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  private async transaction(commands: Array<Array<string | number>>): Promise<unknown[]> {
    const response = await fetch(`${this.url}/multi-exec`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(commands)
    });

    if (!response.ok) {
      throw new Error(`Rate-limit Redis gateway request failed with status ${response.status}`);
    }

    const payload = await response.json();

    if (!Array.isArray(payload)) {
      throw new Error("Rate-limit Redis gateway returned an invalid transaction response");
    }

    return payload.map((reply) => {
      if (!reply || typeof reply !== "object") {
        throw new Error("Rate-limit Redis gateway returned an invalid transaction reply");
      }

      const { result, error } = reply as RedisPipelineReply;

      if (error) {
        throw new Error("Rate-limit Redis gateway rejected a transaction command");
      }

      return result;
    });
  }
}
