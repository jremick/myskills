/** Serializes renewals and fails closed before promotion after expiry or denial. */
export class CompanionLease {
  private expiresAt: number;
  private failure: unknown;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: Promise<void> = Promise.resolve();
  private stopped = false;
  private state: "applying" | "verifying" = "applying";

  constructor(expiresAt: string | undefined, private readonly renew: (state: "applying" | "verifying") => Promise<string>) {
    this.expiresAt = Date.parse(expiresAt ?? "");
    this.assertFresh();
  }

  async checkpoint(state: "applying" | "verifying" = this.state): Promise<void> {
    this.pending = this.pending.then(async () => {
      this.assertFresh();
      this.state = state;
      const next = Date.parse(await this.renew(state));
      if (!Number.isFinite(next) || next <= Date.now()) throw new Error("Companion renewal returned an expired lease.");
      this.expiresAt = next;
      this.schedule();
    }).catch((error) => { this.failure = error; throw error; });
    await this.pending;
    this.assertFresh();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.pending.catch(() => undefined);
  }

  private assertFresh(): void {
    if (this.failure) throw this.failure;
    if (this.stopped || !Number.isFinite(this.expiresAt) || Date.now() >= this.expiresAt) throw new Error("Companion lease expired. No further filesystem promotion is permitted.");
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (this.stopped) return;
    this.timer = setTimeout(() => { void this.checkpoint().catch(() => undefined); }, Math.max(25, Math.min(60_000, (this.expiresAt - Date.now()) / 3)));
    this.timer.unref();
  }
}
