import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

// Failure cases, recorded before implementation. The real shell/configuration CLI runs
// against an isolated release bundle and private config. Only Docker is replaced; it
// records the host boundary and executes the actual configure CLI for ops invocations.
// - A checksum mismatch, shell expression in public metadata, tag-only image, unsupported
//   platform, or manifest/env disagreement reaches Docker or is presented as verified.
// - Setup accepts HTTP/console notifications, exposes answers, follows a symlink, accepts
//   permissive input/config modes, or overwrites a previously generated credential file.
// - Startup starts the application before dependencies, bucket creation and migration;
//   bootstrap runs seeds or puts bootstrap credentials in the long-lived runtime env.
// - Backup uses a same-host bucket or does not require protected external HTTPS settings.
// - Upgrade stops writes before image pull, migrates before a fresh coordinated backup,
//   permits downgrade, ignores forward-only consent, races another upgrade, resumes after
//   failed migration, or loses the receipt needed to plan recovery.
// - Recovery silently performs an in-place restore or executes host-network recovery on
//   an unsupported OS. Diagnostics emit raw Docker errors or environment values.

const root = resolve(".");
const digest = "a".repeat(64);
const version = "0.1.0-beta.18";
const commit = "c".repeat(40);
const canary = "private-credential-DoNotPrint-8247";
const answers = {
  APP_BASE_URL: "https://skills.operator.test", VITE_API_BASE_URL: "/api",
  TRUST_PROXY: "172.16.0.0/12", AUTH_NOTIFICATION_MODE: "smtp", SMTP_HOST: "smtp.operator.test",
  SMTP_FROM: "MySkills <mail@operator.test>", SMTP_USER: "mailer", SMTP_PASSWORD: canary,
  SEED_OWNER_EMAIL: "owner@operator.test", SEED_OWNER_PASSWORD: `${canary}-owner`,
  MYSKILLS_COMPOSE_PROJECT: "myskills-fixture", WEB_PORT: "3300",
};

test("bundle integrity and digest metadata fail before Docker", (t) => {
  for (const change of [
    (f) => writeFileSync(join(f.bundle, "compose.yml"), "tampered"),
    (f) => { writeFileSync(join(f.bundle, "release.env"), `MYSKILLS_OPS_IMAGE=$(touch ${join(f.root, "pwned")})\n`); sums(f); },
    (f) => { writeFileSync(join(f.bundle, "release.env"), releaseEnv().replace(`@sha256:${digest}`, ":latest")); sums(f); },
  ]) {
    const f = fixture(t); change(f);
    const run = execute(f, ["preflight"]);
    assert.notEqual(run.status, 0, run.output);
    assert.deepEqual(f.records(), []);
    assert.equal(existsSync(join(f.root, "pwned")), false);
  }
  const f = fixture(t); const manifest = JSON.parse(readFileSync(join(f.bundle, "release-manifest.json")));
  manifest.source.commit = "d".repeat(40); writeFileSync(join(f.bundle, "release-manifest.json"), JSON.stringify(manifest)); sums(f);
  const run = execute(f, ["setup", "--answers-file", f.answers]);
  assert.notEqual(run.status, 0); assert.equal(existsSync(join(f.config, "runtime.env")), false);
});

test("checksum-valid evidence with wrong image or source identity is refused", (t) => {
  for (const field of ["imageRef", "source"]) {
    const f = fixture(t); const path = join(f.bundle, "api-amd64.json"); const proof = JSON.parse(readFileSync(path));
    if (field === "imageRef") proof.imageRef = `registry.operator.test/wrong@sha256:${digest}`;
    else proof.labels["org.opencontainers.image.revision"] = "f".repeat(40);
    const bytes = JSON.stringify(proof); writeFileSync(path, bytes);
    const manifestPath = join(f.bundle, "release-manifest.json"); const manifest = JSON.parse(readFileSync(manifestPath));
    manifest.images.api.platforms[0].manifestEvidence.sha256 = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(manifestPath, JSON.stringify(manifest)); sums(f);
    const run = execute(f, ["setup", "--answers-file", f.answers]); assert.notEqual(run.status, 0);
    assert.equal(existsSync(join(f.config, "runtime.env")), false);
  }
});

