import { requestJson } from "./api.js";

export interface DeviceConsent { scopes: string[]; expiresAt: string; mfaRequired: boolean }
export interface DeviceLoginClient {
  inspect(userCode: string): Promise<DeviceConsent>;
  decide(userCode: string, decision: "approve" | "deny"): Promise<{ status: "approved" | "denied" }>;
}
export function createDeviceLoginClient(root: string, fetchImpl: typeof fetch, token?: string): DeviceLoginClient {
  return {
    inspect: (userCode) => requestJson<DeviceConsent>(fetchImpl, `${root}/v1/auth/device/inspect`, { method: "POST", body: { userCode }, token }),
    decide: (userCode, decision) => requestJson<{ status: "approved" | "denied" }>(fetchImpl, `${root}/v1/auth/device/decision`, { method: "POST", body: { userCode, decision }, token }),
  };
}
