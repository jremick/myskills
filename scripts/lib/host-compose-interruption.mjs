// A bounded canonical fault fixture. The supervised real Compose request is
// delayed until cleanup has observed absence. Only its eventual exact success
// acknowledgement can settle the outstanding creation; absence never can.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupHostLedger, hostDocker, saveHostLedger } from "./host-rehearsal-resources.mjs";

export async function rehearseComposeInterruption({ directory, owner, project, executable, image }) {
  assert.match(owner, /^hc-[a-f0-9]{16}$/); assert.equal(project, `${owner}-interrupt`);
  const ledger = join(directory, "interrupt-ledger.json"), compose = join(directory, "interrupt-compose.yml");
  const release = join(directory, "interrupt-release"), completion = join(directory, "interrupt-completion.json");
  const supervisor = join(directory, "interrupt-supervisor.mjs"), client = join(directory, "interrupt-client.mjs");
  saveHostLedger(ledger, { schemaVersion: 1, owner, sequence: 0, resources: [{ kind: "compose-project", name: project, state: "reserved" }] });
  writeFileSync(compose, `services:\n  delayed:\n    image: ${JSON.stringify(image)}\n`, { mode: 0o600 });
  writeFileSync(supervisor, `import {spawnSync} from 'node:child_process';import {existsSync,readFileSync,writeFileSync} from 'node:fs';
const l=JSON.parse(readFileSync(${JSON.stringify(ledger)}));const r=l.resources[0];const operation=r.creationOperations.at(-1).id;
const until=Date.now()+15000;while(!existsSync(${JSON.stringify(release)})&&Date.now()<until)await new Promise(done=>setTimeout(done,25));
if(!existsSync(${JSON.stringify(release)}))process.exit(1);
const result=spawnSync(${JSON.stringify(executable)},process.argv.slice(2),{encoding:'utf8',timeout:30000,maxBuffer:1048576});
writeFileSync(${JSON.stringify(completion)},JSON.stringify({owner:l.owner,project:r.name,operation,status:result.status}),{mode:384});
`, { mode: 0o600 });
  writeFileSync(client, `#!${process.execPath}
import {spawn} from 'node:child_process';spawn(process.execPath,[${JSON.stringify(supervisor)},...process.argv.slice(2)],{stdio:'ignore'}).unref();
await new Promise(done=>setTimeout(done,45000));
`, { mode: 0o700 });
  const interrupted = hostDocker(ledger, client, ["compose", "--project-name", project, "--file", compose, "create"],
    { encoding: "utf8", timeout: 1500, maxBuffer: 1024 * 1024 });
  assert.equal(interrupted.signal, "SIGTERM");
  const absent = spawnSync(executable, ["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`], { encoding: "utf8", timeout: 30_000 });
  assert.equal(absent.status, 0); assert.equal(absent.stdout.trim(), "");
  for (let attempt = 0; attempt < 2; attempt++) assert.deepEqual(cleanupHostLedger(ledger, executable), ["host-compose-project-cleanup"]);
  writeFileSync(release, "fixture-only", { mode: 0o600 });
  const until = Date.now() + 35_000;
  while (!existsSync(completion) && Date.now() < until) await new Promise((done) => setTimeout(done, 50));
  assert.ok(existsSync(completion), "exact supervised Compose acknowledgement missing");
  const result = JSON.parse(readFileSync(completion));
  assert.deepEqual(result, { owner, project, operation: 1, status: 0 });
  const listed = spawnSync(executable, ["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`], { encoding: "utf8", timeout: 30_000 });
  assert.equal(listed.status, 0); assert.match(listed.stdout.trim(), /^[a-f0-9]{12,64}$/);
  assert.deepEqual(cleanupHostLedger(ledger, executable), ["host-compose-project-cleanup"], "delayed resource removal alone must retain uncertainty");
  const settled = JSON.parse(readFileSync(ledger));
  // This fixture retains an independent completion receipt for the same request.
  // The ordinary controller has no such receipt and cannot clear uncertainty.
  assert.equal(settled.resources[0].creationOperations.length, 1);
  settled.resources[0].creationOperations[0].state = "completed";
  settled.resources[0].creationUnconfirmed = false; settled.resources[0].state = "created";
  saveHostLedger(ledger, settled);
  assert.deepEqual(cleanupHostLedger(ledger, executable), []);
  return { interruptedClient: "tested", initiallyAbsent: "reservation-retained", delayedOwnedResource: "removed-reservation-retained",
    resolution: "independent-exact-request-success-acknowledgement", cleanup: "complete" };
}

export function rehearseComposeClientInterruption({ directory, owner, project, executable, image }) {
  assert.match(owner, /^hc-[a-f0-9]{16}$/); assert.equal(project, `${owner}-interrupt-client`);
  const ledger = join(directory, "client-interrupt-ledger.json"), compose = join(directory, "client-interrupt-compose.yml");
  const acknowledgement = join(directory, "client-interrupt-ack.json"), supervisor = join(directory, "client-interrupt-supervisor.mjs");
  saveHostLedger(ledger, { schemaVersion: 1, owner, sequence: 0, resources: [{ kind: "compose-project", name: project, state: "reserved" }] });
  // One explicit container and network, no volumes/dependencies/builds. The
  // supervisor can acknowledge the complete creation set before killing the
  // actual Compose CLI in its health wait. Ordinary projects cannot assume this.
  writeFileSync(compose, `services:\n  waiting:\n    image: ${JSON.stringify(image)}\n    container_name: ${project}-waiting\n    command: ["node", "-e", "setTimeout(()=>{},120000)"]\n    healthcheck:\n      test: ["CMD", "node", "-e", "process.exit(1)"]\n      interval: 1s\n      retries: 120\n`, { mode: 0o600 });
  writeFileSync(supervisor, `#!${process.execPath}
import {spawn,spawnSync} from 'node:child_process';import {writeFileSync} from 'node:fs';
const executable=${JSON.stringify(executable)},project=${JSON.stringify(project)};
const child=spawn(executable,process.argv.slice(2),{stdio:'ignore'});const exit=new Promise(done=>child.once('exit',(status,signal)=>done({status,signal})));
const until=Date.now()+10000;let acknowledged=false;
while(Date.now()<until&&child.exitCode===null&&child.signalCode===null){
const c=spawnSync(executable,['container','inspect',project+'-waiting'],{encoding:'utf8',timeout:1000});
const n=spawnSync(executable,['network','inspect',project+'_default'],{encoding:'utf8',timeout:1000});
try{const container=JSON.parse(c.stdout)[0],network=JSON.parse(n.stdout)[0];acknowledged=c.status===0&&n.status===0&&container.State.Running&&container.Config.Labels['com.docker.compose.project']===project&&container.Config.Labels['com.docker.compose.service']==='waiting'&&network.Labels['com.docker.compose.project']===project;if(acknowledged)break;}catch{}
await new Promise(done=>setTimeout(done,100));}
child.kill('SIGTERM');const result=await exit;
writeFileSync(${JSON.stringify(acknowledgement)},JSON.stringify({owner:${JSON.stringify(owner)},project,operation:1,acknowledged,...result}),{mode:384});process.exit(1);
`, { mode: 0o700 });
  const interrupted = hostDocker(ledger, supervisor, ["compose", "--project-name", project, "--file", compose, "up", "-d", "--wait", "--no-deps"],
    { encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024 });
  assert.equal(interrupted.status, 1);
  const ack = JSON.parse(readFileSync(acknowledgement));
  assert.deepEqual({ owner: ack.owner, project: ack.project, operation: ack.operation, acknowledged: ack.acknowledged }, { owner, project, operation: 1, acknowledged: true });
  // Compose may handle TERM and exit nonzero instead of dying from the signal.
  assert.ok(ack.signal === "SIGTERM" || Number.isInteger(ack.status) && ack.status !== 0);
  for (let attempt = 0; attempt < 2; attempt++) assert.deepEqual(cleanupHostLedger(ledger, executable), ["host-compose-project-cleanup"]);
  const settled = JSON.parse(readFileSync(ledger));
  assert.equal(settled.resources[0].creationOperations.length, 1);
  settled.resources[0].creationOperations[0].state = "completed";
  settled.resources[0].creationUnconfirmed = false; settled.resources[0].state = "created";
  saveHostLedger(ledger, settled);
  assert.deepEqual(cleanupHostLedger(ledger, executable), []);
  return { actualComposeClient: "interrupted-in-health-wait", reservationAcrossCleanup: "retained",
    resolution: "independent-complete-fixture-resource-set-acknowledged-before-interruption", cleanup: "complete" };
}
