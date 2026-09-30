import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { cleanupHostLedger, saveHostLedger } from "../lib/host-rehearsal-resources.mjs";

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