test("setup creates separate protected credentials, validates inputs and never clobbers", (t) => {
  const f = fixture(t); const run = execute(f, ["setup", "--answers-file", f.answers]);
  assert.equal(run.status, 0, run.output); assert.doesNotMatch(run.output, new RegExp(canary));
  assert.equal(statSync(f.config).mode & 0o777, 0o700);
  for (const file of ["runtime.env", "bootstrap.env"]) assert.equal(statSync(join(f.config, file)).mode & 0o777, 0o600);
  const runtime = readFileSync(join(f.config, "runtime.env"), "utf8");
  const bootstrap = readFileSync(join(f.config, "bootstrap.env"), "utf8");
  assert.doesNotMatch(runtime, /SEED_OWNER|change-me|dev-only|ai_skills_share_dev/);
  assert.match(runtime, /SMTP_PASSWORD=/); assert.match(bootstrap, /SEED_OWNER_PASSWORD=/);
  const duplicate = execute(f, ["setup", "--answers-file", f.answers]);
  assert.notEqual(duplicate.status, 0); assert.equal(readFileSync(join(f.config, "runtime.env"), "utf8"), runtime);
  assert.equal(readFileSync(join(f.config, "bootstrap.env"), "utf8"), bootstrap);
  assert.ok(f.records().every((record) => !JSON.stringify(record).includes(canary)), "secrets must not reach Docker args");
  for (const invalid of [{ APP_BASE_URL: "http://skills.operator.test" }, { AUTH_NOTIFICATION_MODE: "console" }]) {
    const bad = fixture(t); writeFileSync(bad.answers, JSON.stringify({ ...answers, ...invalid }));
    const reject = execute(bad, ["setup", "--answers-file", bad.answers]); assert.notEqual(reject.status, 0);
    assert.equal(existsSync(join(bad.config, "runtime.env")), false); assert.doesNotMatch(reject.output, new RegExp(canary));
  }
  const permissive = fixture(t); chmodSync(permissive.answers, 0o644);
  assert.notEqual(execute(permissive, ["setup", "--answers-file", permissive.answers]).status, 0);
  assert.equal(existsSync(join(permissive.config, "runtime.env")), false);
  const linked = fixture(t); const real = `${linked.answers}.real`; copyFileSync(linked.answers, real); rmSync(linked.answers); symlinkSync(real, linked.answers);
  assert.notEqual(execute(linked, ["setup", "--answers-file", linked.answers]).status, 0); assert.equal(existsSync(join(linked.config, "runtime.env")), false);
});

test("fixed web route, SMTPS and optional HTTP MCP match the shipped ingress contracts", (t) => {
  const wrong = fixture(t); writeFileSync(wrong.answers, JSON.stringify({ ...answers, VITE_API_BASE_URL: "https://other.operator.test/api" }));
  assert.notEqual(execute(wrong, ["setup", "--answers-file", wrong.answers]).status, 0);
  const f = fixture(t); writeFileSync(f.answers, JSON.stringify({ ...answers, SMTP_PORT: "465", MYSKILLS_ENABLE_MCP: "true", MYSKILLS_MCP_ALLOWED_HOSTS: "mcp-http:3002" }));
  const setup = execute(f, ["setup", "--answers-file", f.answers]); assert.equal(setup.status, 0, setup.output);
  const runtime = readFileSync(join(f.config, "runtime.env"), "utf8");
  assert.match(runtime, /SMTP_SECURE='true'/); assert.match(runtime, /MCP_PROXY_TARGET='http:\/\/mcp-http:3002'/); assert.doesNotMatch(runtime, /MYSKILLS_TOKEN/);
  rmSync(f.log); const up = execute(f, ["up"]); assert.equal(up.status, 0, up.output);
  assertOrder(composeCalls(f), ["up -d --wait --no-deps api", "--profile mcp up -d --wait --no-deps mcp-http", "up -d --wait --no-deps web"]);
});

test("startup waits for storage and migration; bootstrap is a separate fresh-only command", (t) => {
  const f = configured(t); const up = execute(f, ["up"]); assert.equal(up.status, 0, up.output);
  const calls = composeCalls(f);
  assertOrder(calls, ["pull", "up -d --wait postgres minio", "run --rm --no-deps minio-init", "run --rm --no-deps migrate", "up -d --wait --no-deps api", "up -d --wait --no-deps web"]);
  assert.ok(calls.every((call) => !call.includes("seed") && !call.includes("down")));
  const bootstrap = execute(f, ["bootstrap"]); assert.equal(bootstrap.status, 0, bootstrap.output);
  assert.ok(composeCalls(f).some((call) => call.includes("--profile bootstrap run --rm --no-deps bootstrap")));
  assert.doesNotMatch(bootstrap.output, new RegExp(canary));
});

test("public bootstrap rejects unsafe protected files before any bootstrap container consumes them", (t) => {
  for (const change of [
    (path) => { const real = `${path}.real`; copyFileSync(path, real); rmSync(path); symlinkSync(real, path); },
    (path) => chmodSync(path, 0o644),
    (path) => writeFileSync(path, "x".repeat(1024 * 1024 + 1)),
    (path) => writeFileSync(path, readFileSync(path, "utf8") + "SEED_OWNER_EMAIL=duplicate@operator.test\n"),
    (path) => writeFileSync(path, readFileSync(path, "utf8") + "NODE_OPTIONS=--inspect\n"),
  ]) {
    const f = configured(t); change(join(f.config, "bootstrap.env"));
    const run = execute(f, ["bootstrap"]); assert.notEqual(run.status, 0);
    assert.ok(f.records().some(({ args }) => args.includes("bootstrap-check")));
    assert.deepEqual(composeCalls(f), []);
    assert.doesNotMatch(run.output, new RegExp(canary));
  }
});

