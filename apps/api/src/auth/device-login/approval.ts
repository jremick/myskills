import { deviceRequiresMfa, freshDeviceMfa } from "./types.js";

export type DeviceApproval = "open" | "verify" | "enroll";

export function deviceApproval(input: {
  scopes: readonly string[];
  roles: readonly string[];
  mfaVerifiedAt: Date | null;
  factorCount: number;
  now: Date;
}): DeviceApproval {
  if (!deviceRequiresMfa(input.scopes, input.roles)) return "open";
  if (freshDeviceMfa(input.mfaVerifiedAt, input.now)) return "open";
  if (input.factorCount < 1) return "enroll";
  return "verify";
}
