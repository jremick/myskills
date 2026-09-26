import type { LibraryService } from "./service.js";

/**
 * Scheduled source checks. Due work is claimed with a Postgres lease
 * (FOR UPDATE SKIP LOCKED), so several API processes can run this worker.
 * Provider I/O never holds a database transaction; results are fenced by
 * the lease id. Nothing is scheduled in process memory beyond the poll timer.
 */
export class LibrarySourceWorker {
  private current: Promise<number> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(
    private readonly service: LibraryService,
    private readonly options: { pollMs?: number; batchSize?: number; onError?: (error: unknown) => void } = {},
  ) {}

  runOnce(): Promise<number> {
    if (this.current) return this.current;
    this.current = (async () => {
      const checked = await this.service.runDueChecks(Math.min(Math.max(this.options.batchSize ?? 5, 1), 25));
      await this.service.purgeExpired();
      return checked;
    })().finally(() => {
      this.current = undefined;
    });
    return this.current;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.service.setWorkerRunning(true);
    const poll = async () => {
      try {
        await this.runOnce();
      } catch (error) {
        this.options.onError?.(error);
      }
      if (!this.stopped) {
        this.timer = setTimeout(() => { void poll(); }, Math.max(this.options.pollMs ?? 30_000, 1_000));
        this.timer.unref();
      }
    };
    this.timer = setTimeout(() => { void poll(); }, 0);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.service.setWorkerRunning(false);
    await this.current?.catch(() => undefined);
  }
}
