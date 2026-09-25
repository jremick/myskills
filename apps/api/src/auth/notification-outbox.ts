import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { hashSessionToken } from "@myskills-app/auth";
import type { AuthActionNotification, AuthNotificationSink } from "./service.js";
import type { AuthStore, AuthUserRecord } from "./types.js";

export const AUTH_NOTIFICATION_MAX_ATTEMPTS = 5;
export const AUTH_NOTIFICATION_LEASE_MS = 60_000;
export const AUTH_NOTIFICATION_BATCH_SIZE = 10;
export const AUTH_NOTIFICATION_RETENTION_MS = 24 * 60 * 60 * 1000;
export type QueuedAuthNotificationPurpose = "email_verification" | "password_reset";
export type AuthNotificationOutcome = "delivered" | "invalid" | "expired" | "failed";
export interface AuthNotificationIntent { id: string; payloadCiphertext: string }
export interface AuthNotificationClaim {
  id: string;
  tokenHash: string;
  purpose: QueuedAuthNotificationPurpose;
  payloadCiphertext: string;
  expiresAt: Date;
  attempts: number;
  leaseId: string;
  leaseExpiresAt: Date;
}
export interface FinishAuthNotificationInput {
  id: string;
  leaseId: string;
  now: Date;
  outcome: AuthNotificationOutcome | "retry";
  availableAt?: Date;
}

function key(secret: string): Buffer {
  return createHash("sha256").update("myskills:auth-notification-outbox:v1\0").update(secret).digest();
}
function aad(id: string, tokenHash: string, purpose: QueuedAuthNotificationPurpose): Buffer {
  return Buffer.from(JSON.stringify(["v1", id, tokenHash, purpose]));
}
export function encryptAuthNotification(
  secret: string,
  input: { token: string; email: string; purpose: QueuedAuthNotificationPurpose },
): AuthNotificationIntent {
  const id = randomUUID();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(secret), iv);
  cipher.setAAD(aad(id, hashSessionToken(input.token), input.purpose));
  // Explicit fields only: callers can contain a password hash behind AuthUserRecord.
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ token: input.token, email: input.email }), "utf8"), cipher.final()]);
  return { id, payloadCiphertext: ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".") };
}
export function decryptAuthNotification(secret: string, claim: AuthNotificationClaim): { token: string; email: string } {
  const [version, iv, tag, ciphertext, extra] = claim.payloadCiphertext.split(".");
  if (version !== "v1" || !iv || !tag || !ciphertext || extra !== undefined) throw new Error("Invalid auth notification payload.");
  const decipher = createDecipheriv("aes-256-gcm", key(secret), Buffer.from(iv, "base64url"));
  decipher.setAAD(aad(claim.id, claim.tokenHash, claim.purpose));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  const value: unknown = JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8"));
  if (!value || typeof value !== "object" || !("token" in value) || !("email" in value) ||
      typeof value.token !== "string" || typeof value.email !== "string" ||
      hashSessionToken(value.token) !== claim.tokenHash) throw new Error("Invalid auth notification payload.");
  return { token: value.token, email: value.email };
}

export function eligibleAuthNotification(user: AuthUserRecord, purpose: QueuedAuthNotificationPurpose, hasPassword: boolean): boolean {
  if (user.status === "disabled" || user.status === "deleted") return false;
  return purpose === "password_reset" ? user.status === "active" && Boolean(user.emailVerifiedAt) && hasPassword : !user.emailVerifiedAt;
}

/** Auth-only delivery loop. Claims and completions are fenced; provider I/O never holds a DB transaction. */
export class AuthNotificationWorker {
  private current: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private readonly cancellation = new AbortController();
  constructor(private readonly store: AuthStore, private readonly sink: AuthNotificationSink, private readonly options: {
    secret: string;
    now?: () => Date;
    deliveryTimeoutMs?: number;
    pollMs?: number;
    onError?: () => void;
  }) {}

  runOnce(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.current) return this.current;
    this.current = this.dispatch().finally(() => { this.current = undefined; });
    return this.current;
  }
  start(): void {
    if (this.stopped || this.timer) return;
    const poll = async () => {
      try { await this.runOnce(); } catch { this.options.onError?.(); }
      if (!this.stopped) {
        this.timer = setTimeout(() => { void poll(); }, this.options.pollMs ?? 1000);
        this.timer.unref();
      }
    };
    this.timer = setTimeout(() => { void poll(); }, 0);
    this.timer.unref();
  }
  async stop(drainMs = 20_000): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    // Stop waiting for hung provider promises and prohibit any subsequent DB work.
    this.cancellation.abort();
    if (!this.current) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.current.catch(() => {}), new Promise<void>((resolve) => { timer = setTimeout(resolve, drainMs); })]);
    if (timer) clearTimeout(timer);
  }
  private now(): Date { return this.options.now?.() ?? new Date(); }
  private async dispatch(): Promise<void> {
    const claims = await this.store.claimAuthNotifications({ now: this.now(), limit: AUTH_NOTIFICATION_BATCH_SIZE, leaseId: randomUUID() });
    if (this.stopped) return;
    const results = await Promise.allSettled(claims.map((claim) => this.deliver(claim)));
    if (results.some((result) => result.status === "rejected")) throw new Error("Auth notification dispatch failed.");
  }
  private async deliver(claim: AuthNotificationClaim): Promise<void> {
    if (this.stopped) return;
    const user = await this.store.authNotificationRecipient(claim, this.now());
    if (this.stopped) return;
    if (!user) { await this.finish(claim, claim.expiresAt <= this.now() ? "expired" : "invalid"); return; }
    let payload: { token: string; email: string };
    try { payload = decryptAuthNotification(this.options.secret, claim); }
    catch { await this.finish(claim, "invalid"); return; }
    if (payload.email !== user.email.trim().toLowerCase()) { await this.finish(claim, "invalid"); return; }
    const controller = new AbortController();
    const notification: AuthActionNotification = { user, ...payload, expiresAt: claim.expiresAt, signal: controller.signal };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    try {
      const delivery = Promise.resolve().then(() => {
        if (this.stopped || claim.leaseExpiresAt <= this.now() || claim.expiresAt <= this.now()) throw new Error("Delivery lease expired");
        return claim.purpose === "password_reset" ? this.sink.sendPasswordReset(notification) : this.sink.sendEmailVerification(notification);
      });
      await Promise.race([
        delivery,
        new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Delivery timed out")); }, Math.min(this.options.deliveryTimeoutMs ?? 15_000, 30_000)); }),
        new Promise<never>((_, reject) => {
          cancel = () => { controller.abort(); reject(new Error("Stopped")); };
          this.cancellation.signal.addEventListener("abort", cancel, { once: true });
          if (this.stopped) cancel();
        }),
      ]);
      await this.finish(claim, "delivered");
    } catch {
      // Provider errors may contain message bodies or tokens. Persist only an outcome code.
      await this.finish(claim, "retry");
    } finally {
      if (timer) clearTimeout(timer);
      if (cancel) this.cancellation.signal.removeEventListener("abort", cancel);
    }
  }
  private async finish(claim: AuthNotificationClaim, outcome: AuthNotificationOutcome | "retry"): Promise<void> {
    if (this.stopped) return;
    const now = this.now();
    const availableAt = new Date(now.getTime() + Math.min(15 * 60_000, 30_000 * 2 ** (claim.attempts - 1)));
    await this.store.finishAuthNotification({ id: claim.id, leaseId: claim.leaseId, now, outcome, availableAt });
  }
}
