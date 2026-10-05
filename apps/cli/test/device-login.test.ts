import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCli, type CliRuntime, type StoredCliToken } from "../src/cli.js";
import { createDeviceLoginStore, type PendingDeviceLogin } from "../src/device-login-store.js";
import { createFileTokenStore, type KeyringTokenBackend } from "../src/token-store.js";
import { createFileConfigStore } from "../src/config-store.js";

const API = "https://registry.example.test";
const DEVICE = "D".repeat(43);
const TOKEN = `aiss_${"T".repeat(43)}`;
const COMMAND = ["login", "--method", "browser", "--api-url", API, "--scopes", "skills:read,profile:read", "--json"];

class Backend implements KeyringTokenBackend {
  values = new Map<string, string>();
  failure: "get" | "set" | "delete" | undefined;
  async get(key: string) { if (this.failure === "get") throw new Error(DEVICE); return this.values.get(key) ?? null; }
  async set(key: string, value: string) { if (this.failure === "set") throw new Error(DEVICE); this.values.set(key, value); }
  async delete(key: string) { if (this.failure === "delete") throw new Error(DEVICE); this.values.delete(key); }
}

async function fixture(t: TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "myskills-device-resume-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const backend = new Backend();
  let now = Date.now();
  let saved: StoredCliToken | null = { kind: "api", token: "previous-credential" };
  const stdout: string[] = [], stderr: string[] = [], calls: string[] = [];
  let poll: Record<string, unknown> = { status: "authorized", token: TOKEN, email: "device@example.test", expiresAt: new Date(now + 30 * 86400_000).toISOString() };
  const start = { deviceCode: DEVICE, userCode: "23456-ABCDE", verificationUri: "https://registry.example.test/auth/device", expiresAt: new Date(now + 300_000).toISOString(), expiresIn: 300, interval: 5 };
  const runtime: CliRuntime = {
    env: {}, io: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
    tokenStore: { get: async () => saved, set: async (_api, token) => { saved = token; }, delete: async () => { saved = null; } },
    deviceLoginStore: createDeviceLoginStore(undefined, backend, path.join(dir, "locks")),
    deviceLogin: { now: () => now, sleep: async (ms, signal) => { now += ms; signal.throwIfAborted(); } },
    fetch: async (url, init) => {
      assert.equal(init?.headers?.authorization, undefined);
      assert.equal(init?.redirect, "error");
      calls.push(url);
      return new Response(JSON.stringify(url.endsWith("/start") ? start : poll));
    },
  };
  function interrupt() { runtime.deviceLogin!.sleep = async () => { throw new Error("fixture interruption"); }; }
  function resume() {
    runtime.deviceLoginStore = createDeviceLoginStore(undefined, backend, path.join(dir, "locks"));
    runtime.deviceLogin!.sleep = async (ms, signal) => { now += ms; signal.throwIfAborted(); };
  }
  function errorCode() { return JSON.parse(stderr.at(-1)!).error.code; }
  function noSecrets() { const output = [...stdout, ...stderr].join("\n"); assert.equal(output.includes(DEVICE), false); assert.equal(output.includes(TOKEN), false); }
  return { runtime, backend, dir, calls, start, stdout, stderr, interrupt, resume, errorCode, noSecrets, saved: () => saved, now: () => now, advance: (ms: number) => { now += ms; }, poll: (value: Record<string, unknown>) => { poll = value; } };
}

test("interrupted login resumes the same request and original expiry without another start", async t => {
  const f = await fixture(t);
  f.interrupt();
  assert.equal(await runCli(COMMAND, f.runtime), 1);
  assert.equal(f.errorCode(), "DEVICE_LOGIN_INTERRUPTED");
  const pending = await f.runtime.deviceLoginStore!.get(API) as PendingDeviceLogin;
  assert.equal(pending.expiresAt, f.start.expiresAt);
  assert.deepEqual(pending.scopes, ["profile:read", "skills:read"]);
  f.advance(2000); f.resume();
  assert.equal(await runCli(COMMAND, f.runtime), 0);
  assert.deepEqual(f.calls.map(url => url.split("/").at(-1)), ["start", "poll"]);
  assert.equal(f.saved()?.token, TOKEN);
  assert.equal(await f.runtime.deviceLoginStore!.get(API), null);
  assert.ok(f.stdout.some(line => line.includes(f.start.expiresAt)));
  assert.deepEqual(await readdir(path.join(f.dir, "locks")), [...await readdir(path.join(f.dir, "locks"))].filter(name => /^[a-f0-9]{64}$/.test(name)));
  f.noSecrets();
});

