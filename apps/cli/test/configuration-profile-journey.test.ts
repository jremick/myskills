import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, type TestContext } from "node:test";
import { generateTotpCode, hashPassword } from "@myskills-app/auth";
import { createFlatArchitecture } from "@myskills-app/core";
import { buildApp } from "../../api/src/app.js";
import { MemoryArchitectureStore } from "../../api/src/architectures/memory-store.js";
import { MemoryAuthStore } from "../../api/src/auth/memory-auth-store.js";
import { AuthService } from "../../api/src/auth/service.js";
import { MemorySkillRepository } from "../../api/src/repositories/memory-skill-repository.js";
import { ArchitectureTargetBindingAuthorizer } from "../../api/src/targets/architecture-binding-authorizer.js";
import { MemoryArchitectureTargetStore } from "../../api/src/targets/memory-target-store.js";
import { ArchitectureTargetService } from "../../api/src/targets/service.js";
import { createFileTokenStore, createKeyringTokenStore, type KeyringTokenBackend } from "../src/token-store.js";

// Authored before the implementation. Existing auth tests inject stores and cannot
// catch bootstrap selecting a default store before parsing the global selector.
// This journey uses real CLI child processes, real file stores, and a loopback API.
// Keychain contract coverage uses the existing backend seam to avoid live credentials.
// Failure cases: profile traversal/duplicates, inherited single-file overrides,
// same-registry account collision, default binding replacement, profile-ID confusion,
// alternate-registry upload, credential fallback/deletion crossing a profile boundary.
const PASSWORD = "synthetic-profile-test-password";
const receipts: Array<{ step: string; exitCode: number }> = [];
const entry = process.env.CLI_PROFILES_EXECUTABLE ?? fileURLToPath(new URL("../src/index.ts", import.meta.url));
after(async () => {
  if (!process.env.CLI_PROFILES_EVIDENCE_PATH) return;
  await mkdir(path.dirname(process.env.CLI_PROFILES_EVIDENCE_PATH), { recursive: true });
  await writeFile(process.env.CLI_PROFILES_EVIDENCE_PATH, `${JSON.stringify({ schema: "myskills.configuration-profile-journey.v1", receipts }, null, 2)}\n`);
});

async function fixture(t: TestContext) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "myskills-config-profile-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = await realpath(temp);
  const config = path.join(root, "config");
  const env: Record<string, string | undefined> = { ...process.env, XDG_CONFIG_HOME: path.join(root, "xdg"), MYSKILLS_CONFIG_DIR: config, MYSKILLS_TOKEN_STORE: "file" };
  for (const key of Object.keys(env)) if (key.startsWith("MYSKILLS_") && !["MYSKILLS_CONFIG_DIR", "MYSKILLS_TOKEN_STORE"].includes(key)) delete env[key];
  const invoke = async (step: string, args: string[], changes: Record<string, string | undefined> = {}, input = "") => {
    const result = await new Promise<{ code: number; out: string; err: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [...(entry.endsWith(".ts") ? ["--import", "tsx"] : []), entry, ...args], { env: { ...env, ...changes }, stdio: ["pipe", "pipe", "pipe"] });
      let out = ""; let err = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => { out += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { err += chunk; });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code: code ?? 1, out, err }));
      child.stdin.end(input);
    });
    receipts.push({ step, exitCode: result.code });
    assert.equal(`${result.out}${result.err}`.includes(PASSWORD), false);
    return { ...result, json: () => JSON.parse(result.out) };
  };
  const ok = async (...args: Parameters<typeof invoke>) => {
    const result = await invoke(...args); assert.equal(result.code, 0, `${args[0]}: ${result.err}`); return result;
  };
  return { root, config, invoke, ok };
}

