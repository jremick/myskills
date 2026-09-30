import type { MemoryAuthStore } from "../memory-auth-store.js";
import { DEVICE_LOGIN_MAX_REQUESTS, deviceRequiresMfa, freshDeviceMfa, pollDeviceRequest, type DeviceLoginRequest, type DeviceLoginStore, type DeviceDecision, type DevicePoll } from "./types.js";

/** Disposable fixtures only. Production always uses PostgreSQL. */
export class MemoryDeviceLoginStore implements DeviceLoginStore {
  private readonly requests = new Map<string, DeviceLoginRequest>();
  constructor(private readonly auth: MemoryAuthStore) {}
  async create(request: DeviceLoginRequest, now: Date): Promise<boolean> {
    let removed = 0;
    for (const [key, value] of this.requests) {
      if (value.expiresAt <= now) { this.requests.delete(key); if (++removed === 1000) break; }
    }
    if (this.requests.size >= DEVICE_LOGIN_MAX_REQUESTS || this.requests.has(request.deviceCodeHash)
      || [...this.requests.values()].some((r) => r.userCodeHash === request.userCodeHash)) return false;
    this.requests.set(request.deviceCodeHash, structuredClone(request));
    return true;
  }
  async find(userCodeHash: string): Promise<DeviceLoginRequest | null> {
    const request = [...this.requests.values()].find((r) => r.userCodeHash === userCodeHash);
    return request ? structuredClone(request) : null;
  }
  async decide(input: Parameters<DeviceLoginStore["decide"]>[0]): Promise<DeviceDecision> {
    // Fetch account before the synchronous transition, then recheck live status
    // and session at the actual decision. No await occurs after the fence.
    const user = await this.auth.findUserById(input.userId);
    if (!user || !this.auth.isUsableAccountSync(input.userId) || !this.auth.hasActiveSessionSync(input.sessionTokenHash, input.userId, input.now)) return "session_revoked";
    const request = [...this.requests.values()].find((r) => r.userCodeHash === input.userCodeHash);
    if (!request || request.expiresAt <= input.now) return "invalid";
    if (request.status !== "pending") return "already_decided";
    const stamp = this.auth.activeSessionMfaVerifiedAtSync(input.sessionTokenHash, input.userId, input.now);
    if (input.decision === "approve" && deviceRequiresMfa(request.scopes, user.roles) && !freshDeviceMfa(stamp, input.now)) return "mfa_required";
    request.status = input.decision === "approve" ? "approved" : "denied";
    request.userId = input.userId;
    request.sessionTokenHash = input.sessionTokenHash;
    request.mfaVerifiedAt = freshDeviceMfa(stamp, input.now) ? stamp : null;
    return request.status;
  }
  async poll(input: Parameters<DeviceLoginStore["poll"]>[0]): Promise<DevicePoll> {
    const request = this.requests.get(input.deviceCodeHash);
    if (!request) return { status: "invalid" };
    const user = request.userId ? await this.auth.findUserById(request.userId) : null;
    const result = pollDeviceRequest(request, input.now);
    if (result) return result;
    if (!user || !request.sessionTokenHash || !this.auth.isUsableAccountSync(user.id)
      || !this.auth.hasActiveSessionSync(request.sessionTokenHash, user.id, input.now)
      || (deviceRequiresMfa(request.scopes, user.roles) && !freshDeviceMfa(request.mfaVerifiedAt, input.now))) {
      request.status = "denied";
      return { status: "denied" };
    }
    request.status = "consumed";
    try {
      const token = await this.auth.createApiToken({ ...input.token, userId: user.id, scopes: request.scopes, mfaVerifiedAt: request.mfaVerifiedAt });
      return { status: "authorized", tokenId: token.id, email: user.email, expiresAt: token.expiresAt };
    } catch (error) { request.status = "approved"; throw error; }
  }
}