test("expired checkpoint is removed and requires a fresh invocation", async t => {
  const f = await fixture(t); f.interrupt(); await runCli(COMMAND, f.runtime);
  f.advance(300_001); f.resume();
  assert.equal(await runCli(COMMAND, f.runtime), 1);
  assert.equal(f.errorCode(), "DEVICE_LOGIN_EXPIRED");
  assert.equal(f.calls.length, 1);
  assert.equal(await f.runtime.deviceLoginStore!.get(API), null);
  assert.equal(f.saved()?.token, "previous-credential");
});

test("near-expiry resume preserves poll interval and never polls after expiry", async t => {
  const f = await fixture(t); f.interrupt(); await runCli(COMMAND, f.runtime); f.resume();
  const pending = await f.runtime.deviceLoginStore!.get(API) as PendingDeviceLogin;
  f.advance(299_000);
  pending.nextPollAt = f.now() + 5000;
  await f.runtime.deviceLoginStore!.set(API, pending);
  assert.equal(await runCli(COMMAND, f.runtime), 1);
  assert.equal(f.errorCode(), "DEVICE_LOGIN_EXPIRED");
  assert.equal(f.calls.length, 1);
  assert.equal(f.now(), Date.parse(f.start.expiresAt));
});

test("poll timeout budget ends at the original deadline", async t => {
  const f = await fixture(t); f.interrupt(); await runCli(COMMAND, f.runtime); f.resume();
  const pending = await f.runtime.deviceLoginStore!.get(API) as PendingDeviceLogin;
  f.advance(299_950); pending.nextPollAt = f.now();
  await f.runtime.deviceLoginStore!.set(API, pending);
  f.runtime.fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => { f.advance(50); reject(new Error(TOKEN)); }, { once: true });
    // AbortSignal.timeout is unref'ed; keep the test process alive briefly.
    setTimeout(() => reject(new Error("deadline not bounded")), 1000).unref();
  });
  const keepAlive = setTimeout(() => {}, 1000);
  try { assert.equal(await runCli(COMMAND, f.runtime), 1); } finally { clearTimeout(keepAlive); }
  assert.equal(f.errorCode(), "DEVICE_LOGIN_EXPIRED");
  assert.equal(await f.runtime.deviceLoginStore!.get(API), null);
  f.noSecrets();
});

test("slow_down interval is saved and honored after another interruption", async t => {
  const f = await fixture(t);
  f.poll({ status: "slow_down", interval: 10 });
  let sleeps = 0;
  f.runtime.deviceLogin!.sleep = async ms => { if (++sleeps === 2) throw new Error(); f.advance(ms); };
  assert.equal(await runCli(COMMAND, f.runtime), 1);
  const pending = await f.runtime.deviceLoginStore!.get(API) as PendingDeviceLogin;
  assert.equal(pending.interval, 10);
  const before = f.now(); f.resume(); f.poll({ status: "denied" });
  assert.equal(await runCli(COMMAND, f.runtime), 1);
  assert.equal(f.now() - before, 10_000);
  assert.equal(f.errorCode(), "DEVICE_LOGIN_DENIED");
});

test("scope mismatch and readable no-resume replacement cannot consume the old pending request", async t => {
  const f = await fixture(t); f.interrupt(); await runCli(COMMAND, f.runtime); f.resume();
  assert.equal(await runCli([...COMMAND.slice(0, -3), "--scopes", "skills:submit", "--json"], f.runtime), 1);
  assert.equal(f.errorCode(), "DEVICE_LOGIN_SCOPES_MISMATCH");
  assert.equal(await runCli([...COMMAND, "--no-resume"], f.runtime), 1);
  assert.equal(f.errorCode(), "DEVICE_LOGIN_PENDING_EXISTS");
  assert.equal(f.calls.length, 1);
  assert.equal(await runCli(["logout", "--api-url", API, "--json"], f.runtime), 0);
  assert.equal(await f.runtime.deviceLoginStore!.get(API), null);
  assert.equal(await runCli([...COMMAND, "--no-resume"], f.runtime), 0);
});

