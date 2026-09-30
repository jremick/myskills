import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { cleanupHostLedger, hostDocker, saveHostLedger } from "../lib/host-rehearsal-resources.mjs";

const owner = "hc-0123456789abcdef";
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "myskills-host-ledger-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledger = join(root, "ledger.json"), records = join(root, "calls.jsonl"), docker = join(root, "docker");
  saveHostLedger(ledger, { schemaVersion: 1, owner, sequence: 0, resources: [] });
  writeFileSync(docker, `#!${process.execPath}\nimport {appendFileSync,readFileSync} from 'node:fs';const a=process.argv.slice(2);const l=JSON.parse(readFileSync(${JSON.stringify(ledger)}));appendFileSync(${JSON.stringify(records)},JSON.stringify({a,l})+'\\n');if(a[1]==='inspect')console.log(JSON.stringify([{Config:{Labels:{'io.myskills.host-rehearsal':${JSON.stringify(owner)}}},Labels:{'io.myskills.host-rehearsal':${JSON.stringify(owner)}}}]));\n`);
  chmodSync(docker, 0o755);
  return { root, ledger, records, docker };
}

test("operator shim registers an exact name before Docker creates it and cleans only owned resources", (t) => {
  const f = fixture(t);
  const module = resolve("scripts/lib/host-rehearsal-resources.mjs");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import {hostDocker} from ${JSON.stringify(module)};hostDocker(${JSON.stringify(f.ledger)},${JSON.stringify(f.docker)},['run','--rm','fixture-image','node','--help']);`], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const first = JSON.parse(readFileSync(f.records, "utf8").split("\n")[0]);
  assert.equal(first.l.resources[0].state, "creating"); assert.ok(first.a.includes(`${owner}-op-1`));
  assert.deepEqual(cleanupHostLedger(f.ledger, f.docker), []);
  const calls = readFileSync(f.records, "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(calls.some(({ a }) => a.join(" ") === `container rm -f -v ${owner}-op-1`));
  assert.ok(calls.every(({ a }) => !a.includes("prune")));
  assert.equal(JSON.parse(readFileSync(f.ledger)).cleanup, "complete");
});

test("foreign ownership, unexpected names and failed cleanup stay explicit failures", (t) => {
  const f = fixture(t);
  for (const name of [`${owner}-foreign`, "another-project-container"]) {
    saveHostLedger(f.ledger, { schemaVersion: 1, owner, sequence: 0, resources: [{ kind: "container", name, state: "creating" }] });
    writeFileSync(f.docker, `#!${process.execPath}\nconst a=process.argv.slice(2);if(a[1]==='inspect')console.log(JSON.stringify([{Config:{Labels:{'io.myskills.host-rehearsal':'foreign'}}}]));else process.exit(1);\n`);
    assert.ok(cleanupHostLedger(f.ledger, f.docker).length > 0);
    assert.equal(JSON.parse(readFileSync(f.ledger)).cleanup, "failed");
  }
  saveHostLedger(f.ledger, { schemaVersion: 1, owner, sequence: 0, resources: [{ kind: "image", name: `${owner}/image:fixture`, state: "created" }] });
  assert.ok(cleanupHostLedger(f.ledger, f.docker).length > 0);
  assert.equal(JSON.parse(readFileSync(f.ledger)).resources[0].state, "remove-failed");
});

test("an interrupted Docker create cannot turn temporary absence into confirmed cleanup", (t) => {
  const f = fixture(t);
  const name = `${owner}-op-1`;
  saveHostLedger(f.ledger, { schemaVersion: 1, owner, sequence: 1, resources: [{ kind: "container", name, state: "creating" }] });
  writeFileSync(f.docker, `#!${process.execPath}\nconsole.error('No such container');process.exit(1);\n`);
  assert.deepEqual(cleanupHostLedger(f.ledger, f.docker), ["host-container-cleanup"]);
  assert.deepEqual(cleanupHostLedger(f.ledger, f.docker), ["host-container-cleanup"], "a retry must preserve the unresolved create");
  assert.equal(JSON.parse(readFileSync(f.ledger)).resources[0].creationUnconfirmed, true);
  writeFileSync(f.docker, `#!${process.execPath}\nif(process.argv[3]==='inspect')console.log(JSON.stringify([{Config:{Labels:{'io.myskills.host-rehearsal':${JSON.stringify(owner)}}}}]));\n`);
  assert.deepEqual(cleanupHostLedger(f.ledger, f.docker), [], "exact owned resource removal resolves the uncertainty");
});

