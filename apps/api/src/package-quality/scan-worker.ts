import type { PackageScanService } from "./scan-service.js";

/** Poll scheduling only; leases and all attempt state live in Postgres. */
export class PackageScanWorker {
  private current: Promise<number> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  constructor(private readonly service: PackageScanService, private readonly options: { pollMs?: number; onError?: () => void } = {}) {}

  runOnce(): Promise<number> {
    if (this.current) return this.current;
    this.current = this.service.runOnce().finally(() => { this.current = undefined; });
    return this.current;
  }
  start(): void {
    if (this.timer || this.stopped) return;
    const poll = async () => {
      try { await this.runOnce(); } catch { this.options.onError?.(); }
      if (!this.stopped) {
        this.timer = setTimeout(() => { void poll(); }, Math.max(this.options.pollMs ?? 1000, 1000));
        this.timer.unref();
      }
    };
    this.timer = setTimeout(() => { void poll(); }, 0);
    this.timer.unref();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.current?.catch(() => undefined);
  }
}
