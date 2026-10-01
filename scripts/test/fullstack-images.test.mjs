import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { buildFullstackImages, requireFullstackImages } from "../lib/fullstack-images.mjs";

const services = ["minio", "minio-init", "api", "mcp", "web"];
const ids = Object.fromEntries(services.map((service, index) => [service, `sha256:${String(index + 1).repeat(64)}`]));

test("image snapshot follows one successful owned build and refuses invalid or unavailable identities", async () => {
  const calls = [];
  const composeArgs = ["compose", "--project-name", "owned-project", "--file", "docker-compose.e2e.yml"];
  const run = async (command, args) => {
    calls.push({ command, args });
    return args.includes("inspect") ? ids[services.find(service => args.at(-1) === `owned-project-${service}`)] : undefined;
  };
  assert.deepEqual(await buildFullstackImages({ run, composeArgs, project: "owned-project" }), ids);
  assert.deepEqual(calls[0], { command: "docker", args: [...composeArgs, "build"] });
  assert.deepEqual(calls.slice(1).map(call => call.args.at(-1)), services.map(service => `owned-project-${service}`));
  for (const invalid of ["", "latest", "sha256:short", `${ids.api}\n${ids.web}`]) {
    await assert.rejects(buildFullstackImages({ run: async (_command, args) => args.includes("inspect") ? invalid : undefined, composeArgs, project: "owned-project" }), /built image identity is invalid/);
  }
  await assert.rejects(requireFullstackImages({ run: async () => ids.web, images: { api: ids.api } }), /frozen image is unavailable/);
  await assert.rejects(requireFullstackImages({ run: async () => { throw new Error("fixture image missing"); }, images: { api: ids.api } }), /fixture image missing/);
});

test("default invocation builds once and recreates all four fresh stacks with exact images and new endpoint/origin reads", t => {
  const fixture = runnerFixture(t);
  const result = fixture.run();
  assert.equal(result.status, 0, result.stderr);
  const records = fixture.records();
  assert.equal(records.filter(row => row.tool === "npm").length, 1, "CLI compilation stays once per invocation");
  assert.equal(records.filter(row => row.args.includes("build") && row.tool === "docker").length, 1);
  assert.equal(records.filter(row => row.args.includes("pull") && row.args[0] === "compose").length, 1);
  const ups = records.filter(row => row.args.includes("up") && !row.args.includes("--no-deps"));
  const downs = records.filter(row => row.args.includes("down"));
  const journeys = records.filter(row => row.tool === "playwright");
  assert.equal(ups.length, 4);
  assert.equal(downs.length, 4);
  assert.equal(journeys.length, 4);
  for (let i = 0; i < 4; i++) {
    assertPinned(ups[i]);
    assert.ok(ups[i].args.includes("--no-build"));
    assert.deepEqual(ups[i].args.slice(ups[i].args.indexOf("--pull"), ups[i].args.indexOf("--pull") + 2), ["--pull", "never"]);
    assert.equal(ups[i].args.at(-1), "300", "stack wait deadline is unchanged");
    assert.ok(downs[i].args.includes("--volumes") && downs[i].args.includes("--remove-orphans"));
    assert.equal(downs[i].args.at(-1), "10");
    const start = records.indexOf(ups[i]);
    const end = records.indexOf(downs[i]);
    const phase = records.slice(start, end);
    assert.equal(phase.filter(row => row.args[0] === "inspect" && row.args.at(-1).startsWith("a")).length, 2, "web endpoint reread survives origin recreation");
    assert.equal(phase.filter(row => row.args[0] === "inspect" && row.args.at(-1).startsWith("b")).length, 2, "Mailpit endpoint reread survives origin recreation");
    const reconfigure = phase.find(row => row.args.includes("--no-deps"));
    assertPinned(reconfigure);
    assert.ok(reconfigure.args.includes("--no-build"));
    assert.equal(reconfigure.env.MYSKILLS_E2E_PUBLIC_WEB_PORT, String(49120 + i * 2));
    assert.equal(journeys[i].env.MYSKILLS_E2E_BASE_URL, `http://127.0.0.1:${49120 + i * 2}`);
    assert.equal(journeys[i].env.MYSKILLS_E2E_MAILPIT_URL, `http://127.0.0.1:${49121 + i * 2}`);
    assert.ok(phase.some(row => row.tool === "routing" && row.args.at(-1) === journeys[i].env.MYSKILLS_E2E_BASE_URL));
    assert.ok(phase.some(row => row.args.includes("exec") && row.args.slice(-3).join(" ") === "nginx -s reload"));
    if (i < 3) assert.ok(end < records.indexOf(ups[i + 1]), "teardown completes before the next stack");
  }
  assert.deepEqual(journeys.map(row => row.args.slice(3)), [
    ["--grep-invert", "remote MCP connector|author feedback, immutable publication|registry plan, local CLI evaluation"],
    ["--output", join(fixture.root, "apps/web/test-results/fullstack-operational"), "fullstack/operational-journey.spec.ts"],
    ["--output", join(fixture.root, "apps/web/test-results/fullstack-improvement"), "fullstack/skill-improvement.spec.ts"],
    ["--output", join(fixture.root, "apps/web/test-results/fullstack-connector"), "mcp-oauth-connector.spec.ts"],
  ]);
  assert.deepEqual(journeys.map(row => row.env.MYSKILLS_E2E_JSON_REPORT), [undefined, ...["operational", "improvement", "connector"].map(name => join(fixture.root, `apps/web/test-results/fullstack-${name}-report.json`))]);
  assertOverrideRemoved(records);
});

