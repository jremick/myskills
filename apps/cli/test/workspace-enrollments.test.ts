import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { withWorkspaceEnrollment, workspaceEnrollmentDirectory } from "../src/workspace-enrollments.js";
import { codexWorkspaceCapabilities, codexWorkspaceDescriptor, workspaceRootDigest } from "../src/codex-workspace.js";
import { createArchitectureArtifactFixture } from "../../api/test/fixtures/architecture-artifact-fixture.js";

async function setup(t: Parameters<typeof createArchitectureArtifactFixture>[0]) {
  const fixture = await createArchitectureArtifactFixture(t);
  const temp = await mkdtemp(path.join(os.tmpdir(), "myskills-enrollment-authority-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const state = path.join(temp, "config", "workspace-enrollments");
  async function root(name: string) { const directory = path.join(temp, name); await mkdir(directory, { recursive: true }); return realpath(directory); }
  async function bind(workspace: string, targetId = fixture.target.id) {
    const discovery = path.join(workspace, ".agents", "skills");
    await mkdir(path.join(discovery, ".myskills-app"), { recursive: true });
    await writeFile(path.join(discovery, ".myskills-app", "codex-workspace.json"), JSON.stringify({ schemaVersion: 1, rootDigest: workspaceRootDigest(discovery), provenance: { origin: "http://fixture.test", instanceId: "11111111-1111-4111-8111-111111111111" }, target: { ...fixture.target, id: targetId, adapter: codexWorkspaceDescriptor, capabilities: codexWorkspaceCapabilities } }), { mode: 0o600 });
  }
  return { root, bind, state };
}

test("production authority ignores XDG, HOME and selected registry profiles", () => {
  const expected = path.join(os.userInfo().homedir, ".config", "myskills-app", "workspace-enrollments");
  for (const selection of ["one", "two"]) assert.equal(workspaceEnrollmentDirectory({ XDG_CONFIG_HOME: `/tmp/${selection}`, HOME: `/tmp/${selection}`, MYSKILLS_CONFIG_DIR: `/tmp/${selection}` }), expected);
});

test("previous XDG reservations migrate under the common authority without rewriting their history", async t => {
  const s = await setup(t), selected = await s.root("selected"), stale = await s.root("stale");
  const legacy = path.join(s.state, "legacy"), canonical = path.join(s.state, "canonical");
  await assert.rejects(withWorkspaceEnrollment(selected, legacy, true, async () => { throw new Error("interrupted"); }), /interrupted/);
  await withWorkspaceEnrollment(stale, legacy, true, async () => s.bind(stale));
  await rm(stale, { recursive: true });
  const original = await readFile(path.join(legacy, "enrollments.json"), "utf8");
  await withWorkspaceEnrollment(selected, canonical, true, async () => s.bind(selected), { legacyDirectory: legacy });
  await withWorkspaceEnrollment(selected, canonical, false, async () => {}, { legacyDirectory: legacy });
  assert.equal(await readFile(path.join(legacy, "enrollments.json"), "utf8"), original);
  const index = JSON.parse(await readFile(path.join(canonical, "enrollments.json"), "utf8"));
  assert.ok(index.enrollments.find((row: { root: string; binding: unknown }) => row.root === selected).binding);
  assert.ok(index.enrollments.some((row: { root: string }) => row.root === stale));
});

test("two actual CLI processes serialize distinct-XDG parent/child enrollment in both orders and retain interrupted reservations", { timeout: 30_000 }, async t => {
  const fixture = await createArchitectureArtifactFixture(t);
  const helper = fileURLToPath(new URL("./helpers/workspace-enrollment-process.ts", import.meta.url));
  for (const firstSide of ["parent", "child"] as const) {
    const s = await setup(t), parent = await s.root("process-parent"), child = await s.root("process-parent/child"), disjoint = await s.root("process-disjoint");
    const first = firstSide === "parent" ? parent : child, second = firstSide === "parent" ? child : parent;
    let registrations = 0;
    function launch(workspace: string, xdg: string, holdRegistration: boolean) {
      const child = fork(helper, [JSON.stringify({ workspace, authority: s.state, target: fixture.target, holdRegistration })], { execArgv: ["--import", "tsx"], env: { PATH: process.env.PATH, XDG_CONFIG_HOME: xdg }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
      const messages: { event: string; code?: number }[] = [];
      const waiters = new Map<string, () => void>();
      child.on("message", value => { const message = value as { event: string; code?: number }; messages.push(message); if (message.event === "registration") registrations++; waiters.get(message.event)?.(); });
      const done = new Promise<number | null>(resolve => child.once("exit", resolve));
      t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
      return { child, done, event: (event: string) => messages.some(value => value.event === event) ? Promise.resolve() : new Promise<void>(resolve => waiters.set(event, resolve)) };
    }
    const one = launch(first, path.join(s.state, "xdg-one"), true);
    await one.event("registration");
    const two = launch(second, path.join(s.state, "xdg-two"), false);
    await two.event("authority-wait"); // Actual global lock EEXIST before either binding exists.
    const reserved = JSON.parse(await readFile(path.join(s.state, "enrollments.json"), "utf8"));
    assert.equal(reserved.enrollments[0].root, first); assert.equal(reserved.enrollments[0].binding, null);
    assert.equal(registrations, 1);
    one.child.send({ event: "continue" });
    assert.equal(await one.done, 0); assert.equal(await two.done, 1); assert.equal(registrations, 1);
    const other = launch(disjoint, path.join(s.state, "xdg-three"), false);
    assert.equal(await other.done, 0); assert.equal(registrations, 2);
    const interrupted = await s.root("interrupted");
    const crash = launch(interrupted, path.join(s.state, "xdg-four"), true);
    await crash.event("registration"); crash.child.kill("SIGKILL"); await crash.done;
    assert.equal(JSON.parse(await readFile(path.join(s.state, "enrollments.json"), "utf8")).enrollments.find((row: { root: string }) => row.root === interrupted).binding, null);
    const recovery = launch(interrupted, path.join(s.state, "xdg-five"), false);
    assert.equal(await recovery.done, 0, "same-root retained reservation recovers after actual process death");
    const final = JSON.parse(await readFile(path.join(s.state, "enrollments.json"), "utf8"));
    assert.ok(final.enrollments.find((row: { root: string; binding: unknown }) => row.root === interrupted).binding);
  }
});

test("shared enrollment authority denies sequential and concurrent parent/child registration in both orders", async t => {
  for (const firstSide of ["parent", "child"] as const) {
    const s = await setup(t), parent = await s.root("parent"), child = await s.root("parent/child");
    const first = firstSide === "parent" ? parent : child, second = firstSide === "parent" ? child : parent;
    let entered!: () => void, release!: () => void;
    const held = new Promise<void>(resolve => { entered = resolve; }), resume = new Promise<void>(resolve => { release = resolve; });
    let registrations = 0, secondEntered = false;
    const enrolling = withWorkspaceEnrollment(first, s.state, true, async () => { registrations++; entered(); await resume; await s.bind(first); });
    await held;
    const concurrent = withWorkspaceEnrollment(second, s.state, true, async () => { secondEntered = true; registrations++; await s.bind(second); });
    const denied = assert.rejects(concurrent, /overlap/);
    const index = JSON.parse(await readFile(path.join(s.state, "enrollments.json"), "utf8"));
    assert.equal(index.enrollments[0].root, first);
    assert.equal(index.enrollments[0].binding, null, "durable reservation precedes binding and API registration completion");
    assert.equal(secondEntered, false);
    release(); await enrolling; await denied;
    assert.equal(registrations, 1); assert.equal(secondEntered, false);
    await assert.rejects(withWorkspaceEnrollment(second, s.state, true, async () => s.bind(second)), /overlap/);
    await withWorkspaceEnrollment(first, s.state, false, async () => {});
  }
});

test("disjoint existing bindings remain usable without traversing large or unreadable unrelated project contents", async t => {
  const s = await setup(t), one = await s.root("one"), two = await s.root("two");
  await s.bind(one, "existing-one"); // Lazy adoption of a validated pre-index binding.
  const unrelated = path.join(one, "unrelated"); await mkdir(unrelated);
  // The old recursive scan failed beyond 10,000 directories, and on these permissions.
  for (let batch = 0; batch < 11; batch++) await Promise.all(Array.from({ length: 1000 }, (_, index) => mkdir(path.join(unrelated, `item-${batch}-${index}`))));
  const unreadable = path.join(unrelated, "item-0-0"); await chmod(unreadable, 0);
  t.after(async () => { try { await chmod(unreadable, 0o700); } catch (error) { if ((error as { code?: string }).code !== "ENOENT") throw error; } });
  await withWorkspaceEnrollment(one, s.state, false, async () => {});
  await withWorkspaceEnrollment(two, s.state, true, async () => s.bind(two, "existing-two"));
  const index = JSON.parse(await readFile(path.join(s.state, "enrollments.json"), "utf8"));
  assert.equal(index.enrollments.length, 2);
  assert.ok(index.enrollments.every((row: { binding: unknown }) => row.binding));
  for (const root of [one, two]) await withWorkspaceEnrollment(root, s.state, false, async () => {});
});

test("discovery-contained roots, invalid ancestor markers and changed binding identities fail before registration", async t => {
  const s = await setup(t), parent = await s.root("parent"), child = await s.root("parent/child"), discovery = await s.root("parent/.claude/skills/nested");
  let registrations = 0;
  await assert.rejects(withWorkspaceEnrollment(discovery, s.state, true, async () => { registrations++; }), /discovery tree/);
  await mkdir(path.join(parent, ".agents/skills/.myskills-app"), { recursive: true });
  for (const marker of ["{}", "null", "[]", '"unrelated marker"']) {
    await writeFile(path.join(parent, ".agents/skills/.myskills-app/codex-workspace.json"), marker);
    await withWorkspaceEnrollment(child, s.state, false, async () => {});
  }
  await s.bind(parent, "parent-target");
  await withWorkspaceEnrollment(parent, s.state, false, async () => {});
  await s.bind(parent, "substituted-target");
  await assert.rejects(withWorkspaceEnrollment(parent, s.state, false, async () => { registrations++; }), /ambiguous/);
  assert.equal(registrations, 0);
});

test("pre-index child binding denies first parent enrollment and a stale unrelated reservation preserves other workspaces", async t => {
  const s = await setup(t), parent = await s.root("legacy"), child = await s.root("legacy/child"), other = await s.root("other");
  await s.bind(child, "pre-index-child");
  await assert.rejects(withWorkspaceEnrollment(parent, s.state, true, async () => s.bind(parent)), /enrolled descendant/);
  await withWorkspaceEnrollment(child, s.state, false, async () => {});
  await rm(child, { recursive: true });
  await withWorkspaceEnrollment(other, s.state, true, async () => s.bind(other));
  await assert.rejects(withWorkspaceEnrollment(parent, s.state, true, async () => s.bind(parent)), /reservation requires explicit recovery/);
  const index = JSON.parse(await readFile(path.join(s.state, "enrollments.json"), "utf8"));
  assert.equal(index.enrollments.length, 2, "the missing root reservation is retained");
  assert.equal(workspaceEnrollmentDirectory({ XDG_CONFIG_HOME: "/tmp/shared-test", MYSKILLS_CONFIG_DIR: "/tmp/profile-one" }), workspaceEnrollmentDirectory({ XDG_CONFIG_HOME: "/tmp/shared-test", MYSKILLS_CONFIG_DIR: "/tmp/profile-two" }));
});

test("legacy non-discovery roots within .agents or .claude deny parent enrollment before index adoption", async t => {
  const s = await setup(t);
  for (const namespace of [".agents", ".claude"]) {
    const parent = await s.root(`legacy-${namespace}`), child = await s.root(`legacy-${namespace}/${namespace}/project`);
    await s.bind(child, `legacy-${namespace.slice(1)}`);
    let registrations = 0;
    await assert.rejects(withWorkspaceEnrollment(parent, s.state, true, async () => { registrations++; await s.bind(parent); }), /enrolled descendant/);
    assert.equal(registrations, 0);
  }
});