test("unquoted Compose dollar expressions fail before upgrade writer quiescence; quoted values remain literal", (t) => {
  for (const file of ["runtime.env", "backup.env"]) {
    const f = configured(t); backup(f); const target = targetBundle(f, "0.1.0-beta.19");
    const path = join(f.config, file); const key = file === "runtime.env" ? "SMTP_PASSWORD" : "MYSKILLS_RECOVERY_BACKUP_S3_SECRET_ACCESS_KEY";
    const original = readFileSync(path, "utf8");
    for (const value of ["$NAME", "${NAME}", "literal$$value"]) {
      writeFileSync(path, original.replace(new RegExp(`^${key}=.*$`, "m"), () => `${key}=${value}`));
      assert.notEqual(execute(f, ["upgrade", target, "--accept-forward-migrations"]).status, 0);
      assert.deepEqual(composeCalls(f), [], "validation must precede pull and stop");
    }
    writeFileSync(path, original.replace(new RegExp(`^${key}=.*$`, "m"), () => `${key}='$NAME${"${NAME}"}$$'`));
    assert.equal(execute(f, file === "runtime.env" ? ["preflight"] : ["backup", "config"]).status, 0);
  }
});

test("protected input uses a nofollow descriptor and reads the validated inode after final-component replacement", (t) => {
  for (const when of ["before-open", "after-open"]) {
    const f = fixture(t); const replacement = join(f.root, "replacement.json");
    writeFileSync(replacement, JSON.stringify(when === "before-open" ? answers : { ...answers, APP_BASE_URL: "http://unsafe.operator.test" }), { mode: when === "before-open" ? 0o600 : 0o644 });
    writeFileSync(f.replacement, JSON.stringify({ path: f.answers, replacement, when }));
    const run = execute(f, ["setup", "--answers-file", f.answers]);
    assert.equal(run.status === 0, when === "after-open", run.output);
    assert.equal(existsSync(join(f.config, "runtime.env")), when === "after-open");
    assert.doesNotMatch(run.output, new RegExp(canary));
  }
});

test("backup requires a protected external destination and withholds raw diagnostics", (t) => {
  const f = configured(t);
  assert.notEqual(execute(f, ["backup", "execute"]).status, 0);
  backup(f); assert.equal(execute(f, ["backup", "config"]).status, 0);
  assert.equal(execute(f, ["backup", "execute"]).status, 0);
  assert.ok(composeCalls(f).some((call) => call.includes("--profile operations run --rm --no-deps ops node scripts/run-registry-backup.mjs --execute")));
  writeFileSync(f.failure, "ps"); const diagnostic = execute(f, ["diagnostics"]);
  assert.notEqual(diagnostic.status, 0); assert.doesNotMatch(diagnostic.output, /provider-canary|DATABASE_URL=|SMTP_PASSWORD=/);
});

test("upgrade requires forward consent, pulls before quiescence, backs up before migration and retains failure receipt", (t) => {
  const f = configured(t); backup(f); const target = targetBundle(f, "0.1.0-beta.19");
  const missingConsent = execute(f, ["upgrade", target]); assert.notEqual(missingConsent.status, 0);
  assert.equal(composeCalls(f).length, 0);
  const down = targetBundle(f, "0.1.0-beta.17");
  assert.notEqual(execute(f, ["upgrade", down, "--accept-forward-migrations"]).status, 0);
  writeFileSync(f.failure, "migrate");
  const run = execute(f, ["upgrade", target, "--accept-forward-migrations"]); assert.notEqual(run.status, 0);
  const calls = composeCalls(f);
  assertOrder(calls, ["pull", "stop api web mcp-http", "--profile operations run --rm --no-deps ops node scripts/run-registry-backup.mjs --execute", "run --rm --no-deps migrate"]);
  assert.equal(calls.some((call) => call.includes("up -d --wait --no-deps api")), false);
  const receipt = JSON.parse(readFileSync(join(f.config, "upgrade-receipt.json")));
  assert.equal(receipt.status, "failed"); assert.equal(receipt.phase, "migrate-target"); assert.equal(receipt.forwardOnly, true);
  assert.doesNotMatch(JSON.stringify(receipt), new RegExp(canary));
  assert.equal(existsSync(join(f.config, "operation.lock")), false);
  assert.match(receipt.backupRunId, /2026-10-01T00-00-00.000Z_/);
});

test("one operation lock fences writer startup, setup, backup, restore and upgrades", (t) => {
  const f = configured(t); backup(f); const target = targetBundle(f, "0.1.0-beta.19");
  mkdirSync(join(f.config, "operation.lock"), { mode: 0o700 });
  for (const command of [["up"], ["bootstrap"], ["setup", "--answers-file", f.answers], ["backup", "config"], ["backup", "execute"],
    ["upgrade", target, "--accept-forward-migrations"], ["recover", "execute", "2026-10-01T00-00-00.000Z_" + "e".repeat(16), "--target-env-file", f.answers]]) {
    const run = execute(f, command); assert.notEqual(run.status, 0); assert.match(run.output, /operation holds the lock/);
    assert.equal(composeCalls(f).length, 0);
    assert.equal(existsSync(join(f.config, "operation.lock")), true, "a refused child must not remove another operation's lock");
  }
});