test("secure storage failure stops before instructions/poll, while explicit no-resume bypasses unavailable keyring", async t => {
  const f = await fixture(t);
  f.backend.failure = "get";
  assert.equal(await runCli(COMMAND, f.runtime), 1);
  assert.equal(f.errorCode(), "DEVICE_LOGIN_STORE_UNAVAILABLE");
  assert.equal(f.calls.length, 0);
  assert.equal(await runCli([...COMMAND, "--no-resume"], f.runtime), 0);
  assert.ok(f.stdout.some(line => line.includes("resume is disabled")));
  f.backend.failure = "set";
  const count = f.calls.length;
  assert.equal(await runCli(COMMAND, f.runtime), 1);
  assert.equal(f.errorCode(), "DEVICE_LOGIN_STORE_UNAVAILABLE");
  assert.equal(f.calls.length, count + 1);
  f.noSecrets();
});

for (const writeBeforeThrow of [false, true]) test(`token saving failure (written=${writeBeforeThrow}) clears consumed pending without replay`, async t => {
  const f = await fixture(t);
  const set = f.runtime.tokenStore!.set;
  f.runtime.tokenStore!.set = async (api, token) => { if (writeBeforeThrow) await set(api, token); throw new Error(TOKEN); };
  assert.equal(await runCli(COMMAND, f.runtime), 1);
  assert.equal(f.errorCode(), "DEVICE_LOGIN_TOKEN_SAVE_FAILED");
  assert.match(f.stderr.at(-1)!, /saving was not confirmed/);
  assert.equal(await f.runtime.deviceLoginStore!.get(API), null);
  assert.equal(f.saved()?.token, writeBeforeThrow ? TOKEN : "previous-credential");
  f.noSecrets();
});

test("config saving failure reports that credential save succeeded", async t => {
  const f = await fixture(t);
  f.runtime.configStore = { getApiUrl: () => undefined, setApiUrl: async () => { throw new Error(DEVICE); }, resetApiUrl: async () => {} };
  assert.equal(await runCli(COMMAND, f.runtime), 1);
  assert.equal(f.errorCode(), "DEVICE_LOGIN_CONFIG_SAVE_FAILED");
  assert.equal(f.saved()?.token, TOKEN);
  assert.equal(await f.runtime.deviceLoginStore!.get(API), null);
  f.noSecrets();
});

test("lost authorized response remains interrupted until the API rejects the consumed code", async t => {
  const f = await fixture(t);
  const fetch = f.runtime.fetch;
  f.runtime.fetch = async (url, init) => { if (url.endsWith("poll")) throw new Error(TOKEN); return fetch(url, init); };
  assert.equal(await runCli(COMMAND, f.runtime), 1);
  assert.equal(f.errorCode(), "DEVICE_LOGIN_INTERRUPTED");
  f.poll({ status: "invalid" }); f.runtime.fetch = fetch; f.resume();
  assert.equal(await runCli(COMMAND, f.runtime), 1);
  assert.equal(f.errorCode(), "DEVICE_LOGIN_INVALID");
  assert.equal(await f.runtime.deviceLoginStore!.get(API), null);
  assert.equal(f.saved()?.token, "previous-credential");
  f.noSecrets();
});

test("denial and malformed response preserve previous credentials and never leak response secrets", async t => {
  const f = await fixture(t); f.poll({ status: "denied" });
  assert.equal(await runCli(COMMAND, f.runtime), 1);
  assert.equal(f.errorCode(), "DEVICE_LOGIN_DENIED");
  assert.equal(f.saved()?.token, "previous-credential");
  assert.equal(await f.runtime.deviceLoginStore!.get(API), null);
  f.runtime.fetch = async () => new Response(`{"token":"${TOKEN}`);
  assert.equal(await runCli(COMMAND, f.runtime), 1);
  assert.equal(f.errorCode(), "DEVICE_LOGIN_RESPONSE_INVALID");
  f.noSecrets();
});