test("explicit selection builds once, preserves caller ports/filters and creates only one fresh lifecycle", t => {
  const fixture = runnerFixture(t);
  const filters = ["fullstack/operational-journey.spec.ts", "--grep", "author feedback", "--retries", "0"];
  const result = fixture.run(filters, { MYSKILLS_E2E_WEB_PORT: "48123", MYSKILLS_E2E_MAILPIT_PORT: "48124" });
  assert.equal(result.status, 0, result.stderr);
  const records = fixture.records();
  assert.equal(records.filter(row => row.args.includes("build") && row.tool === "docker").length, 1);
  assert.equal(records.filter(row => row.args.includes("up")).length, 1);
  assert.equal(records.filter(row => row.args.includes("down")).length, 1);
  const journey = records.find(row => row.tool === "playwright");
  assert.deepEqual(journey.args.slice(3), filters);
  assert.equal(journey.env.MYSKILLS_E2E_BASE_URL, "http://127.0.0.1:48123");
  assert.equal(journey.env.MYSKILLS_E2E_MAILPIT_URL, "http://127.0.0.1:48124");
  assertOverrideRemoved(records);
});

test("a lost frozen image stops before the second stack without rebuilding, pulling or falling back to a tag", t => {
  const fixture = runnerFixture(t, { loseImage: true });
  const result = fixture.run();
  assert.notEqual(result.status, 0);
  const records = fixture.records();
  assert.equal(records.filter(row => row.args.includes("build") && row.tool === "docker").length, 1);
  assert.equal(records.filter(row => row.args.includes("pull") && row.args[0] === "compose").length, 1);
  assert.equal(records.filter(row => row.args.includes("up") && !row.args.includes("--no-deps")).length, 1);
  assert.equal(records.filter(row => row.args.includes("down")).length, 1);
  assert.equal(records.filter(row => row.tool === "playwright").length, 1);
  assertOverrideRemoved(records);
});

test("project image build inputs are independent of runtime phase ports", () => {
  const compose = readFileSync(resolve("docker-compose.e2e.yml"), "utf8");
  const blocks = [...compose.matchAll(/^ {2}([a-z-]+):\n([\s\S]*?)(?=^ {2}[a-z-]+:|$(?![\s\S]))/gm)];
  assert.deepEqual(blocks.filter(([, , body]) => /^ {4}build:/m.test(body)).map(([ , service]) => service), services);
  for (const [, , body] of blocks) {
    const build = body.match(/^ {4}build:\n((?:^ {6}.*(?:\n|$))+)/m)?.[1];
    if (!build) continue;
    assert.doesNotMatch(build, /PORT|MYSKILLS_E2E_|https?:/);
  }
  assert.match(compose, /args:\n {8}VITE_API_BASE_URL: \/api/);
  for (const file of ["Dockerfile.api", "Dockerfile", "Dockerfile.web", "Dockerfile.minio"]) {
    const args = readFileSync(resolve(file), "utf8").split("\n").filter(line => line.startsWith("ARG "));
    assert.ok(args.every(line => !/PORT|MYSKILLS_E2E_/.test(line)), file);
  }
});

function assertPinned(record) {
  assert.deepEqual(record.override, { services: Object.fromEntries(Object.entries(ids).map(([service, image]) => [service, { image, pull_policy: "never" }])) });
}

function assertOverrideRemoved(records) {
  const row = records.find(row => row.override);
  assert.ok(row);
  assert.equal(existsSync(row.args[row.args.lastIndexOf("--file") + 1]), false, "invocation-private image override is removed");
}

