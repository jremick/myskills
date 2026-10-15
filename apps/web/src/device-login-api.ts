import { requestJson } from "./api.js";
import { parseDeviceInspect, type DeviceConsent } from "./sign-in-flow.js";

export type { DeviceConsent };

export interface DeviceLoginClient {
  inspect(userCode: string): Promise<DeviceConsent>;
  decide(userCode: string, decision: "approve" | "deny"): Promise<{ status: "approved" | "denied" }>;
}

export function createDeviceLoginClient(root: string, fetchImpl: typeof fetch, token?: string): DeviceLoginClient {
  return {
    async inspect(userCode) {
      return parseDeviceInspect(await requestJson<unknown>(fetchImpl, `${root}/v1/auth/device/inspect`, { method: "POST", body: { userCode }, token }));
    },
    decide: (userCode, decision) => requestJson<{ status: "approved" | "denied" }>(fetchImpl, `${root}/v1/auth/device/decision`, { method: "POST", body: { userCode, decision }, token }),
  };
}