test("pending-only and corrupt checkpoints can be removed by logout; cleanup failures are visible", async t => {
  const f = await fixture(t); f.interrupt(); await runCli(COMMAND, f.runtime);
  await f.runtime.tokenStore!.delete(API);
  assert.equal(await runCli(["logout", "--api-url", API], f.runtime), 0);
  f.interrupt(); await runCli(COMMAND, f.runtime);
  const [key] = f.backend.values.keys(); f.backend.values.set(key!, DEVICE);
  assert.equal(await runCli(["logout", "--api-url", API], f.runtime), 0);
  assert.equal(f.backend.values.size, 0);
  f.interrupt(); await runCli(COMMAND, f.runtime); f.resume(); f.poll({ status: "denied" });
  f.backend.failure = "delete";
  assert.equal(await runCli(COMMAND, f.runtime), 1);
  assert.equal(f.errorCode(), "DEVICE_LOGIN_DENIED");
  assert.match(f.stderr.at(-1)!, /cleanup failed/);
  f.noSecrets();
});

test("keyring-unavailable logout still removes an explicit file credential and reports pending cleanup uncertainty", async t => {
  const f = await fixture(t);
  const file = createFileTokenStore({ MYSKILLS_TOKEN_FILE: path.join(f.dir, "tokens.json") });
  await file.set(API, { kind: "api", token: "file-token" });
  f.runtime.tokenStore = file; f.backend.failure = "get";
  assert.equal(await runCli(["logout", "--api-url", API, "--json"], f.runtime), 1);
  assert.equal(f.errorCode(), "DEVICE_LOGIN_CLEANUP_FAILED");
  assert.equal(await file.get(API), null);
});

test("API URLs and canonical configuration namespaces isolate checkpoints", async t => {
  const f = await fixture(t); f.interrupt(); await runCli(COMMAND, f.runtime);
  assert.ok(await f.runtime.deviceLoginStore!.get(`${API}/`));
  assert.equal(await f.runtime.deviceLoginStore!.get("https://other.example.test"), null);
  const named = createDeviceLoginStore("/canonical/profiles/work", f.backend, path.join(f.dir, "locks"));
  assert.equal(await named.get(API), null);
  assert.equal(f.backend.values.size, 1);
});

test("present corrupt keyring state, including literal null, never starts a new request", async t => {
  const f = await fixture(t); f.interrupt(); await runCli(COMMAND, f.runtime); f.resume();
  const [key] = f.backend.values.keys();
  for (const raw of ["null", "[]", DEVICE, JSON.stringify({ version: 1, deviceCode: DEVICE })]) {
    f.backend.values.set(key!, raw);
    assert.equal(await runCli(COMMAND, f.runtime), 1);
    assert.equal(f.errorCode(), "DEVICE_LOGIN_STATE_INVALID");
    assert.equal(f.calls.length, 1);
  }
  f.noSecrets();
});

test("the conservative pre-start deadline is persisted and displayed across restart", async t => {
  const f = await fixture(t);
  const effective = f.start.expiresAt;
  f.start.expiresAt = new Date(Date.parse(effective) + 20_000).toISOString();
  f.interrupt(); assert.equal(await runCli(COMMAND, f.runtime), 1);
  const pending = await f.runtime.deviceLoginStore!.get(API) as PendingDeviceLogin;
  assert.equal(pending.deadline, Date.parse(effective));
  assert.ok(f.stdout.some(line => line.includes(`expires at ${effective}`)));
  assert.match(f.stderr.at(-1)!, new RegExp(effective.replaceAll(".", "\\.")));
  f.advance(300_001); f.resume();
  assert.equal(await runCli(COMMAND, f.runtime), 1);
  assert.equal(f.errorCode(), "DEVICE_LOGIN_EXPIRED");
  assert.equal(f.calls.length, 1);
});