function runnerFixture(t, { loseImage = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "myskills-fullstack-images-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of ["scripts/run-fullstack-e2e.mjs", "scripts/lib/fullstack-images.mjs", "scripts/lib/fullstack-endpoints.mjs", "scripts/lib/fullstack-phases.mjs"]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    copyFileSync(resolve(file), join(root, file));
  }
  const recordPath = join(root, "calls.jsonl");
  const statePath = join(root, "state.json");
  const tool = join(root, "tool.mjs");
  writeFileSync(tool, `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const [tool, ...args] = process.argv.slice(2);
const env = Object.fromEntries(["MYSKILLS_E2E_WEB_PORT", "MYSKILLS_E2E_PUBLIC_WEB_PORT", "MYSKILLS_E2E_MAILPIT_PORT", "MYSKILLS_E2E_BASE_URL", "MYSKILLS_E2E_MAILPIT_URL", "MYSKILLS_E2E_JSON_REPORT"].map(name => [name, process.env[name]]));
let state = existsSync(${JSON.stringify(statePath)}) ? JSON.parse(readFileSync(${JSON.stringify(statePath)})) : { phase: -1, down: 0 };
const files = args.flatMap((arg, i) => arg === "--file" ? [args[i + 1]] : []);
const override = files.length > 1 ? JSON.parse(readFileSync(files.at(-1))) : undefined;
appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ tool, args, env, override }) + "\\n");
const ids = ${JSON.stringify(ids)};
if (tool === "docker") {
  if (args[0] === "image") {
    if (args.at(-1).startsWith("sha256:")) {
      if (${loseImage} && state.down > 0) process.exit(1);
      console.log(args.at(-1));
    } else console.log(ids[Object.keys(ids).find(service => args.at(-1) === process.env.MYSKILLS_E2E_COMPOSE_PROJECT + "-" + service)]);
  } else if (args.includes("up") && !args.includes("--no-deps")) state.phase++;
  else if (args.includes("down")) state.down++;
  else if (args.includes("ps") && args.includes("--quiet")) console.log((args.at(-1) === "web" ? "a" : "b").repeat(64));
  else if (args[0] === "inspect") {
    const service = args.at(-1).startsWith("a") ? "web" : "mailpit";
    const requested = service === "web" ? env.MYSKILLS_E2E_WEB_PORT : env.MYSKILLS_E2E_MAILPIT_PORT;
    console.log(JSON.stringify({ project: process.env.MYSKILLS_E2E_COMPOSE_PROJECT, service, running: true, ports: [{ HostIp: "127.0.0.1", HostPort: requested === "0" ? String(49120 + state.phase * 2 + (service === "web" ? 0 : 1)) : requested }] }));
  }
}
writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
`);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const shim = name => `#!/bin/sh\nexec '${process.execPath}' '${tool}' '${name}' "$@"\n`;
  for (const name of ["docker", "npm"]) writeFileSync(join(bin, name), shim(name), { mode: 0o755 });
  mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
  writeFileSync(join(root, "node_modules/.bin/playwright"), shim("playwright"), { mode: 0o755 });
  writeFileSync(join(root, "scripts/check-mcp-oauth-routing.mjs"), `import {spawnSync} from 'node:child_process'; const r=spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(tool)}, 'routing', ...process.argv.slice(2)]);process.exit(r.status ?? 1);`);
  const preload = join(root, "fetch.mjs");
  writeFileSync(preload, `globalThis.fetch = async url => {
    const body = url.endsWith('/totp/enroll') ? { enrollment: { factorId: 'fixture-factor', secret: 'JBSWY3DPEHPK3PXP' } }
      : url.endsWith('/totp/confirm') ? { mfa: { recoveryCodes: Array.from({length:8}, (_,i) => 'fixture-recovery-' + i) } }
      : url.endsWith('/mfa/verify') ? { token: 'fixture-verified-session', user: { mfaVerified: true } }
      : { mfaRequired: true, challengeToken: 'fixture-challenge' };
    return { ok: true, status: 200, headers: new Headers({'set-cookie':'fixture_session=value; HttpOnly'}), json: async () => body };
  };`);
  return {
    root,
    records: () => readFileSync(recordPath, "utf8").trim().split("\n").map(line => JSON.parse(line)),
    run: (filters = [], env = {}) => spawnSync(process.execPath, [join(root, "scripts/run-fullstack-e2e.mjs"), ...filters], { cwd: root, encoding: "utf8", timeout: 30_000,
      env: { PATH: `${bin}:${process.env.PATH}`, NODE_OPTIONS: `--import=${preload}`, MYSKILLS_E2E_COMPOSE_PROJECT: "myskills-ci-images-fixture", ...env } }),
  };
}