test("failed target startup leaves a durable barrier and permits only the exact target retry", (t) => {
  const f = configured(t); backup(f); const target = targetBundle(f, "0.1.0-beta.19");
  writeFileSync(f.failure, "ready-api");
  assert.notEqual(execute(f, ["upgrade", target, "--accept-forward-migrations"]).status, 0);
  const barrier = JSON.parse(readFileSync(join(f.config, "migration-barrier.json")));
  assert.equal(barrier.source.source.commit, commit); assert.equal(barrier.target.source.commit, "d".repeat(40));
  assert.equal(JSON.parse(readFileSync(join(f.config, "state.json"))).source.commit, "d".repeat(40));
  rmSync(f.failure); rmSync(f.log);
  for (const command of [["up"], ["bootstrap"]]) {
    const denied = execute(f, command); assert.notEqual(denied.status, 0); assert.match(denied.output, /exact target bundle/);
    assert.equal(composeCalls(f).length, 0);
  }
  const retry = spawnSync("sh", [join(target, "myskills.sh"), "up", "--config-dir", f.config], { env: { PATH: `${f.bin}:${process.env.PATH}` }, encoding: "utf8" });
  assert.equal(retry.status, 0, retry.stdout + retry.stderr);
});

test("a later upgrade interrupted between barrier and state writes remains exact-target retryable", (t) => {
  const f = configured(t); backup(f); const target = targetBundle(f, "0.1.0-beta.19");
  const source = JSON.parse(readFileSync(join(f.config, "state.json")));
  writeFileSync(join(f.config, "migration-barrier.json"), JSON.stringify({ schemaVersion: 1,
    source: { ...source, source: { version: "0.1.0-beta.17", commit: "b".repeat(40) } }, target: source }), { mode: 0o600 });
  writeFileSync(f.failure, "ready-api");
  assert.notEqual(execute(f, ["upgrade", target, "--accept-forward-migrations"]).status, 0);
  // A stopped process after the new barrier write still has its previous state.
  writeFileSync(join(f.config, "state.json"), JSON.stringify(source), { mode: 0o600 });
  rmSync(f.failure); rmSync(f.log);
  assert.notEqual(execute(f, ["up"]).status, 0);
  assert.equal(composeCalls(f).length, 0);
  const retry = spawnSync("sh", [join(target, "myskills.sh"), "up", "--config-dir", f.config], { env: { PATH: `${f.bin}:${process.env.PATH}` }, encoding: "utf8" });
  assert.equal(retry.status, 0, retry.stdout + retry.stderr);
  assert.equal(JSON.parse(readFileSync(join(f.config, "state.json"))).source.commit, "d".repeat(40));
  const receipt = JSON.parse(readFileSync(join(f.config, "upgrade-receipt.json")));
  assert.equal(receipt.status, "passed"); assert.ok(receipt.backupRunId);
});

test("barrier and state file/directory fsync precede SQL, including replacement on a second upgrade", (t) => {
  for (const second of [false, true]) {
    const f = configured(t); backup(f); const target = targetBundle(f, "0.1.0-beta.19");
    if (second) {
      const state = JSON.parse(readFileSync(join(f.config, "state.json")));
      writeFileSync(join(f.config, "migration-barrier.json"), JSON.stringify({ schemaVersion: 1, source: { ...state, source: { version: "0.1.0-beta.17", commit: "b".repeat(40) } }, target: state }), { mode: 0o600 });
    }
    rmSync(f.syncLog, { force: true });
    assert.equal(execute(f, ["upgrade", target, "--accept-forward-migrations"]).status, 0);
    const events = readFileSync(f.syncLog, "utf8").trim().split("\n").map(JSON.parse).map(({ event, target }) => `${event}:${target}`);
    assertOrder(events, ["sync:migration-barrier.json-file", "rename:migration-barrier.json", "sync:migration-barrier.json-directory",
      "sync:state.json-file", "rename:state.json", "sync:state.json-directory", "sql:migrate"]);
  }
});

test("file or directory fsync failure in either durable fence prevents target SQL", (t) => {
  for (const failure of ["migration-barrier.json-file", "migration-barrier.json-directory", "state.json-file", "state.json-directory"]) {
    const f = configured(t); backup(f); const target = targetBundle(f, "0.1.0-beta.19");
    writeFileSync(f.syncFailure, failure);
    assert.notEqual(execute(f, ["upgrade", target, "--accept-forward-migrations"]).status, 0);
    assert.ok(readFileSync(f.syncLog, "utf8").trim().split("\n").map(JSON.parse).some((event) => event.event === "sync" && event.target === failure), "the intended sync failure must be reached");
    assert.equal(composeCalls(f).some((call) => call.includes("run --rm --no-deps migrate")), false);
    assert.equal(existsSync(join(f.config, "operation.lock")), false);
    if (failure.startsWith("migration-barrier")) assert.equal(JSON.parse(readFileSync(join(f.config, "state.json"))).source.commit, commit);
  }
});