test("two processes serialize the same credential identity and recover only after owner exit", { timeout: 10_000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "myskills-device-lock-process-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const helper = fileURLToPath(new URL("./helpers/device-login-lock-process.ts", import.meta.url));
  const spawn = () => fork(helper, [dir], { execArgv: ["--import", "tsx"], env: { PATH: process.env.PATH }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const first = spawn(), second = spawn();
  t.after(() => { first.kill("SIGKILL"); second.kill("SIGKILL"); });
  let secondAcquired = false;
  second.on("message", () => { secondAcquired = true; });
  // Acquisition order is nondeterministic, so distinguish whoever acquired first.
  const winner = await Promise.race([message(first).then(() => first), message(second).then(() => second)]);
  const loser = winner === first ? second : first;
  let loserAcquired = winner === first ? secondAcquired : false;
  loser.on("message", () => { loserAcquired = true; });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(loserAcquired, false);
  const acquired = message(loser);
  winner.kill("SIGKILL");
  await acquired;
  loser.send("release");
});

test("HOME overrides do not split the production OS-account lock directory", async () => {
  const helper = fileURLToPath(new URL("./helpers/device-login-lock-process.ts", import.meta.url));
  async function directory(home: string): Promise<string> {
    const child = fork(helper, ["--directory"], { execArgv: ["--import", "tsx"], env: { PATH: process.env.PATH, HOME: home }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    return new Promise((resolve, reject) => {
      child.once("message", (message: { directory: string }) => resolve(message.directory));
      child.once("error", reject);
      child.once("exit", (code, signal) => reject(new Error(`Directory fixture exited early (${code ?? signal})`)));
    });
  }
  const [first, second] = await Promise.all([directory("/tmp/myskills-home-a"), directory("/tmp/myskills-home-b")]);
  assert.equal(first, second);
  assert.equal(first, path.join(os.userInfo().homedir, ".config", "myskills-app", "device-login-locks"));
});

test("store creation and non-device CLI commands work without an OS account lookup", async t => {
  const f = await fixture(t);
  const lookup = t.mock.method(os, "userInfo", () => { throw new Error("private-user-info-diagnostic"); });
  assert.doesNotThrow(() => createDeviceLoginStore(undefined, f.backend));
  let opened = 0, requests = 0;
  f.runtime.env = { MYSKILLS_CONFIG_DIR: path.join(f.dir, "config"), MYSKILLS_TOKEN_STORE: "file" };
  f.runtime.createStores = (env, namespace) => {
    opened += 1;
    return { configStore: createFileConfigStore(env), tokenStore: createFileTokenStore(env), deviceLoginStore: createDeviceLoginStore(namespace, f.backend) };
  };
  f.runtime.fetch = async () => { requests += 1; return new Response(JSON.stringify({ skills: [] })); };
  for (const command of [["help"], ["--help"], ["version"], ["--version"], ["search", "--api-url", API]]) {
    assert.equal(await runCli(command, f.runtime), 0);
  }
  assert.equal(opened, 5);
  assert.equal(requests, 1);
  assert.equal(lookup.mock.callCount(), 0);
  assert.equal(f.backend.values.size, 0);
  assert.deepEqual(await readdir(f.dir), []);
});

test("device lock identity failure is clear and never falls back to HOME or accesses credentials", async t => {
  const f = await fixture(t);
  t.mock.method(os, "userInfo", () => { throw new Error("private-user-info-diagnostic"); });
  const fallback = t.mock.method(os, "homedir", () => path.join(f.dir, "home-override"));
  let credentials = 0, requests = 0;
  const backend = {
    get: async () => { credentials += 1; return null; },
    set: async () => { credentials += 1; },
    delete: async () => { credentials += 1; },
  };
  const store = createDeviceLoginStore(undefined, backend);
  f.runtime.deviceLoginStore = store;
  f.runtime.fetch = async () => { requests += 1; throw new Error("Must not fetch without a secure lock identity."); };
  for (const command of [COMMAND, [...COMMAND, "--no-resume"], ["logout", "--api-url", API, "--json"]]) {
    assert.equal(await runCli(command, f.runtime), 1);
    assert.equal(f.errorCode(), "DEVICE_LOGIN_LOCK_UNAVAILABLE");
    assert.match(f.stderr.at(-1)!, /OS.account home/);
    assert.equal(f.stderr.at(-1)!.includes("private-user-info-diagnostic"), false);
  }
  assert.equal(fallback.mock.callCount(), 0);
  assert.equal(credentials, 0);
  assert.equal(requests, 0);
  assert.deepEqual(await readdir(f.dir), []);
  assert.equal(f.saved()?.token, "previous-credential");
});

function message(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("message", () => resolve()); child.once("error", reject);
    child.once("exit", (code, signal) => reject(new Error(`Lock fixture exited before expected message (${code ?? signal})`)));
  });
}
