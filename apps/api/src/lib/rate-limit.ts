import { Redis } from 'ioredis';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

export interface RateLimiter {
  /** Fixed-window counter. Fails OPEN on backend errors for availability, but logs via caller. */
  hit(key: string, limit: number, windowSec: number): Promise<RateLimitResult>;
  close(): Promise<void>;
}

export class MemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  async hit(key: string, limit: number, windowSec: number): Promise<RateLimitResult> {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowSec * 1000 };
      this.buckets.set(key, b);
      if (this.buckets.size > 50_000) this.sweep(now);
    }
    b.count += 1;
    return {
      allowed: b.count <= limit,
      remaining: Math.max(0, limit - b.count),
      retryAfterSec: Math.max(1, Math.ceil((b.resetAt - now) / 1000)),
    };
  }

  private sweep(now: number) {
    for (const [k, v] of this.buckets) if (v.resetAt <= now) this.buckets.delete(k);
  }

  async close() {
    this.buckets.clear();
  }
}

export class RedisRateLimiter implements RateLimiter {
  private readonly redis: Redis;
  constructor(url: string) {
    this.redis = new Redis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
    this.redis.on('error', () => undefined); // connection errors surface via hit() fail-open below
  }

  async hit(key: string, limit: number, windowSec: number): Promise<RateLimitResult> {
    const k = `rl:${key}`;
    try {
      const res = await this.redis.multi().incr(k).ttl(k).exec();
      const count = Number(res?.[0]?.[1] ?? 1);
      let ttl = Number(res?.[1]?.[1] ?? -1);
      if (ttl < 0) {
        await this.redis.expire(k, windowSec);
        ttl = windowSec;
      }
      return {
        allowed: count <= limit,
        remaining: Math.max(0, limit - count),
        retryAfterSec: Math.max(1, ttl),
      };
    } catch {
      return { allowed: true, remaining: limit, retryAfterSec: 1 };
    }
  }

  async close() {
    this.redis.disconnect();
  }
}
