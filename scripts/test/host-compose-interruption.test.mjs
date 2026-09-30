import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { rehearseComposeClientInterruption, rehearseComposeInterruption } from "../lib/host-compose-interruption.mjs";

test("canonical interruption fixture requires delayed creation acknowledgement, preserves uncertainty and removes only its project", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "myskills-compose-fault-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const owner = "hc-0123456789abcdef", project = `${owner}-interrupt`;
  const executable = join(directory, "docker"), calls = join(directory, "calls.jsonl"), resource = join(directory, "created");
  const unrelated = join(directory, "unrelated"); writeFileSync(unrelated, "preserve");
  writeFileSync(executable, `#!${process.execPath}
import {appendFileSync,existsSync,readFileSync,unlinkSync,writeFileSync} from 'node:fs';const a=process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)},JSON.stringify({a,ledger:JSON.parse(readFileSync(${JSON.stringify(join(directory, "interrupt-ledger.json"))}))})+'\\n');
if(a[0]==='compose')writeFileSync(${JSON.stringify(resource)},'owned');
if(a[0]==='ps'&&existsSync(${JSON.stringify(resource)}))console.log('aaaaaaaaaaaa');
if(a[1]==='inspect')console.log(JSON.stringify([{Config:{Labels:{'com.docker.compose.project':${JSON.stringify(project)}}}}]));
if(a[1]==='rm'&&existsSync(${JSON.stringify(resource)}))unlinkSync(${JSON.stringify(resource)});
`); chmodSync(executable, 0o755);
  const result = await rehearseComposeInterruption({ directory, owner, project, executable, image: "fixture@sha256:" + "a".repeat(64) });
  assert.equal(result.cleanup, "complete"); assert.equal(result.resolution, "independent-exact-request-success-acknowledgement");
  const records = readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse);
  const creation = records.find(({ a }) => a[0] === "compose");
  assert.equal(creation.ledger.cleanup, "failed");
  assert.equal(creation.ledger.resources[0].creationUnconfirmed, true);
  assert.ok(records.filter(({ a }) => a.includes("--filter")).every(({ a }) => a.at(-1) === `label=com.docker.compose.project=${project}`));
  assert.equal(existsSync(resource), false); assert.equal(readFileSync(unrelated, "utf8"), "preserve");
});

test("canonical real-client fault records the full fixture creation set before interrupt and retains failed cleanup until reconciliation", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "myskills-compose-client-fault-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const owner = "hc-0123456789abcdef", project = `${owner}-interrupt-client`;
  const executable = join(directory, "docker"), resource = join(directory, "created"), calls = join(directory, "calls.jsonl");
  writeFileSync(executable, `#!${process.execPath}
import {appendFileSync,existsSync,unlinkSync,writeFileSync} from 'node:fs';const a=process.argv.slice(2);appendFileSync(${JSON.stringify(calls)},JSON.stringify(a)+'\\n');
if(a[0]==='compose'){writeFileSync(${JSON.stringify(resource)},'owned');setInterval(()=>{},10000);}
if(a[1]==='inspect'&&existsSync(${JSON.stringify(resource)}))console.log(JSON.stringify([{State:{Running:true},Config:{Labels:{'com.docker.compose.project':${JSON.stringify(project)},'com.docker.compose.service':'waiting'}},Labels:{'com.docker.compose.project':${JSON.stringify(project)}}}]));
if(a[0]==='ps'&&existsSync(${JSON.stringify(resource)}))console.log('aaaaaaaaaaaa');
if(a[1]==='rm'&&existsSync(${JSON.stringify(resource)}))unlinkSync(${JSON.stringify(resource)});
`); chmodSync(executable, 0o755);
  const result = rehearseComposeClientInterruption({ directory, owner, project, executable, image: "fixture@sha256:" + "a".repeat(64) });
  assert.equal(result.actualComposeClient, "interrupted-in-health-wait"); assert.equal(result.cleanup, "complete");
  assert.equal(existsSync(resource), false);
  const records = readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(records.some((a) => a[0] === "compose" && a.includes("--wait")));
  assert.ok(records.filter((a) => a.includes("--filter")).every((a) => a.at(-1) === `label=com.docker.compose.project=${project}`));
});
