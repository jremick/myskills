import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { withInstallRootLock } from "./install-filesystem.js";
import { keyringCredentialKey, nativeKeyringBackend, type KeyringTokenBackend } from "./token-store.js";

export interface PendingDeviceLogin {
  version: 1;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: string;
  deadline: number;
  scopes: string[] | null;
  interval: number;
  nextPollAt: number;
}

export interface CliDeviceLoginStore {
  get(apiUrl: string): Promise<unknown | null>;
  set(apiUrl: string, request: PendingDeviceLogin): Promise<void>;
  delete(apiUrl: string): Promise<void>;
  withLock<T>(apiUrl: string, work: () => Promise<T>): Promise<T>;
}

export class DeviceLoginError extends Error {
  constructor(message: string, public readonly code: string) { super(message); }
}

/** No file fallback: only nonsecret process-lock metadata reaches the filesystem. */
export function createDeviceLoginStore(
  namespace?: string,
  backend: KeyringTokenBackend = nativeKeyringBackend,
  lockDirectory?: string,
): CliDeviceLoginStore {
  const key = (apiUrl: string) => `device-login:${keyringCredentialKey(apiUrl, namespace)}`;
  return {
    async get(apiUrl) {
      let raw: string | null;
      try { raw = await backend.get(key(apiUrl)); }
      catch { throw unavailable(); }
      if (raw === null) return null;
      try {
        if (raw.length > 16_384) throw new Error();
        const value: unknown = JSON.parse(raw);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
        return value;
      } catch {
        throw new DeviceLoginError("The pending browser login is invalid. Run myskills logout for this API and configuration profile, then log in again.", "DEVICE_LOGIN_STATE_INVALID");
      }
    },
    async set(apiUrl, request) {
      try { await backend.set(key(apiUrl), JSON.stringify(request)); }
      catch { throw unavailable(); }
    },
    async delete(apiUrl) {
      try { await backend.delete(key(apiUrl)); }
      catch { throw new DeviceLoginError("Pending browser login cleanup failed. Restore OS keyring access and retry logout for this API and configuration profile.", "DEVICE_LOGIN_CLEANUP_FAILED"); }
    },
    async withLock(apiUrl, work) {
      // The default keyring identity ignores config-directory overrides. The
      // lock must therefore live under the actual OS account, not those overrides.
      const directory = path.join(lockDirectory ?? deviceLoginLockDirectory(), createHash("sha256").update(key(apiUrl)).digest("hex"));
      let acquired = false;
      try { return await withInstallRootLock(directory, async () => { acquired = true; return work(); }); }
      catch (error) {
        if (acquired) throw error;
        throw new DeviceLoginError("Browser login is busy or its process lock could not be acquired. Wait for the other command to exit and retry; preserve an ambiguous lock for operator recovery.", "DEVICE_LOGIN_BUSY");
      }
    },
  };
}

/** Environment HOME overrides must not split an OS-account keyring lock. */
export function deviceLoginLockDirectory(): string {
  try {
    const home = os.userInfo().homedir;
    if (!path.isAbsolute(home)) throw new Error();
    return path.join(home, ".config", "myskills-app", "device-login-locks");
  } catch {
    throw new DeviceLoginError("Cannot determine the OS-account home for secure browser-login locking. Configure a valid OS account before browser login or logout; HOME overrides are not used.", "DEVICE_LOGIN_LOCK_UNAVAILABLE");
  }
}

function unavailable(): DeviceLoginError {
  return new DeviceLoginError("Cannot access secure pending-login storage in the OS keyring. Unlock or restore keyring access, or explicitly use login --method browser --no-resume for an in-memory request.", "DEVICE_LOGIN_STORE_UNAVAILABLE");
}