test("standalone backup cannot attach to an unrelated upgrade receipt; pre-migration failure leaves no barrier", (t) => {
  const f = configured(t); backup(f); const target = targetBundle(f, "0.1.0-beta.19");
  writeFileSync(f.failure, "pull"); assert.notEqual(execute(f, ["upgrade", target, "--accept-forward-migrations"]).status, 0);
  assert.equal(existsSync(join(f.config, "migration-barrier.json")), false);
  const before = readFileSync(join(f.config, "upgrade-receipt.json"), "utf8");
  rmSync(f.failure); assert.equal(execute(f, ["backup", "execute"]).status, 0);
  assert.equal(readFileSync(join(f.config, "upgrade-receipt.json"), "utf8"), before);
  assert.equal(existsSync(join(f.config, "operation.lock")), false);
});

test("partial setup preserves existing protected files and cleans its operation lock", (t) => {
  const f = fixture(t); mkdirSync(f.config, { mode: 0o700 });
  writeFileSync(join(f.config, "bootstrap.env"), "existing-fixture", { mode: 0o600 });
  assert.notEqual(execute(f, ["setup", "--answers-file", f.answers]).status, 0);
  assert.equal(readFileSync(join(f.config, "bootstrap.env"), "utf8"), "existing-fixture");
  assert.equal(existsSync(join(f.config, "runtime.env")), false); assert.equal(existsSync(join(f.config, "operation.lock")), false);
});

test("stale backup and source image drift fail before target migration", (t) => {
  const f = configured(t); backup(f); const target = targetBundle(f, "0.1.0-beta.19");
  writeFileSync(f.failure, "image-drift");
  assert.notEqual(execute(f, ["upgrade", target, "--accept-forward-migrations"]).status, 0);
  assert.equal(composeCalls(f).some((call) => call.includes("stop api")), false);
  rmSync(f.log); writeFileSync(f.failure, "stale-backup");
  const status = execute(f, ["status", "--json"]); assert.equal(status.status, 0); assert.equal(JSON.parse(status.stdout).backup.state, "stale");
  rmSync(f.log);
  assert.notEqual(execute(f, ["upgrade", target, "--accept-forward-migrations"]).status, 0);
  assert.equal(composeCalls(f).some((call) => call.includes("run --rm --no-deps migrate")), false);
  assert.equal(existsSync(join(f.config, "migration-barrier.json")), false);
});

test("status JSON reports only observed source, digest health and backup freshness", (t) => {
  const f = configured(t); const run = execute(f, ["status", "--json"]); assert.equal(run.status, 0, run.output);
  const receipt = JSON.parse(run.stdout); assert.equal(receipt.kind, "myskills-operator-status"); assert.equal(receipt.source.commit, commit);
  assert.equal(receipt.images.api.health, "healthy"); assert.equal(receipt.images.api.actualRef, `registry.operator.test/myskills/api@sha256:${digest}`);
  assert.equal(receipt.images.mcp.health, "disabled"); assert.equal(receipt.images.ops.health, "tool"); assert.equal(receipt.backup.state, "not-configured");
  assert.doesNotMatch(run.output, /SMTP_PASSWORD|DATABASE_URL|private\/|provider-canary/);
  backup(f); const checked = execute(f, ["status", "--json"]); assert.equal(JSON.parse(checked.stdout).backup.state, "current");
});

test("recovery plan stays read-only and execute is explicit Linux-only guarded restore", (t) => {
  const f = configured(t); backup(f);
  const plan = execute(f, ["recover", "plan"]); assert.equal(plan.status, 0, plan.output);
  assert.match(plan.output, /new empty loopback/); assert.equal(composeCalls(f).length, 0);
  const run = execute(f, ["recover", "execute", "2026-10-01T00-00-00.000Z_" + "e".repeat(16), "--target-env-file", f.answers]);
  assert.notEqual(run.status, 0, "the answer file is not a destination configuration");
  assert.equal(f.records().some((record) => record.args.includes("--network") && record.args.includes("host")), false);
});

