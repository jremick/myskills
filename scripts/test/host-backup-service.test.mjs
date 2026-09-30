import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertHostCommandSucceeded, hostCommandFailure, prepareHostBackupService } from "../lib/host-backup-service.mjs";
import { hostDocker, saveHostLedger } from "../lib/host-rehearsal-resources.mjs";

function fixture(t, fail = false) {
  const proof = mkdtempSync(join(tmpdir(), "host-backup-source-")); t.after(() => rmSync(proof, { recursive: true, force: true }));
  const owner = "hc-0123456789abcdef", ledgerPath = join(proof, "ledger.json"), commands = [];
  saveHostLedger(ledgerPath, { schemaVersion: 1, owner, sequence: 0, resources: [] });
  const executable = join(proof, "docker");
  // Models Docker's default-IPAM contract and its real create-response boundary.
  writeFileSync(executable, `#!${process.execPath}\nconst a=process.argv.slice(2);if(a.includes('--ip')||${fail}){process.stderr.write('daemon rejected request fixture-password https://secret.invalid');process.exit(1);}if(a[0]==='container')process.exit(1);process.stdout.write('a'.repeat(64));\n`, { mode: 0o755 });
  const update = work => { const ledger = JSON.parse(readFileSync(ledgerPath)); work(ledger); saveHostLedger(ledgerPath, ledger); };
  return { proof, owner, ledgerPath, commands, image: "fixture-minio", user: "fixture-user", password: "fixture-password$HOST_INTERPOLATION_PROBE$$",
    reserve: (kind, name) => update(ledger => ledger.resources.push({ kind, name, state: "creating" })),
    mark: (kind, name) => update(ledger => { ledger.resources.find(row => row.kind === kind && row.name === name).state = "created"; }),
    docker: args => { commands.push(args); return { status: 0 }; },
    call: (command, args) => { commands.push([command, ...args]); writeFileSync(join(proof, "certs/private.key"), "synthetic-key"); writeFileSync(join(proof, "certs/public.crt"), "synthetic-certificate"); },
    runService: (role, args, image, tail) => {
      const command = ["run", "-d", "--label", `io.myskills.host-rehearsal.role=${role}`, ...args, image, ...tail]; commands.push(command);
      const result = hostDocker(ledgerPath, executable, command, { encoding: "utf8" }); assertHostCommandSucceeded("docker", command, result);
    } };
}

test("backup setup reserves ownership before launch and aligns DNS, TLS and literal credentials without static IP", t => {
  const f = fixture(t), service = prepareHostBackupService(f);
  const create = f.commands.find(args => args[0] === "network"), run = f.commands.find(args => args[0] === "run"), cert = f.commands.find(args => args[0] === "openssl");
  assert.equal(create.at(-1), service.network);
  assert.equal(run.includes("--ip"), false);
  assert.equal(run[run.indexOf("--network-alias") + 1], service.hostname);
  assert.ok(cert.includes(`subjectAltName=DNS:${service.hostname}`));
  assert.equal(service.endpoint, `https://${service.hostname}:9000`);
  assert.equal(readFileSync(join(f.proof, "backup-minio.env"), "utf8"), `MINIO_ROOT_USER=${f.user}\nMINIO_ROOT_PASSWORD=${f.password}\n`);
  const ledger = JSON.parse(readFileSync(f.ledgerPath));
  assert.equal(ledger.resources.find(row => row.kind === "network").state, "created");
  assert.deepEqual(ledger.resources.find(row => row.kind === "container"), { kind: "container", name: `${f.owner}-op-1`, state: "created" });
});

test("backup launch rejection retains the uncertain owned create and exports only bounded operation diagnostics", t => {
  const f = fixture(t, true); let failure;
  assert.throws(() => prepareHostBackupService(f), error => { failure = error.hostFailure; return error.message === "bounded-command-failed"; });
  assert.equal(failure.operation, "docker.run.backup"); assert.equal(failure.exitStatus, 1);
  assert.doesNotMatch(JSON.stringify(failure), /fixture-password|secret.invalid/);
  const ledger = JSON.parse(readFileSync(f.ledgerPath));
  assert.equal(ledger.resources.find(row => row.kind === "container").state, "creating");
  assert.equal(ledger.sequence, 1);
  const ipam = hostCommandFailure("docker", ["run", "--env-file", "private.env"], { status: 125, stderr: "user specified IP address is supported only with user configured subnets PASSWORD=secret" });
  assert.equal(ipam.reason, "ipam-rejected"); assert.doesNotMatch(JSON.stringify(ipam), /PASSWORD|private.env|secret/);
  assert.deepEqual(hostCommandFailure("openssl", ["req", "-keyout", "private.key"], { status: null, signal: "SIGTERM", error: { code: "ETIMEDOUT", message: "secret" } }),
    { operation: "openssl.req", exitStatus: null, signal: "SIGTERM", processErrorCode: "ETIMEDOUT", reason: "unclassified" });
});
