export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface AuthRateLimiter {
  consume(key: string, now?: Date): RateLimitResult | Promise<RateLimitResult>;
}

export class MemoryAuthRateLimiter implements AuthRateLimiter {
  private buckets = new Map<string, { count: number; resetAt: number }>();
  private cleanupCursor = this.buckets.entries();

  constructor(private readonly options: { maxAttempts: number; windowMs: number; maxBuckets?: number }) {}

  consume(key: string, now = new Date()): RateLimitResult {
    const currentTime = now.getTime();
    // Bound both cleanup work and retained identities. Never evict a live
    // bucket: rotating keys must not reset an existing caller's attempt limit.
    for (let visited = 0; visited < 16; visited += 1) {
      const entry = this.cleanupCursor.next();
      if (entry.done) {
        this.cleanupCursor = this.buckets.entries();
        break;
      }
      if (entry.value[1].resetAt <= currentTime) this.buckets.delete(entry.value[0]);
    }
    const existing = this.buckets.get(key);
    if (!existing || existing.resetAt <= currentTime) {
      if (!existing && this.buckets.size >= (this.options.maxBuckets ?? 100_000)) {
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(this.options.windowMs / 1000)) };
      }
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
  private consumeCount = 0;

  constructor(
    private readonly pool: QueryablePool,
    private readonly options: {
      maxAttempts: number;
      windowMs: number;
      cleanupEvery?: number;
      cleanupBatchSize?: number;
    },
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
    this.consumeCount += 1;
    const cleanupEvery = Math.max(1, this.options.cleanupEvery ?? 256);
    if (this.consumeCount % cleanupEvery === 0) {
      void this.cleanupExpiredBuckets(now).catch(() => {
        // Expired-bucket retention is best effort and must not fail an otherwise valid request.
      });
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

  async cleanupExpiredBuckets(now = new Date()): Promise<void> {
    const batchSize = Math.min(Math.max(this.options.cleanupBatchSize ?? 1_000, 1), 10_000);
    await this.pool.query(`
      DELETE FROM auth_rate_limits
      WHERE bucket_key IN (
        SELECT bucket_key
        FROM auth_rate_limits
        WHERE reset_at <= $1
        ORDER BY reset_at
        LIMIT $2
      )
    `, [now, batchSize]);
  }
}
