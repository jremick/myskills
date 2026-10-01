import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

// Failure cases: generated full-stack credentials echoed by Docker or Compose output reach
// CI logs; a CI runner cannot name, and so cannot exactly clean up, the Compose project; an
// unsafe project name reaches the Docker CLI.
const credentialNames = [
  "MYSKILLS_E2E_AUTH_SECRET",
  "MYSKILLS_E2E_INVITEE_PASSWORD",
  "MYSKILLS_E2E_MINIO_ROOT_PASSWORD",
  "MYSKILLS_E2E_MINIO_ROOT_USER",
  "MYSKILLS_E2E_OWNER_PASSWORD",
  "MYSKILLS_E2E_POSTGRES_PASSWORD",
];

test("full-stack E2E redacts generated credentials and uses the supplied Compose project", (t) => {
  const fixture = fakeDocker(t);
  const project = "myskills-ci-fixture-web-e2e-node22";
  const result = runFullstack(fixture, { MYSKILLS_E2E_COMPOSE_PROJECT: project });
  assert.notEqual(result.status, 0, "the fake Compose up step fails, so the run must fail");

  const records = fixture.records();
  assert.ok(records.length >= 3, "config, diagnostics and teardown should all reach Docker");
  const credentials = credentialNames.map((name) => records[0].env[name]);
  assert.ok(credentials.every((value) => typeof value === "string" && value.length >= 6));
  const output = `${result.stdout}\n${result.stderr}`;
  for (const value of credentials) assert.equal(output.includes(value), false);
  assert.match(output, /\[redacted\]/);

  for (const record of records.filter(({ args }) => args[0] === "compose")) {
    assert.deepEqual(record.args.slice(0, 3), ["compose", "--project-name", project]);
  }
  assert.ok(records.some(({ args }) => args.includes("down") && args.includes("--volumes") && args.includes("--remove-orphans")));
});

test("full-stack E2E rejects an unsafe Compose project name before invoking Docker", (t) => {
  const fixture = fakeDocker(t);
  const result = runFullstack(fixture, { MYSKILLS_E2E_COMPOSE_PROJECT: "Bad Name;touch pwned" });
  assert.notEqual(result.status, 0);
  assert.deepEqual(fixture.records(), []);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /touch pwned/);
});

test("full-stack E2E preflight failure creates no stack and still redacts credentials", (t) => {
  const fixture = fakeDocker(t, "config");
  const result = runFullstack(fixture, { MYSKILLS_E2E_COMPOSE_PROJECT: "myskills-ci-preflight-failure" });
  assert.notEqual(result.status, 0);
  const records = fixture.records();
  assert.equal(records.length, 1);
  assert.ok(records[0].args.includes("config"));
  const output = `${result.stdout}\n${result.stderr}`;
  for (const name of credentialNames) assert.equal(output.includes(records[0].env[name]), false);
  assert.match(output, /\[redacted\]/);
});

test("automatic bound origin configures API/MCP before journeys and retains owned teardown on failure", t => {
  const fixture = fakeDocker(t, "reconfigure");
  const result = runFullstack(fixture, { MYSKILLS_E2E_COMPOSE_PROJECT: "myskills-ci-bound-origin" });
  assert.notEqual(result.status, 0);
  const records = fixture.records();
  const initial = records.find(({ args }) => args.includes("up") && !args.includes("--no-deps"));
  assert.equal(initial.env.MYSKILLS_E2E_WEB_PORT, "0");
  assert.equal(initial.env.MYSKILLS_E2E_MAILPIT_PORT, "0");
  const configured = records.find(({ args }) => args.includes("--no-deps"));
  assert.deepEqual(configured.args.slice(-2), ["api", "mcp"]);
  assert.equal(configured.env.MYSKILLS_E2E_PUBLIC_WEB_PORT, "49123");
  assert.equal(configured.env.MYSKILLS_E2E_BASE_URL, "http://127.0.0.1:49123");
  assert.equal(configured.env.MYSKILLS_E2E_MAILPIT_URL, "http://127.0.0.1:49124");
  assert.ok(records.filter(({ args }) => args.includes("inspect")).every(({ args }) => args.includes("--format")));
  assert.ok(records.at(-1).args.includes("down"));
});