test("shim and direct rehearsal Compose reserve outstanding creation before dispatch and retain delayed-daemon uncertainty", (t) => {
  for (const boundary of ["shim", "direct"]) {
    const f = fixture(t); const project = `${owner}-fresh`; const delayed = join(f.root, "delayed");
    const id = "a".repeat(64);
    saveHostLedger(f.ledger, { schemaVersion: 1, owner, sequence: 0, resources: [{ kind: "compose-project", name: project, state: "reserved" }] });
    writeFileSync(f.docker, `#!${process.execPath}
import {appendFileSync,existsSync,readFileSync} from 'node:fs';const a=process.argv.slice(2);
appendFileSync(${JSON.stringify(f.records)},JSON.stringify({a,l:JSON.parse(readFileSync(${JSON.stringify(f.ledger)}))})+'\\n');
if(a[0]==='compose')process.kill(process.pid,'SIGTERM');
if(a[0]==='ps'&&existsSync(${JSON.stringify(delayed)}))console.log(${JSON.stringify(id)});
if(a[1]==='inspect')console.log(JSON.stringify([{Config:{Labels:{'com.docker.compose.project':${JSON.stringify(project)}}}}]));
`);
    const args = ["compose", "--project-name", project, "--file", "/fixture/compose.yml", "--profile", "operations", "up", "-d"];
    if (boundary === "direct") assert.equal(hostDocker(f.ledger, f.docker, args, { encoding: "utf8" }).signal, "SIGTERM");
    else {
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", `import {hostDocker} from ${JSON.stringify(resolve("scripts/lib/host-rehearsal-resources.mjs"))};const r=hostDocker(${JSON.stringify(f.ledger)},${JSON.stringify(f.docker)},${JSON.stringify(args)});process.exit(r.status??1);`], { encoding: "utf8" });
      assert.equal(child.status, 1);
    }
    const first = JSON.parse(readFileSync(f.records, "utf8").split("\n")[0]);
    assert.deepEqual(first.l.resources[0].creationOperations, [{ id: 1, state: "creating" }]);
    for (let attempt = 0; attempt < 2; attempt++) assert.deepEqual(cleanupHostLedger(f.ledger, f.docker), ["host-compose-project-cleanup"]);
    writeFileSync(delayed, "fixture-only");
    assert.deepEqual(cleanupHostLedger(f.ledger, f.docker), ["host-compose-project-cleanup"], "visible removal cannot settle a multi-resource request");
    const final = JSON.parse(readFileSync(f.ledger));
    assert.equal(final.cleanup, "failed"); assert.equal(final.resources[0].creationUnconfirmed, true);
    assert.equal(final.resources[0].state, "remove-failed");
    const calls = readFileSync(f.records, "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(calls.some(({ a }) => a.join(" ") === `container rm -f -v ${id}`));
    assert.ok(calls.filter(({ a }) => a.includes("--filter")).every(({ a }) => a.at(-1) === `label=com.docker.compose.project=${project}`));
    assert.ok(calls.every(({ a }) => !a.includes("prune")));
  }
});

test("confirmed Compose creation cleans up; missing reservations and foreign readback cannot remove unrelated resources", (t) => {
  const f = fixture(t); const project = `${owner}-fresh`;
  const args = ["compose", "--project-name", project, "run", "--rm", "fixture"];
  assert.throws(() => hostDocker(f.ledger, f.docker, args), /reservation-invalid/);
  saveHostLedger(f.ledger, { schemaVersion: 1, owner, sequence: 0, resources: [{ kind: "compose-project", name: project, state: "reserved" }] });
  assert.equal(hostDocker(f.ledger, f.docker, args, { encoding: "utf8" }).status, 0);
  assert.equal(JSON.parse(readFileSync(f.ledger)).resources[0].creationOperations[0].state, "completed");
  assert.deepEqual(cleanupHostLedger(f.ledger, f.docker), []);
  saveHostLedger(f.ledger, { schemaVersion: 1, owner, sequence: 0, resources: [{ kind: "compose-project", name: project, state: "created" }] });
  writeFileSync(f.docker, `#!${process.execPath}
import {appendFileSync} from 'node:fs';const a=process.argv.slice(2);appendFileSync(${JSON.stringify(f.records)},JSON.stringify({a})+'\\n');
if(a[0]==='ps')console.log('aaaaaaaaaaaa');if(a[1]==='inspect')console.log(JSON.stringify([{Config:{Labels:{'com.docker.compose.project':'unrelated'}}}]));
`);
  assert.deepEqual(cleanupHostLedger(f.ledger, f.docker), ["host-compose-project-cleanup"]);
  assert.ok(readFileSync(f.records, "utf8").trim().split("\n").map(JSON.parse).every(({ a }) => !a.includes("rm")));
});
