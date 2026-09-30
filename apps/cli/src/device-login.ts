import { setTimeout as delay } from "node:timers/promises";
import type { CliRuntime } from "./cli.js";
import { readBoundedResponse, decodeResponseUtf8 } from "./bounded-response.js";

/** A first-party device handshake; anonymous requests never reuse stored auth. */
export async function browserDeviceLogin(apiUrl: string, scopes: string[] | undefined, runtime: CliRuntime): Promise<void> {
  const api = new URL(apiUrl);
  if (api.protocol !== "https:" && !(api.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(api.hostname))) throw new Error("Browser login requires HTTPS, except on loopback.");
  async function post(path: string, body: unknown) {
    const signal = AbortSignal.timeout(15_000);
    const response = await runtime.fetch(`${apiUrl}/v1/auth/device/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal, redirect: "error" });
    const text = decodeResponseUtf8(await readBoundedResponse(response, 16_384, signal));
    const result: unknown = JSON.parse(text);
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid device login response.");
    if (!response.ok) throw new Error(`Browser login request failed (HTTP ${response.status}).`);
    return result as Record<string, unknown>;
  }
  const request = await post("start", scopes ? { scopes } : {});
  if (typeof request.deviceCode !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(request.deviceCode)
    || typeof request.userCode !== "string" || !/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{5}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{5}$/.test(request.userCode)
    || typeof request.verificationUri !== "string" || typeof request.expiresIn !== "number" || request.expiresIn < 1 || request.expiresIn > 600) throw new Error("Invalid device login response.");
  const verification = new URL(request.verificationUri);
  if ((verification.protocol !== "https:" && !(verification.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(verification.hostname)))
    || verification.username || verification.password || verification.search || verification.hash || verification.pathname !== "/auth/device") throw new Error("Invalid device verification URL.");
  let interval = pollInterval(request.interval);
  const deadline = Date.now() + request.expiresIn * 1000;
  runtime.io.stdout(`Open ${verification.href} and enter device code ${request.userCode}.`);
  runtime.io.stdout("Review the permissions in your browser. Waiting for your decision…");
  while (Date.now() < deadline) {
    await delay(Math.min(interval * 1000, Math.max(1, deadline - Date.now())));
    if (Date.now() >= deadline) break;
    const result = await post("poll", { deviceCode: request.deviceCode });
    if (result.status === "pending" || result.status === "slow_down") { interval = pollInterval(result.interval); continue; }
    if (result.status === "authorized") {
      if (typeof result.token !== "string" || !/^aiss_[A-Za-z0-9_-]{43}$/.test(result.token) || typeof result.email !== "string"
        || typeof result.expiresAt !== "string" || !Number.isFinite(Date.parse(result.expiresAt)) || Date.parse(result.expiresAt) <= Date.now()) throw new Error("Invalid device credential response.");
      if (!runtime.tokenStore) throw new Error("No credential store is configured.");
      await runtime.tokenStore.set(apiUrl, { kind: "api", token: result.token, email: result.email, expiresAt: result.expiresAt });
      await runtime.configStore?.setApiUrl(apiUrl);
      runtime.io.stdout(`${result.email.replace(/[\u0000-\u001F\u007F-\u009F]/gu, " ")}\tlogged-in\texpires=${result.expiresAt}`);
      return;
    }
    if (["denied", "expired", "invalid"].includes(String(result.status))) throw new Error(`Browser login ${result.status}.`);
    throw new Error("Invalid device login response.");
  }
  throw new Error("Browser login expired. Start again to request a new code.");
}
function pollInterval(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 5 || value > 60) throw new Error("Invalid device polling interval.");
  return value;
}