test("full-stack E2E preserves explicit caller ports instead of probing replacements", t => {
  const fixture = fakeDocker(t);
  const result = runFullstack(fixture, { MYSKILLS_E2E_COMPOSE_PROJECT: "myskills-ci-explicit-ports", MYSKILLS_E2E_WEB_PORT: "48123", MYSKILLS_E2E_MAILPIT_PORT: "48124" });
  assert.notEqual(result.status, 0);
  assert.equal(fixture.records()[0].env.MYSKILLS_E2E_WEB_PORT, "48123");
  assert.equal(fixture.records()[0].env.MYSKILLS_E2E_PUBLIC_WEB_PORT, "48123");
  assert.equal(fixture.records()[0].env.MYSKILLS_E2E_MAILPIT_PORT, "48124");
});

test("automatic origin refresh reloads nginx without restarting or releasing the bound web container", t => {
  const fixture = fakeDocker(t, "reload");
  const result = runFullstack(fixture, { MYSKILLS_E2E_COMPOSE_PROJECT: "myskills-ci-bound-reload" });
  assert.notEqual(result.status, 0, "the injected reload failure must fail before any journey");
  const records = fixture.records();
  const reload = records.findIndex(({ args }) => args.includes("exec"));
  assert.deepEqual(records[reload].args.slice(-6), ["exec", "--no-TTY", "web", "nginx", "-s", "reload"]);
  assert.ok(records.slice(0, reload).some(({ args }) => args.includes("up") && args.includes("--no-deps") && args.slice(-2).join(" ") === "api mcp"));
  assert.ok(records.slice(0, reload).every(({ args }) => !args.includes("restart") && !args.includes("down")));
  assert.equal(records[reload].env.MYSKILLS_E2E_BASE_URL, "http://127.0.0.1:49123");
  assert.ok(records.at(-1).args.includes("down"), "a failed reload still tears down the exact owned stack");
});

function fakeDocker(t, failedStep = "up") {
  const root = mkdtempSync(join(tmpdir(), "myskills-fullstack-isolation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const recordPath = join(root, "record.jsonl");
  const script = join(root, "fake-docker.mjs");
  writeFileSync(script, `
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const names = ${JSON.stringify(credentialNames)};
const env = Object.fromEntries([...names, "MYSKILLS_E2E_WEB_PORT", "MYSKILLS_E2E_PUBLIC_WEB_PORT", "MYSKILLS_E2E_MAILPIT_PORT", "MYSKILLS_E2E_BASE_URL", "MYSKILLS_E2E_MAILPIT_URL"].map((name) => [name, process.env[name]]));
appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ args, env }) + "\\n");
if (args[0] === "image" && args[1] === "inspect") { console.log("sha256:" + "c".repeat(64)); process.exit(0); }
if (args.includes("ps") && args.includes("--quiet")) { console.log((args.at(-1) === "web" ? "a" : "b").repeat(64)); process.exit(0); }
if (args[0] === "inspect") {
  const service = args.at(-1).startsWith("a") ? "web" : "mailpit";
  console.log(JSON.stringify({ project: process.env.MYSKILLS_E2E_COMPOSE_PROJECT, service, running: true, ports: [{ HostIp: "127.0.0.1", HostPort: service === "web" ? "49123" : "49124" }] })); process.exit(0);
}
for (const name of names) {
  process.stdout.write(name + " startup banner: " + process.env[name] + "\\n");
  process.stderr.write("diagnostic " + process.env[name] + "\\n");
}
process.exit(${JSON.stringify(failedStep)} === "reconfigure" ? args.includes("up") && args.includes("--no-deps") ? 1 : 0 : ${JSON.stringify(failedStep)} === "reload" ? args.includes("exec") ? 1 : 0 : args.includes(${JSON.stringify(failedStep)}) ? 1 : 0);
`);
  writeFileSync(join(bin, "docker"), `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`, { mode: 0o755 });
  writeFileSync(join(bin, "npm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return {
    bin,
    records: () => existsSync(recordPath)
      ? readFileSync(recordPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
      : [],
  };
}

function runFullstack(fixture, env) {
  return spawnSync(process.execPath, [resolve("scripts/run-fullstack-e2e.mjs")], {
    cwd: resolve("."),
    encoding: "utf8",
    timeout: 60_000,
    env: { PATH: `${fixture.bin}:${process.env.PATH}`, HOME: process.env.HOME ?? tmpdir(), ...env },
  });
}