test("recovery executes exactly the quoted values validated by preflight using explicit host networking", (t) => {
  const f = configured(t); backup(f);
  writeFileSync(join(f.bin, "uname"), "#!/bin/sh\ncase \"$1\" in -s) echo Linux ;; *) echo x86_64 ;; esac\n", { mode: 0o755 });
  const backupPath = join(f.config, "backup.env");
  writeFileSync(backupPath, readFileSync(backupPath, "utf8").split("\n").filter(Boolean).map((line) => {
    const i = line.indexOf("="); return `${line.slice(0,i)}='${line.slice(i+1)}'`;
  }).join("\n") + "\n");
  const target = join(f.root, "restore.env");
  writeFileSync(target, "MYSKILLS_RECOVERY_DESTINATION_POSTGRES_URL='postgres://fixture:password$kept@127.0.0.1:5432/fixture_test'\nMYSKILLS_RECOVERY_DESTINATION_S3_ENDPOINT='http://127.0.0.1:9900'\nMYSKILLS_RECOVERY_DESTINATION_S3_BUCKET='restore-fixture'\nMYSKILLS_RECOVERY_DESTINATION_S3_ACCESS_KEY_ID='restore-user'\nMYSKILLS_RECOVERY_DESTINATION_S3_SECRET_ACCESS_KEY='private$key'\n", { mode: 0o600 });
  const id = "2026-10-01T00-00-00.000Z_" + "e".repeat(16);
  const run = execute(f, ["recover", "execute", id, "--target-env-file", target]); assert.equal(run.status, 0, run.output);
  const observed = JSON.parse(readFileSync(join(f.root, "recovery-child.json")));
  assert.equal(observed.MYSKILLS_RECOVERY_DESTINATION_S3_SECRET_ACCESS_KEY, "private$key");
  assert.equal(observed.MYSKILLS_RECOVERY_DESTINATION_POSTGRES_URL, "postgres://fixture:password$kept@127.0.0.1:5432/fixture_test");
  assert.equal(observed.MYSKILLS_BACKUP_INSTANCE_ID, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
  const invocation = f.records().find((r) => r.args.includes("recovery-execute"));
  assert.ok(invocation.args.includes("--network") && invocation.args.includes("host"));
  assert.equal(invocation.args.includes("--env-file"), false);
  assert.doesNotMatch(run.output, /password\$kept|private\$key/);
  assert.equal(existsSync(join(f.config, "operation.lock")), false);
});

test("unsafe restore destinations fail before the guarded restore child receives configuration", (t) => {
  for (const invalid of ["database", "storage", "source-bucket"]) {
    const f = configured(t); backup(f);
    writeFileSync(join(f.bin, "uname"), "#!/bin/sh\ncase \"$1\" in -s) echo Linux ;; *) echo x86_64 ;; esac\n", { mode: 0o755 });
    const sourceBucket = readFileSync(join(f.config, "runtime.env"), "utf8").match(/^S3_BUCKET='([^']+)'/m)[1];
    const target = join(f.root, "restore.env");
    writeFileSync(target, [
      `MYSKILLS_RECOVERY_DESTINATION_POSTGRES_URL=postgres://fixture:fixture@${invalid === "database" ? "remote.operator.test" : "127.0.0.1"}/fixture_test`,
      `MYSKILLS_RECOVERY_DESTINATION_S3_ENDPOINT=${invalid === "storage" ? "https://remote.operator.test" : "http://127.0.0.1:9900"}`,
      `MYSKILLS_RECOVERY_DESTINATION_S3_BUCKET=${invalid === "source-bucket" ? sourceBucket : "restore-fixture"}`,
      "MYSKILLS_RECOVERY_DESTINATION_S3_ACCESS_KEY_ID=fixture-user", "MYSKILLS_RECOVERY_DESTINATION_S3_SECRET_ACCESS_KEY=fixture-only-secret", "",
    ].join("\n"), { mode: 0o600 });
    const run = execute(f, ["recover", "execute", "2026-10-01T00-00-00.000Z_" + "e".repeat(16), "--target-env-file", target]);
    assert.notEqual(run.status, 0);
    assert.equal(existsSync(join(f.root, "recovery-child.json")), false);
    assert.equal(f.records().some((record) => record.args.includes("recovery-execute")), false);
    assert.equal(existsSync(join(f.config, "operation.lock")), false);
    assert.doesNotMatch(run.output, /fixture-only-secret|remote\.operator\.test/);
  }
});

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "myskills-operator-test-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = { root: dir, bundle: join(dir, "bundle"), config: join(dir, "private"), bin: join(dir, "bin"), answers: join(dir, "answers.json"), log: join(dir, "docker.jsonl"), failure: join(dir, "failure"),
    syncLog: join(dir, "sync.jsonl"), syncFailure: join(dir, "sync-failure"), replacement: join(dir, "replace-input.json") };
  mkdirSync(f.bundle); mkdirSync(f.bin); makeBundle(f.bundle, version); writeFileSync(f.answers, JSON.stringify(answers), { mode: 0o600 });
  const preload = join(dir, "child-preload.mjs");
  writeFileSync(preload, `import cp from 'node:child_process';import fs from 'node:fs';import {basename} from 'node:path';import {syncBuiltinESMExports} from 'node:module';
const original=cp.spawnSync;cp.spawnSync=(command,args,options)=>{if(args?.[0]?.endsWith('/restore-registry-backup.mjs')){fs.writeFileSync(${JSON.stringify(join(dir,"recovery-child.json"))},JSON.stringify(options.env),{mode:384});return {status:0,stdout:JSON.stringify({passed:true,runId:args[2]})+'\\n',stderr:''};}return original(command,args,options);};
const open=fs.openSync,close=fs.closeSync,sync=fs.fsyncSync,rename=fs.renameSync;const paths=new Map();let renamed;
const record=(event,target)=>fs.appendFileSync(${JSON.stringify(f.syncLog)},JSON.stringify({event,target})+'\\n');
const rp=${JSON.stringify(f.replacement)};let change=fs.existsSync(rp)?JSON.parse(fs.readFileSync(rp)):null;
fs.openSync=(path,...args)=>{const action=change&&path===change.path?change:null;if(action)change=null;if(action?.when==='before-open'){fs.unlinkSync(rp);fs.unlinkSync(path);fs.symlinkSync(action.replacement,path);}const fd=open(path,...args);paths.set(fd,String(path));if(action?.when==='after-open'){fs.unlinkSync(rp);rename(action.replacement,path);}return fd;};
fs.closeSync=(fd)=>{paths.delete(fd);return close(fd);};
fs.renameSync=(from,to)=>{record('rename',basename(to));renamed=basename(to);return rename(from,to);};
fs.fsyncSync=(fd)=>{const path=paths.get(fd);const target=fs.fstatSync(fd).isDirectory()?renamed+'-directory':basename(path).replace(/\\.[a-f0-9]{16}\\.tmp$/,'')+'-file';record('sync',target);if(fs.existsSync(${JSON.stringify(f.syncFailure)})&&fs.readFileSync(${JSON.stringify(f.syncFailure)},'utf8')===target)throw new Error('injected-sync-failure');return sync(fd);};syncBuiltinESMExports();`);
  writeFileSync(join(f.bin, "docker"), `#!${process.execPath}\nimport {appendFileSync,existsSync,readFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';\nconst args=process.argv.slice(2);appendFileSync(${JSON.stringify(f.log)},JSON.stringify({args})+'\\n');if(args[0]==='compose'&&args.includes('run')&&args.includes('migrate'))appendFileSync(${JSON.stringify(f.syncLog)},JSON.stringify({event:'sql',target:'migrate'})+'\\n');\nif(args[0]==='run' && args.includes('/app/deploy/self-host/configure.mjs')){let cmd=args.slice(args.indexOf('/app/deploy/self-host/configure.mjs')+1);const mounts=[];for(let i=0;i<args.length;i++)if(args[i]==='--mount') {const fields=Object.fromEntries(args[i+1].split(',').map(v=>v.split('=')));mounts.push(fields);}cmd=cmd.map(v=>{for(const m of mounts)if(v===m.target||v.startsWith(m.target+'/'))return m.source+v.slice(m.target.length);return v;});const result=spawnSync(process.execPath,["--import",${JSON.stringify(preload)},${JSON.stringify(join(root, "deploy/self-host/configure.mjs"))},...cmd],{stdio:'inherit',env:process.env});process.exit(result.status??1);}\nconst fail=existsSync(${JSON.stringify(f.failure)})?readFileSync(${JSON.stringify(f.failure)},'utf8'):'';if(fail && (fail==='ready-api'?args.includes('up')&&args.includes('api'):args.some(a=>a===fail) && (fail!=='migrate'||args.includes('run')))){console.error('provider-canary DATABASE_URL=secret');process.exit(1);}\nconst ids={api:'111111111111',web:'222222222222',minio:'333333333333',postgres:'444444444444','mcp-http':'555555555555'};if(args.includes('ps')) {if(args.includes('-q'))console.log(ids[args.at(-1)]);else console.log('myskills-fixture api running');}if(args[0]==='inspect'){let service=Object.keys(ids).find(k=>ids[k]===args.at(-1));if(service==='mcp-http')service='mcp';console.log('registry.operator.test/myskills/'+service+'@sha256:'+(fail==='image-drift'?'f'.repeat(64):'${digest}')+(args.includes('{{.Config.Image}}')?'':' healthy'));}if(args.includes('scripts/run-registry-backup.mjs'))console.log(JSON.stringify({schemaVersion:1,passed:fail!=='stale-backup',reason:fail==='stale-backup'?'stale':'current',runId:'2026-10-01T00-00-00.000Z_${"e".repeat(16)}',capturedAt:new Date().toISOString()}));if(args.includes('exec'))console.log('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');if(args[0]==='context')console.log('unix:///var/run/docker.sock');if(args[0]==='info')console.log('linux/amd64');\n`, { mode: 0o755 });
  f.records = () => existsSync(f.log) ? readFileSync(f.log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  return f;
}
function makeBundle(dir, bundleVersion) {
  for (const name of ["myskills.sh", ".env.example", ".env.bootstrap.example"]) copyFileSync(join(root, "deploy/self-host", name), join(dir, name));
  writeFileSync(join(dir, "compose.yml"), "services: {}\n"); writeFileSync(join(dir, "release.env"), releaseEnv(bundleVersion));
  const source = { commit: bundleVersion === version ? commit : "d".repeat(40), version: bundleVersion };
  const images = Object.fromEntries(["api", "web", "mcp", "ops", "minio", "postgres"].map((name) => {
    const ref = `registry.operator.test/myskills/${name}@sha256:${digest}`;
    const platforms = ["linux/amd64", "linux/arm64"].map((platform) => {
      const file = `${name}-${platform.split("/")[1]}.json`;
      const proof = { schemaVersion: 1, imageRef: ref, platformDigest: `sha256:${digest}`, platform, kind: "oci-manifest", status: "passed",
        ...(name === "postgres" ? { upstreamVersion: "17-alpine" } : { labels: { "org.opencontainers.image.revision": source.commit, "org.opencontainers.image.version": source.version } }) };
      const bytes = JSON.stringify(proof) + "\n"; writeFileSync(join(dir, file), bytes);
      return { platform, digest: `sha256:${digest}`, manifestEvidence: { file, sha256: createHash("sha256").update(bytes).digest("hex") }, runtimeEvidence: null };
    });
    return [name, { ref, platforms }];
  }));
  writeFileSync(join(dir, "release-manifest.json"), JSON.stringify({ schemaVersion: 1, source, images }));
  sums({ bundle: dir });
}

