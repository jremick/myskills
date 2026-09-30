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
  assert.notEqual(result.status, 0, "the fake Compose config step fails, so the run must fail");

  const records = fixture.records();
  assert.ok(records.length >= 3, "config, diagnostics and teardown should all reach Docker");
  const credentials = credentialNames.map((name) => records[0].env[name]);
  assert.ok(credentials.every((value) => typeof value === "string" && value.length >= 6));
  const output = `${result.stdout}\n${result.stderr}`;
  for (const value of credentials) assert.equal(output.includes(value), false);
  assert.match(output, /\[redacted\]/);

  for (const record of records) {
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

function fakeDocker(t) {
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
const env = Object.fromEntries(names.map((name) => [name, process.env[name]]));
appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ args, env }) + "\\n");
for (const name of names) {
  process.stdout.write(name + " startup banner: " + process.env[name] + "\\n");
  process.stderr.write("diagnostic " + process.env[name] + "\\n");
}
process.exit(args.includes("config") ? 1 : 0);
`);
  writeFileSync(join(bin, "docker"), `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`, { mode: 0o755 });
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
