import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSessionToken, hashSessionToken } from "@myskills-app/auth";
import { runCli, type StoredCliToken } from "../../cli/src/cli.js";
import { createDeviceLoginStore } from "../../cli/src/device-login-store.js";
import { buildApp } from "../src/app.js";
import { AuthService } from "../src/auth/service.js";
import { MemoryAuthStore } from "../src/auth/memory-auth-store.js";
import { MemoryDeviceLoginStore } from "../src/auth/device-login/memory-store.js";
import { DeviceLoginService } from "../src/auth/device-login/service.js";
import { MemorySkillRepository } from "../src/repositories/memory-skill-repository.js";

// Failure scenarios: browser denial overwrites credentials; CLI sends an old
// bearer on anonymous polling; scopes widen; token prints; consent never occurs.
test("real CLI browser login polls the real HTTP API and stores only the authorized scoped credential", { timeout: 25_000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myskills-device-http-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entries = new Map<string, string>();
  const auth = new MemoryAuthStore();
  const user = auth.addUser({ email: "cli-device@example.com", status: "active", emailVerifiedAt: new Date(), roles: ["user"] });
  const session = createSessionToken();
  await auth.createSession({ userId: user.id, tokenHash: hashSessionToken(session), expiresAt: new Date(Date.now() + 3_600_000) });
  const app = buildApp({ skillRepository: new MemorySkillRepository([]), authService: new AuthService(auth), deviceLoginService: new DeviceLoginService(new MemoryDeviceLoginStore(auth), { verificationUri: "http://127.0.0.1:3000/auth/device" }) });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const address = app.server.address();
  assert.ok(address && typeof address !== "string");
  const apiUrl = `http://127.0.0.1:${address.port}`;
  let saved: StoredCliToken | null = null;
  const output: string[] = [];
  let decision: "approve" | "deny" = "approve";
  const runtime = {
    env: {}, io: { stdout: (line: string) => output.push(line), stderr: (line: string) => output.push(line) },
    tokenStore: { get: async () => saved, set: async (_: string, token: StoredCliToken) => { saved = token; }, delete: async () => { saved = null; } },
    deviceLoginStore: createDeviceLoginStore(undefined, { get: async key => entries.get(key) ?? null, set: async (key, value) => { entries.set(key, value); }, delete: async key => { entries.delete(key); } }, directory),
    fetch: async (url: string, init?: Parameters<typeof fetch>[1]) => {
      if (url.includes("/v1/auth/device/")) assert.equal(new Headers(init?.headers).has("authorization"), false);
      const response = await fetch(url, init);
      if (url.endsWith("/start")) {
        const request = await response.clone().json();
        const inspect = await fetch(`${apiUrl}/v1/auth/device/inspect`, { method: "POST", headers: { authorization: `Bearer ${session}`, "content-type": "application/json" }, body: JSON.stringify({ userCode: request.userCode }) });
        assert.deepEqual((await inspect.json()).scopes, ["profile:read", "skills:read"]);
        const consent = await fetch(`${apiUrl}/v1/auth/device/decision`, { method: "POST", headers: { authorization: `Bearer ${session}`, "content-type": "application/json" }, body: JSON.stringify({ userCode: request.userCode, decision }) });
        assert.equal(consent.status, 200);
      }
      return response;
    },
  };
  assert.equal(await runCli(["login", "--method", "browser", "--api-url", apiUrl, "--scopes", "profile:read,skills:read"], runtime), 0);
  const stored = saved as StoredCliToken | null;
  assert.ok(stored && stored.kind === "api");
  assert.equal(output.join("\n").includes(stored.token), false);
  assert.equal((await fetch(`${apiUrl}/v1/me`, { headers: { authorization: `Bearer ${stored.token}` } })).status, 200);
  decision = "deny";
  assert.equal(await runCli(["login", "--method", "browser", "--api-url", apiUrl, "--scopes", "profile:read,skills:read"], runtime), 1);
  assert.deepEqual(saved, stored);
  t.diagnostic(JSON.stringify({ journey: "real CLI → loopback HTTP API → browser consent endpoints → scoped credential → denial preserves previous credential", tokenPrinted: false }));
});