function releaseEnv(v = version) { return ["api", "web", "mcp", "ops", "minio", "postgres"].map((name) => `MYSKILLS_${name.toUpperCase()}_IMAGE=registry.operator.test/myskills/${name}@sha256:${digest}`).join("\n") + `\nMYSKILLS_SOURCE_COMMIT=${v === version ? commit : "d".repeat(40)}\nMYSKILLS_VERSION=${v}\n`; }
function sums(f) { const names = ["myskills.sh", ".env.example", ".env.bootstrap.example", "compose.yml", "release.env", "release-manifest.json", ...["api", "web", "mcp", "ops", "minio", "postgres"].flatMap((name) => ["amd64", "arm64"].map((cpu) => `${name}-${cpu}.json`))].sort(); writeFileSync(join(f.bundle, "SHA256SUMS"), names.map((name) => `${createHash("sha256").update(readFileSync(join(f.bundle, name))).digest("hex")}  ${name}\n`).join("")); }
function execute(f, args) { const run = spawnSync("sh", [join(f.bundle, "myskills.sh"), ...args, "--config-dir", f.config], { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, FAKE_DOCKER_LOG: f.log, FAKE_DOCKER_FAILURE: f.failure }, encoding: "utf8" }); return { ...run, output: `${run.stdout ?? ""}${run.stderr ?? ""}` }; }
function configured(t) { const f = fixture(t); const run = execute(f, ["setup", "--answers-file", f.answers]); assert.equal(run.status, 0, run.output); rmSync(f.log); return f; }
function composeCalls(f) { return f.records().filter((record) => record.args[0] === "compose").map((record) => record.args.slice(record.args.indexOf(join(f.config, "runtime.env")) + 1).join(" ")); }
function assertOrder(calls, fragments) { let position = -1; for (const fragment of fragments) { const next = calls.findIndex((call, index) => index > position && call.includes(fragment)); assert.ok(next > position, `${fragment} missing or out of order: ${JSON.stringify(calls)}`); position = next; } }
function backup(f) { writeFileSync(join(f.config, "backup.env"), "MYSKILLS_BACKUP_INSTANCE_ID=eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee\nMYSKILLS_RECOVERY_BACKUP_S3_ENDPOINT=https://backup.operator.test\nMYSKILLS_RECOVERY_BACKUP_S3_BUCKET=external-backup\nMYSKILLS_RECOVERY_BACKUP_S3_ACCESS_KEY_ID=backup-user\nMYSKILLS_RECOVERY_BACKUP_S3_SECRET_ACCESS_KEY=" + canary + "\n", { mode: 0o600 }); }
function targetBundle(f, v) { const path = join(f.root, v); mkdirSync(path); makeBundle(path, v); return path; }

