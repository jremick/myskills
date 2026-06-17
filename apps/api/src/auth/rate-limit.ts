export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface AuthRateLimiter {
  consume(key: string, now?: Date): RateLimitResult | Promise<RateLimitResult>;
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

export interface QueryablePool {
  query<T extends { attempt_count: number; reset_at: Date | string }>(
    query: string,
    values: unknown[],
  ): Promise<{ rows: T[] }>;
}

export class PostgresAuthRateLimiter implements AuthRateLimiter {
  constructor(
    private readonly pool: QueryablePool,
    private readonly options: { maxAttempts: number; windowMs: number },
  ) {}

  async consume(key: string, now = new Date()): Promise<RateLimitResult> {
    const resetAt = new Date(now.getTime() + this.options.windowMs);
    const result = await this.pool.query<{
      attempt_count: number;
      reset_at: Date | string;
    }>(`
      INSERT INTO auth_rate_limits (bucket_key, attempt_count, reset_at, updated_at)
      VALUES ($1, 1, $2, $3)
      ON CONFLICT (bucket_key) DO UPDATE SET
        attempt_count = CASE
          WHEN auth_rate_limits.reset_at <= $3 THEN 1
          ELSE auth_rate_limits.attempt_count + 1
        END,
        reset_at = CASE
          WHEN auth_rate_limits.reset_at <= $3 THEN $2
          ELSE auth_rate_limits.reset_at
        END,
        updated_at = $3
      RETURNING attempt_count, reset_at
    `, [key, resetAt, now]);

    const row = result.rows[0];
    if (!row) {
      throw new Error("Auth rate limit update failed.");
    }
    const rowResetAt = row.reset_at instanceof Date ? row.reset_at : new Date(row.reset_at);
    if (row.attempt_count > this.options.maxAttempts) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((rowResetAt.getTime() - now.getTime()) / 1000)),
      };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
