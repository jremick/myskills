export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface AuthRateLimiter {
  consume(key: string, now?: Date): RateLimitResult;
}

export class MemoryAuthRateLimiter implements AuthRateLimiter {
  private buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly options: { maxAttempts: number; windowMs: number }) {}

  consume(key: string, now = new Date()): RateLimitResult {
    const currentTime = now.getTime();
    const existing = this.buckets.get(key);
    if (!existing || existing.resetAt <= currentTime) {
      this.buckets.set(key, {
        count: 1,
        resetAt: currentTime + this.options.windowMs,
      });
      return { allowed: true, retryAfterSeconds: 0 };
    }

    if (existing.count >= this.options.maxAttempts) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - currentTime) / 1000)),
      };
    }

    existing.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
