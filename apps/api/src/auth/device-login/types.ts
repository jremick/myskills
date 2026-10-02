import type { ApiTokenScope, CreateApiTokenInput } from "../types.js";
import { OAUTH_SCOPE_READ_ONLY } from "../../oauth/types.js";

export const DEVICE_LOGIN_TTL_MS = 5 * 60_000;
export const DEVICE_LOGIN_MFA_MS = 15 * 60_000;
export const DEVICE_LOGIN_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;
export const DEVICE_LOGIN_MAX_REQUESTS = 100_000;
export interface DeviceLoginRequest {
  deviceCodeHash: string;
  userCodeHash: string;
  scopes: ApiTokenScope[];
  status: "pending" | "approved" | "denied" | "consumed";
  expiresAt: Date;
  interval: number;
  lastPolledAt: Date | null;
  userId: string | null;
  sessionTokenHash: string | null;
  mfaVerifiedAt: Date | null;
}
export type DeviceDecision = "approved" | "denied" | "invalid" | "already_decided" | "session_revoked" | "mfa_required";
export type DevicePoll = { status: "pending" | "slow_down" | "invalid" | "expired" | "denied"; interval?: number }
  | { status: "authorized"; tokenId: string; email: string; expiresAt: Date };
export interface DeviceLoginStore {
  create(request: DeviceLoginRequest, now: Date): Promise<boolean>;
  find(userCodeHash: string): Promise<DeviceLoginRequest | null>;
  decide(input: { userCodeHash: string; userId: string; sessionTokenHash: string; decision: "approve" | "deny"; now: Date }): Promise<DeviceDecision>;
  poll(input: { deviceCodeHash: string; token: Omit<CreateApiTokenInput, "userId" | "scopes" | "mfaVerifiedAt">; now: Date }): Promise<DevicePoll>;
}

/** Same scope effects as connector consent, with the existing executor scope. */
export function deviceRequiresMfa(scopes: ApiTokenScope[], roles: string[]): boolean {
  return roles.some((role) => role === "owner" || role === "admin" || role === "maintainer")
    || scopes.some((scope) => scope === "targets:execute" || !OAUTH_SCOPE_READ_ONLY[scope]);
}
export function freshDeviceMfa(stamp: Date | null, now: Date): boolean {
  return Boolean(stamp && Number.isFinite(stamp.getTime()) && stamp <= now && now.getTime() - stamp.getTime() < DEVICE_LOGIN_MFA_MS);
}
/** This transition runs while the store owns the request lock. */
export function pollDeviceRequest(request: DeviceLoginRequest, now: Date): DevicePoll | null {
  if (request.status === "consumed") return { status: "invalid" };
  if (request.expiresAt <= now) return { status: "expired" };
  if (request.status === "denied") return { status: "denied" };
  if (request.lastPolledAt && now.getTime() < request.lastPolledAt.getTime() + request.interval * 1000) {
    request.interval = Math.min(60, request.interval + 5);
    request.lastPolledAt = now;
    return { status: "slow_down", interval: request.interval };
  }
  request.lastPolledAt = now;
  return request.status === "pending" ? { status: "pending", interval: request.interval } : null;
}