test("CLI process restarts before and after browser approval retain one pending API request", { timeout: 20_000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myskills-device-process-http-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const auth = new MemoryAuthStore();
  const user = auth.addUser({ email: "restart-device@example.com", status: "active", emailVerifiedAt: new Date(), roles: ["user"] });
  const session = createSessionToken();
  await auth.createSession({ userId: user.id, tokenHash: hashSessionToken(session), expiresAt: new Date(Date.now() + 3_600_000) });
  const service = new DeviceLoginService(new MemoryDeviceLoginStore(auth), { verificationUri: "http://127.0.0.1:3000/auth/device" });
  let starts = 0;
  const originalStart = service.start.bind(service);
  service.start = async input => { starts += 1; return originalStart(input); };
  const app = buildApp({ skillRepository: new MemorySkillRepository([]), authService: new AuthService(auth), deviceLoginService: service });
  await app.listen({ host: "127.0.0.1", port: 0 }); t.after(() => app.close());
  const address = app.server.address(); assert.ok(address && typeof address !== "string");
  const apiUrl = `http://127.0.0.1:${address.port}`;
  const entries = new Map<string, string>();
  const output: string[] = [];
  let saved: StoredCliToken | undefined;
  const helper = fileURLToPath(new URL("../../cli/test/helpers/device-login-process.ts", import.meta.url));
  function startProcess() {
    const child = fork(helper, [apiUrl, directory], { execArgv: ["--import", "tsx"], env: { PATH: process.env.PATH }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
    let waitingResolve: () => void;
    const waiting = new Promise<void>(resolve => { waitingResolve = resolve; });
    let doneResolve: (code: number) => void;
    const done = new Promise<number>(resolve => { doneResolve = resolve; });
    child.on("message", (message: { type: string; id?: number; operation?: string; key?: string; raw?: string; line?: string; token?: StoredCliToken; code?: number }) => {
      if (message.type === "keyring") {
        if (message.operation === "set") entries.set(message.key!, message.raw!);
        if (message.operation === "delete") entries.delete(message.key!);
        child.send({ id: message.id, value: message.operation === "get" ? entries.get(message.key!) ?? null : null });
      }
      if (message.type === "saved") saved = message.token;
      if (message.line) { output.push(message.line); if (message.line.includes("Waiting for your decision")) waitingResolve(); }
      if (message.type === "done") doneResolve(message.code!);
    });
    return { child, waiting, done };
  }
  const first = startProcess(); await first.waiting;
  const exited = once(first.child, "exit"); first.child.kill("SIGKILL"); await exited;
  const pending = JSON.parse([...entries.values()][0]!);
  const second = startProcess(); await second.waiting;
  const consent = await fetch(`${apiUrl}/v1/auth/device/decision`, { method: "POST", headers: { authorization: `Bearer ${session}`, "content-type": "application/json" }, body: JSON.stringify({ userCode: pending.userCode, decision: "approve" }) });
  assert.equal(consent.status, 200);
  second.child.kill("SIGTERM"); assert.equal(await second.done, 1);
  const third = startProcess(); await third.waiting; assert.equal(await third.done, 0);
  assert.equal(starts, 1);
  assert.equal(entries.size, 0);
  assert.ok(saved && saved.kind === "api");
  assert.equal(output.join("\n").includes(saved.token), false);
  assert.equal(output.join("\n").includes(pending.deviceCode), false);
  assert.equal((await fetch(`${apiUrl}/v1/me`, { headers: { authorization: `Bearer ${saved.token}` } })).status, 200);
  const replay = await fetch(`${apiUrl}/v1/auth/device/poll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceCode: pending.deviceCode }) });
  assert.equal((await replay.json()).status, "invalid");
  t.diagnostic("Three real CLI processes; one loopback API request; interrupts before/after approval; IPC fake keyring; scoped token usable; replay invalid; no secret output.");
});

test("lost real HTTP redemption response cannot be replayed into another credential", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myskills-device-lost-http-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = Date.now();
  const auth = new MemoryAuthStore();
  const user = auth.addUser({ email: "lost-device@example.com", status: "active", emailVerifiedAt: new Date(now), roles: ["user"] });
  const session = createSessionToken();
  await auth.createSession({ userId: user.id, tokenHash: hashSessionToken(session), expiresAt: new Date(now + 3_600_000) });
  const app = buildApp({ skillRepository: new MemorySkillRepository([]), authService: new AuthService(auth), deviceLoginService: new DeviceLoginService(new MemoryDeviceLoginStore(auth), { verificationUri: "http://127.0.0.1:3000/auth/device", clock: () => new Date(now) }) });
  await app.listen({ host: "127.0.0.1", port: 0 }); t.after(() => app.close());
  const address = app.server.address(); assert.ok(address && typeof address !== "string");
  const apiUrl = `http://127.0.0.1:${address.port}`;
  const entries = new Map<string, string>();
  let lost = true, saved = false, starts = 0;
  const stderr: string[] = [];
  const runtime = {
    env: {}, io: { stdout: () => {}, stderr: (line: string) => stderr.push(line) },
    deviceLogin: { now: () => now, sleep: async (ms: number) => { now += ms; } },
    deviceLoginStore: createDeviceLoginStore(undefined, { get: async key => entries.get(key) ?? null, set: async (key, value) => { entries.set(key, value); }, delete: async key => { entries.delete(key); } }, directory),
    tokenStore: { get: async () => null, set: async () => { saved = true; }, delete: async () => {} },
    fetch: async (url: string, init?: Parameters<typeof fetch>[1]) => {
      const response = await fetch(url, init);
      if (url.endsWith("/start")) {
        starts += 1; const request = await response.clone().json();
        assert.equal((await app.inject({ method: "POST", url: "/v1/auth/device/decision", headers: { authorization: `Bearer ${session}` }, payload: { userCode: request.userCode, decision: "approve" } })).statusCode, 200);
      }
      if (url.endsWith("/poll") && lost) { lost = false; assert.equal((await response.json()).status, "authorized"); throw new Error("simulated lost response after server commit"); }
      return response;
    },
  };
  const command = ["login", "--method", "browser", "--api-url", apiUrl, "--scopes", "profile:read,skills:read", "--json"];
  assert.equal(await runCli(command, runtime), 1);
  assert.equal(JSON.parse(stderr.at(-1)!).error.code, "DEVICE_LOGIN_INTERRUPTED");
  assert.equal(await runCli(command, runtime), 1);
  assert.equal(JSON.parse(stderr.at(-1)!).error.code, "DEVICE_LOGIN_INVALID");
  assert.equal(starts, 1); assert.equal(saved, false); assert.equal(entries.size, 0);
  assert.equal((await auth.listApiTokensForUser(user.id)).length, 1);
});