test("public exact-target up durably retries both fences before SQL and repeated sync failures stop SQL", (t) => {
  for (const point of ["migration-barrier.json-file", "migration-barrier.json-directory", "state.json-file", "state.json-directory", null]) {
    const f = configured(t); backup(f); const target = targetBundle(f, "0.1.0-beta.19");
    writeFileSync(f.syncFailure, "state.json-file");
    assert.notEqual(execute(f, ["upgrade", target, "--accept-forward-migrations"]).status, 0);
    if (point) writeFileSync(f.syncFailure, point); else rmSync(f.syncFailure);
    writeFileSync(f.syncLog, ""); writeFileSync(f.log, "");
    const retried = execute({ ...f, bundle: target }, ["up"]);
    const events = readFileSync(f.syncLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    if (point) { assert.notEqual(retried.status, 0); assert.equal(events.some(e => e.event === "sql"), false, point); }
    else { assert.equal(retried.status, 0, retried.output); const sql = events.findIndex(e => e.event === "sql"); assert.ok(sql > 0);
      assert.deepEqual(events.slice(0, sql).map(e => [e.event, e.target]), [["sync", "migration-barrier.json-file"], ["rename", "migration-barrier.json"], ["sync", "migration-barrier.json-directory"], ["sync", "state.json-file"], ["rename", "state.json"], ["sync", "state.json-directory"]]); }
  }
});