async function api(t: TestContext) {
  const auth = new MemoryAuthStore("closed");
  const architectures = new MemoryArchitectureStore({});
  const targets = new MemoryArchitectureTargetStore({ teamMemberships: [], organizationMemberships: [] });
  const app = buildApp({ skillRepository: new MemorySkillRepository([]), authService: new AuthService(auth), architectureStore: architectures,
    architectureTargetService: new ArchitectureTargetService(targets, new ArchitectureTargetBindingAuthorizer(architectures)), registryInstanceId: randomUUID() });
  t.after(() => app.close());
  const users = [];
  for (const id of ["personal-account", "work-account"]) {
    const email = `${id}@example.test`;
    auth.addUser({ id, email, name: id, status: "active", emailVerifiedAt: new Date(), roles: ["user"], passwordHash: await hashPassword(PASSWORD) });
    const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password: PASSWORD } });
    assert.equal(login.statusCode, 200);
    const enroll = await app.inject({ method: "POST", url: "/v1/auth/mfa/totp/enroll", headers: { authorization: `Bearer ${login.json().token}` }, payload: { password: PASSWORD } });
    assert.equal(enroll.statusCode, 201);
    const confirm = await app.inject({ method: "POST", url: "/v1/auth/mfa/totp/confirm", headers: { authorization: `Bearer ${login.json().token}` }, payload: { factorId: enroll.json().enrollment.factorId, code: generateTotpCode(enroll.json().enrollment.secret) } });
    assert.equal(confirm.statusCode, 200);
    const challenge = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password: PASSWORD } });
    const session = await app.inject({ method: "POST", url: "/v1/auth/mfa/verify", payload: { challengeToken: challenge.json().challengeToken, recoveryCode: confirm.json().mfa.recoveryCodes[0] } });
    assert.equal(session.statusCode, 200);
    const architecture = await architectures.createArchitecture({ actor: id, owner: { type: "user", id }, name: id, description: "", patternId: "flat" });
    const environmentId = `${id}-environment`; const profileId = `${id}-architecture-profile`;
    await architectures.createRevision({ actor: id, architectureId: architecture.id, expectedCurrentRevisionId: null, message: "fixture", spec: createFlatArchitecture({ id: architecture.id, name: id, profile: { id: profileId, subject: { type: "user", id } }, environment: { id: environmentId, kind: "personal" }, skills: [{ id: "fixture-skill", slug: "fixture-skill", title: "Fixture skill", version: "1.0.0", digest: "a".repeat(64), packageVisibility: "authenticated" }] }) });
    users.push({ id, email, token: session.json().token as string, architectureId: architecture.id, environmentId, profileId });
  }
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address(); assert.ok(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}`, users };
}

test("fresh CLI profiles keep same-registry accounts and scope bindings separate without changing default state", async (t) => {
  const f = await fixture(t); const server = await api(t);
  const [personal, work] = server.users;
  const roots = [path.join(f.root, "personal-skills"), path.join(f.root, "work-skills")];
  for (const root of roots) await mkdir(root);
  const enrollArgs = (user: typeof personal, root: string) => ["scopes", "enroll", "--provider", "codex", "--scope", "global", "--root", root, "--architecture-id", user.architectureId, "--environment-id", user.environmentId, "--profile-id", user.profileId, "--json"];
  await f.ok("default login", ["login", "--api-url", server.url, "--api-key"], {}, `${personal.token}\n`);
  const defaultTarget = (await f.ok("default enroll", enrollArgs(personal, roots[0]))).json().targetId;
  const legacyFiles = ["config.json", "tokens.json", "scopes/workspace-scopes.json"];
  const legacyBytes = await Promise.all(legacyFiles.map((name) => readFile(path.join(f.config, name))));
  const missing = await f.invoke("new named personal is unauthenticated", ["whoami", "--config-profile", "personal", "--json"]);
  assert.notEqual(missing.code, 0); assert.match(missing.err, /No token provided/);
  for (const [name, user, root] of [["work", work, roots[1]], ["personal", personal, roots[0]]] as const) {
    const login = await f.ok(`${name} login`, ["--config-profile", name, "login", "--api-url", server.url, "--api-key"], {}, `${user.token}\n`);
    assert.equal(login.out.includes(user.token), false);
    const who = await f.ok(`${name} whoami`, ["whoami", "--json"], { MYSKILLS_CONFIG_PROFILE: name });
    assert.equal(who.json().user.id, user.id);
    const enrolled = (await f.ok(`${name} enroll`, [...enrollArgs(user, root), "--config-profile", name])).json();
    assert.notEqual(enrolled.targetId, defaultTarget);
    const listed = (await f.ok(`${name} scope readback`, ["scopes", "list", "--config-profile", name, "--json"])).json();
    assert.equal(listed.providers.codex.global.root, root);
    assert.equal(listed.providers.codex.global.targetId, enrolled.targetId);
    const state = JSON.parse(await readFile(path.join(f.config, "profiles", name, "scopes", "workspace-scopes.json"), "utf8"));
    assert.equal(state.providers.codex.global.binding.profileId, user.profileId);
    assert.equal(state.providers.codex.global.binding.actorId, user.id);
    const config = (await f.ok(`${name} config`, ["config", "list", "--config-profile", name, "--json"])).json();
    assert.equal(config.configProfile, name); assert.equal(config.resolvedApiUrl, server.url);
    const diagnosis = (await f.ok(`${name} doctor`, ["doctor", "--config-profile", name, "--dir", path.join(f.root, "install"), "--json"])).json();
    assert.equal(diagnosis.configProfile, name);
    assert.equal(JSON.stringify(diagnosis).includes(user.token), false);
  }
  const other = await api(t);
  const mismatch = await f.invoke("work upload rejects another registry", ["scopes", "observe", "--provider", "codex", "--scope", "global", "--upload", "--config-profile", "work", "--api-url", other.url, "--token", other.users[1].token, "--json"]);
  assert.notEqual(mismatch.code, 0); assert.match(mismatch.err, /SCOPE_REGISTRY_MISMATCH/);
  const chosen = (await f.ok("flag overrides profile env", ["whoami", "--config-profile", "work", "--json"], { MYSKILLS_CONFIG_PROFILE: "personal" })).json();
  assert.equal(chosen.user.id, work.id);
  await f.ok("work logout", ["logout", "--config-profile", "work"]);
  assert.notEqual((await f.invoke("work is logged out", ["whoami", "--config-profile", "work", "--json"])).code, 0);
  assert.equal((await f.ok("personal survives work logout", ["whoami", "--config-profile", "personal", "--json"])).json().user.id, personal.id);
  assert.equal((await f.ok("default account preserved", ["whoami", "--json"])).json().user.id, personal.id);
  for (const [index, name] of legacyFiles.entries()) assert.deepEqual(await readFile(path.join(f.config, name)), legacyBytes[index], `${name} changed`);
});

test("profile selection rejects ambiguous paths, missing values and duplicate selectors before state access", async (t) => {
  const f = await fixture(t);
  for (const selector of ["", "../work", "/work", "Work", ".", "work/personal", "work\\personal", "x".repeat(65)]) {
    const result = await f.invoke("reject unsafe profile", ["config", "set", "api-url", "https://work.example.test", "--config-profile", selector, "--json"]);
    assert.equal(result.code, 2); assert.match(result.err, /CONFIG_PROFILE_INVALID/);
  }
  for (const args of [["config", "list", "--config-profile"], ["--config-profile", "work", "help", "--config-profile", "personal"]]) {
    const result = await f.invoke("reject selector syntax", [...args, "--json"]);
    assert.equal(result.code, 2); assert.match(result.err, /CONFIG_PROFILE_INVALID/);
  }
  for (const key of ["MYSKILLS_CONFIG_FILE", "MYSKILLS_TOKEN_FILE"]) {
    const location = path.join(f.root, `${key}.json`);
    await writeFile(location, "sentinel");
    const result = await f.invoke("reject profile single-file override", ["config", "list", "--config-profile", "work", "--json"], { [key]: location });
    assert.equal(result.code, 2); assert.match(result.err, /CONFIG_PROFILE_AMBIGUOUS/);
    assert.equal(await readFile(location, "utf8"), "sentinel");
  }
  await assert.rejects(stat(f.config), { code: "ENOENT" });
});

test("profile root precedence and legacy explicit file paths stay predictable", async (t) => {
  const f = await fixture(t);
  await f.ok("named config root", ["config", "set", "api-url", "https://work.example.test", "--config-profile", "work"]);
  assert.equal(JSON.parse(await readFile(path.join(f.config, "profiles/work/config.json"), "utf8")).apiUrl, "https://work.example.test");
  await f.ok("named XDG root", ["config", "set", "api-url", "https://xdg.example.test"], { MYSKILLS_CONFIG_DIR: undefined, MYSKILLS_CONFIG_PROFILE: "work" });
  assert.equal(JSON.parse(await readFile(path.join(f.root, "xdg/myskills-app/profiles/work/config.json"), "utf8")).apiUrl, "https://xdg.example.test");
  const explicitFile = path.join(f.root, "legacy-config.json");
  await f.ok("default explicit file", ["config", "set", "api-url", "https://legacy.example.test"], { MYSKILLS_CONFIG_FILE: explicitFile });
  assert.equal(JSON.parse(await readFile(explicitFile, "utf8")).apiUrl, "https://legacy.example.test");
  const config = (await f.ok("explicit API env retains precedence", ["config", "list", "--config-profile", "work", "--json"], { MYSKILLS_API_URL: "https://override.example.test" })).json();
  assert.equal(config.resolvedApiUrl, "https://override.example.test"); assert.equal(config.resolvedApiUrlSource, "env");
  assert.match((await f.ok("named help", ["help", "--config-profile", "work"])).out, /Configuration profile: work/);
  assert.match((await f.ok("default help", ["help"])).out, /Configuration profile: default \(legacy\)/);
});

test("profile-directory aliases cannot overwrite default or another profile, while base aliases remain supported", async (t) => {
  for (const target of ["default", "other-profile", "profiles-parent"]) {
    const f = await fixture(t);
    const protectedRoot = target === "other-profile" ? path.join(f.config, "profiles/personal") : f.config;
    await mkdir(protectedRoot, { recursive: true });
    const original = `${JSON.stringify({ version: 1, apiUrl: "https://personal.example.test" })}\n`;
    await writeFile(path.join(protectedRoot, "config.json"), original);
    if (target === "profiles-parent") {
      await symlink(f.config, path.join(f.config, "profiles"), "dir");
    } else {
      await mkdir(path.join(f.config, "profiles"), { recursive: true });
      await symlink(protectedRoot, path.join(f.config, "profiles/work"), "dir");
    }
    const rejected = await f.invoke(`reject ${target} alias`, ["config", "set", "api-url", "https://work.example.test", "--config-profile", "work", "--json"]);
    assert.equal(rejected.code, 2);
    assert.match(rejected.err, /CONFIG_PROFILE_PATH_UNSAFE/);
    assert.equal(await readFile(path.join(protectedRoot, "config.json"), "utf8"), original);
  }
  const f = await fixture(t);
  await mkdir(f.config);
  const alias = path.join(f.root, "config-alias");
  await symlink(f.config, alias, "dir");
  await f.ok("base alias write", ["config", "set", "api-url", "https://work.example.test", "--config-profile", "work"], { MYSKILLS_CONFIG_DIR: alias });
  assert.equal((await f.ok("base alias readback", ["config", "list", "--config-profile", "work", "--json"])).json().apiUrl, "https://work.example.test");
});

test("keyring profile namespaces isolate same-URL accounts, fallback and logout while retaining the legacy key", async (t) => {
  const f = await fixture(t); const entries = new Map<string, string>();
  const backend: KeyringTokenBackend = { get: async (key) => entries.get(key) ?? null, set: async (key, value) => { entries.set(key, value); }, delete: async (key) => { entries.delete(key); } };
  const url = "https://registry.example.test";
  const token = (value: string) => ({ kind: "api" as const, token: value });
  const legacy = createKeyringTokenStore(createFileTokenStore({ MYSKILLS_CONFIG_DIR: f.config }), backend);
  const workFallback = createFileTokenStore({ MYSKILLS_CONFIG_DIR: path.join(f.config, "profiles/work") });
  const work = createKeyringTokenStore(workFallback, backend, path.join(f.config, "profiles/work"));
  const personal = createKeyringTokenStore(createFileTokenStore({ MYSKILLS_CONFIG_DIR: path.join(f.config, "profiles/personal") }), backend, path.join(f.config, "profiles/personal"));
  const otherRoot = createKeyringTokenStore(createFileTokenStore({ MYSKILLS_CONFIG_DIR: path.join(f.root, "other/profiles/work") }), backend, path.join(f.root, "other/profiles/work"));
  await legacy.set(url, token("legacy-secret"));
  assert.equal(entries.has(url), true);
  assert.equal(await work.get(url), null);
  await workFallback.set(url, token("work-file-secret"));
  assert.equal((await work.get(url))?.token, "work-file-secret");
  assert.equal(await personal.get(url), null);
  await work.set(`${url}/`, token("work-keyring-secret"));
  await personal.set(url, token("personal-secret"));
  assert.equal((await work.get(url))?.token, "work-keyring-secret");
  assert.equal(await workFallback.get(url), null);
  assert.equal(await otherRoot.get(url), null);
  await work.delete(url);
  assert.equal(await work.get(url), null);
  assert.equal((await personal.get(url))?.token, "personal-secret");
  assert.equal((await legacy.get(url))?.token, "legacy-secret");
});
