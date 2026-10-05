import { setTimeout as delay } from "node:timers/promises";
import type { CliRuntime } from "./cli.js";
import { readBoundedResponse, decodeResponseUtf8 } from "./bounded-response.js";
import { DeviceLoginError, type PendingDeviceLogin } from "./device-login-store.js";

/** A first-party device handshake; anonymous requests never reuse stored auth. */
export async function browserDeviceLogin(apiUrl: string, scopes: string[] | undefined, runtime: CliRuntime, noResume = false): Promise<void> {
  apiUrl = apiUrl.replace(/\/+$/, "");
  const api = safeUrl(apiUrl);
  if (api.username || api.password || api.search || api.hash) throw invalidResponse();
  if (!noResume && !runtime.deviceLoginStore) throw new DeviceLoginError("No secure pending-login store is configured. Use login --method browser --no-resume explicitly for an in-memory request.", "DEVICE_LOGIN_STORE_UNAVAILABLE");
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const signal = runtime.deviceLogin?.signal ? AbortSignal.any([controller.signal, runtime.deviceLogin.signal]) : controller.signal;
  const now = runtime.deviceLogin?.now ?? Date.now;
  const sleep = runtime.deviceLogin?.sleep ?? ((milliseconds: number, abort: AbortSignal) => delay(milliseconds, undefined, { signal: abort }));
  const store = noResume ? undefined : runtime.deviceLoginStore;
  const requestedScopes = scopes ? [...new Set(scopes)].sort() : null;
  let request: PendingDeviceLogin | undefined;

  async function post(path: string, body: unknown, deadline?: number) {
    const budget = deadline === undefined ? 15_000 : Math.min(15_000, deadline - now());
    if (budget <= 0) throw expired();
    const abort = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.floor(budget)))]);
    try {
      const response = await runtime.fetch(`${apiUrl}/v1/auth/device/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: abort, redirect: "error" });
      if (!response.ok) throw new DeviceLoginError(`Browser login request failed (HTTP ${response.status}). Retry before the original deadline if a pending request exists.`, "DEVICE_LOGIN_REQUEST_FAILED");
      const text = decodeResponseUtf8(await readBoundedResponse(response, 16_384, abort));
      let result: unknown;
      try { result = JSON.parse(text); } catch { throw invalidResponse(); }
      if (!result || typeof result !== "object" || Array.isArray(result)) throw invalidResponse();
      return result as Record<string, unknown>;
    } catch (error) {
      if (error instanceof DeviceLoginError) throw error;
      if (deadline !== undefined && now() >= deadline) throw expired();
      throw interrupted();
    }
  }

  async function clearPending(outcome?: DeviceLoginError) {
    try { await store?.delete(apiUrl); }
    catch {
      throw new DeviceLoginError(`${outcome?.message ?? "The credential was saved."} Pending browser login cleanup failed; restore OS keyring access and retry logout.`, outcome?.code ?? "DEVICE_LOGIN_CLEANUP_FAILED");
    }
  }

  async function run() {
    if (signal.aborted) throw interrupted();
    if (noResume && runtime.deviceLoginStore) {
      let previous: unknown | null;
      try { previous = await runtime.deviceLoginStore.get(apiUrl); }
      catch (error) {
        if (!(error instanceof DeviceLoginError) || error.code !== "DEVICE_LOGIN_STORE_UNAVAILABLE") throw error;
        previous = null;
        runtime.io.stdout("Secure pending state could not be checked. Run logout after keyring access returns before using resumable login again.");
      }
      if (previous !== null) throw new DeviceLoginError("A pending browser login already exists. Run myskills logout for this API and configuration profile before starting an independent --no-resume request.", "DEVICE_LOGIN_PENDING_EXISTS");
    }
    const previous = await store?.get(apiUrl);
    if (previous !== null && previous !== undefined) {
      request = pendingRequest(previous);
      if (Math.min(Date.parse(request.expiresAt), request.deadline) <= now()) { const error = expired(); await clearPending(error); throw error; }
      if (Date.parse(request.expiresAt) > now() + 600_000) throw invalidState();
      if (JSON.stringify(request.scopes) !== JSON.stringify(requestedScopes)) throw new DeviceLoginError("A pending browser login requests different scopes. Repeat the same --scopes choice, or run myskills logout for this API and configuration profile before starting a new request.", "DEVICE_LOGIN_SCOPES_MISMATCH");
      runtime.io.stdout("Resuming the pending browser login.");
    } else {
      if (noResume) runtime.io.stdout("Browser login resume is disabled. Interruption requires a new code.");
      const startedAt = now();
      const result = await post("start", scopes ? { scopes } : {});
      if (typeof result.expiresIn !== "number" || !Number.isFinite(result.expiresIn) || result.expiresIn < 1 || result.expiresIn > 600) throw invalidResponse();
      request = pendingRequest({ ...result, version: 1, scopes: requestedScopes, deadline: Math.min(Date.parse(String(result.expiresAt)), startedAt + result.expiresIn * 1000), nextPollAt: now() + pollInterval(result.interval) * 1000 });
      if (Date.parse(request.expiresAt) > now() + 600_000) throw invalidResponse();
      if (request.deadline <= now()) throw expired();
      // Persist before showing the browser instructions or issuing any poll.
      await store?.set(apiUrl, request);
    }
    const deadline = Math.min(Date.parse(request.expiresAt), request.deadline);
    runtime.io.stdout(`Open ${request.verificationUri} and enter device code ${request.userCode}.`);
    runtime.io.stdout(`Browser login expires at ${new Date(deadline).toISOString()}. Review the permissions in your browser. Waiting for your decision…`);
    while (now() < deadline) {
      if (signal.aborted) throw interrupted();
      try { await sleep(Math.max(0, Math.min(request.nextPollAt, deadline) - now()), signal); }
      catch { throw interrupted(); }
      if (signal.aborted) throw interrupted();
      if (now() >= deadline) break;
      // A crash during a poll cannot make a restarted CLI poll immediately.
      request.nextPollAt = now() + request.interval * 1000;
      await store?.set(apiUrl, request);
      let result: Record<string, unknown>;
      try { result = await post("poll", { deviceCode: request.deviceCode }, deadline); }
      catch (error) {
        if (error instanceof DeviceLoginError && error.code === "DEVICE_LOGIN_EXPIRED") await clearPending(error);
        throw error;
      }
      if (result.status === "pending" || result.status === "slow_down") {
        request.interval = pollInterval(result.interval);
        request.nextPollAt = now() + request.interval * 1000;
        await store?.set(apiUrl, request);
        continue;
      }
      if (result.status === "authorized") {
        if (typeof result.token !== "string" || !/^aiss_[A-Za-z0-9_-]{43}$/.test(result.token) || typeof result.email !== "string"
          || typeof result.expiresAt !== "string" || !Number.isFinite(Date.parse(result.expiresAt)) || Date.parse(result.expiresAt) <= now()) {
          const error = invalidResponse(); await clearPending(error); throw error;
        }
        // The API already consumed the code. No retry or journal may redeem it again.
        try {
          if (!runtime.tokenStore) throw new Error();
          await runtime.tokenStore.set(apiUrl, { kind: "api", token: result.token, email: result.email, expiresAt: result.expiresAt });
        } catch {
          const error = new DeviceLoginError("Browser authorization completed, but credential saving was not confirmed. This one-time code cannot be redeemed again. Check myskills auth status; if necessary revoke the CLI browser login token in account settings and start a new login.", "DEVICE_LOGIN_TOKEN_SAVE_FAILED");
          await clearPending(error);
          throw error;
        }
        await clearPending();
        try { await runtime.configStore?.setApiUrl(apiUrl); }
        catch { throw new DeviceLoginError("The browser login credential was saved, but saving the selected API URL failed. Use --api-url for this registry and repair the configuration store.", "DEVICE_LOGIN_CONFIG_SAVE_FAILED"); }
        runtime.io.stdout(`${result.email.replace(/[\u0000-\u001F\u007F-\u009F]/gu, " ")}\tlogged-in\texpires=${result.expiresAt}`);
        return;
      }
      const error = result.status === "denied" ? new DeviceLoginError("Browser login denied. Start again to request a new code.", "DEVICE_LOGIN_DENIED")
        : result.status === "expired" ? expired()
        : result.status === "invalid" ? new DeviceLoginError("Browser login is invalid or already redeemed. A lost response after one-time redemption cannot be recovered. Check myskills auth status or revoke the CLI browser login token in account settings, then start again.", "DEVICE_LOGIN_INVALID") : invalidResponse();
      await clearPending(error);
      throw error;
    }
    const error = expired(); await clearPending(error); throw error;
  }

  try {
    if (runtime.deviceLoginStore) await runtime.deviceLoginStore.withLock(apiUrl, run);
    else await run();
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }

  function interrupted(): DeviceLoginError {
    return new DeviceLoginError(request && store
      ? `Browser login interrupted. Repeat the same login command before ${new Date(request.deadline).toISOString()} to resume. A response lost after one-time redemption cannot be recovered.`
      : "Browser login interrupted. Start again to request a new code.", "DEVICE_LOGIN_INTERRUPTED");
  }
}

function pendingRequest(input: unknown): PendingDeviceLogin {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalidState();
  const value = input as Record<string, unknown>;
  if (value.version !== 1 || typeof value.deviceCode !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.deviceCode)
    || typeof value.userCode !== "string" || !/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{5}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{5}$/.test(value.userCode)
    || typeof value.verificationUri !== "string" || typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))
    || !(value.scopes === null || Array.isArray(value.scopes) && value.scopes.length > 0 && value.scopes.length <= 100 && value.scopes.every((scope) => typeof scope === "string" && /^[a-z][a-z-]*:[a-z][a-z-]*$/.test(scope)))
    || typeof value.deadline !== "number" || !Number.isFinite(value.deadline) || value.deadline > Date.parse(value.expiresAt)
    || typeof value.nextPollAt !== "number" || !Number.isFinite(value.nextPollAt)) throw invalidState();
  const verification = safeUrl(value.verificationUri);
  if (verification.username || verification.password || verification.search || verification.hash || verification.pathname !== "/auth/device") throw invalidState();
  return { version: 1, deviceCode: value.deviceCode, userCode: value.userCode, verificationUri: verification.href, expiresAt: value.expiresAt, deadline: value.deadline,
    scopes: value.scopes === null ? null : [...new Set(value.scopes as string[])].sort(), interval: pollInterval(value.interval), nextPollAt: value.nextPollAt };
}
function safeUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw invalidResponse(); }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new DeviceLoginError("Browser login requires HTTPS, except on loopback.", "DEVICE_LOGIN_URL_INVALID");
  return url;
}
function pollInterval(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 5 || value > 60) throw invalidResponse();
  return value;
}
function expired(): DeviceLoginError { return new DeviceLoginError("Browser login expired. Start again to request a new code.", "DEVICE_LOGIN_EXPIRED"); }
function invalidResponse(): DeviceLoginError { return new DeviceLoginError("Invalid browser login response.", "DEVICE_LOGIN_RESPONSE_INVALID"); }
function invalidState(): DeviceLoginError { return new DeviceLoginError("The pending browser login is invalid. Run myskills logout for this API and configuration profile, then log in again.", "DEVICE_LOGIN_STATE_INVALID"); }
