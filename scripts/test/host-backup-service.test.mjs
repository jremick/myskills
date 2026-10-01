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
    docker: args => { commands.push(args);
      if (args[0] === "network" && args[1] === "inspect") return { stdout: JSON.stringify([{ Id: "b".repeat(64), Name: `${owner}-backup-network`, Driver: "bridge", Scope: "local", Labels: { "io.myskills.host-rehearsal": owner }, IPAM: { Config: [{ Subnet: "172.28.0.0/16", Gateway: "172.28.0.1" }] } }]) };
      if (args[0] === "container" && args[1] === "inspect") return { stdout: JSON.stringify([{ Id: "a".repeat(64), State: { Status: "running", Running: true, Paused: false, Restarting: false, ExitCode: 0, Error: "" }, Config: { Labels: { "io.myskills.host-rehearsal": owner, "io.myskills.host-rehearsal.role": "backup" } }, NetworkSettings: { Networks: { [`${owner}-backup-network`]: { NetworkID: "b".repeat(64) } }, Ports: { "9000/tcp": [{ HostIp: "172.28.0.1", HostPort: "34567" }] } } }]) };
      return { status: 0 }; },
    call: (command, args) => { commands.push([command, ...args]); writeFileSync(join(proof, "certs/private.key"), "synthetic-key"); writeFileSync(join(proof, "certs/public.crt"), "synthetic-certificate"); },
    runService: (role, args, image, tail) => {
      const command = ["run", "-d", "--label", `io.myskills.host-rehearsal.role=${role}`, ...args, image, ...tail]; commands.push(command);
      const result = hostDocker(ledgerPath, executable, command, { encoding: "utf8" }); assertHostCommandSucceeded("docker", command, result); return result.stdout.trim();
    } };
}

test("backup setup reserves ownership before launch and aligns owned gateway, port and TLS and literal credentials without static IP", t => {
  const f = fixture(t), service = prepareHostBackupService(f);
  const create = f.commands.find(args => args[0] === "network"), run = f.commands.find(args => args[0] === "run"), cert = f.commands.find(args => args[0] === "openssl");
  assert.equal(create.at(-1), service.network);
  assert.equal(run.includes("--ip"), false);
  assert.equal(run[run.indexOf("--publish") + 1], `${service.gateway}::9000`);
  assert.equal(run.includes("--network-alias"), false);
  assert.ok(cert.includes(`subjectAltName=IP:${service.gateway}`));
  assert.equal(service.endpoint, `https://${service.gateway}:34567`);
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

test("backup endpoint denies foreign network, wrong gateway, broad binding and changed ownership", t => {
  for (const [fault, reason] of [["foreign-owner", "network-identity-invalid"], ["gateway-outside", "network-gateway-outside"], ["broad-port", "port-binding-address-invalid"], ["wrong-container", "container-identity-invalid"], ["changed-network", "network-changed"], ["missing-port", "port-binding-absent"], ["exited", "container-not-running"], ["daemon-error", "container-not-running"]]) {
    const f = fixture(t); const docker = f.docker; let inspections = 0;
    f.docker = args => {
      const result = docker(args);
      if (args[1] !== "inspect") return result;
      const [row] = JSON.parse(result.stdout);
      if (args[0] === "network") {
        inspections++;
        if (fault === "foreign-owner") row.Labels["io.myskills.host-rehearsal"] = "unowned";
        if (fault === "gateway-outside") row.IPAM.Config[0].Gateway = "192.168.1.1";
        if (fault === "changed-network" && inspections === 2) row.Id = "c".repeat(64);
      } else {
        if (fault === "broad-port") row.NetworkSettings.Ports["9000/tcp"][0].HostIp = "0.0.0.0";
        if (fault === "wrong-container") row.Config.Labels["io.myskills.host-rehearsal.role"] = "driver";
        if (fault === "missing-port") row.NetworkSettings.Ports["9000/tcp"] = null;
        if (fault === "exited" || fault === "daemon-error") {
          row.State = { Status: "exited", Running: false, Paused: false, Restarting: false, ExitCode: 1,
            Error: fault === "daemon-error" ? "permission denied PASSWORD=fixture-password https://secret.invalid" : "" };
          row.NetworkSettings.Ports = {};
        }
      }
      return { stdout: JSON.stringify([row]) };
    };
    assert.throws(() => prepareHostBackupService(f), error => {
      assert.equal(error.message, "HOST_BACKUP_NETWORK_INVALID");
      assert.equal(error.hostFailure.reason, reason);
      assert.doesNotMatch(JSON.stringify(error.hostFailure), /fixture-password|PASSWORD|secret.invalid/);
      if (fault === "exited" || fault === "daemon-error") {
        assert.equal(error.hostFailure.containerStatus, "exited"); assert.equal(error.hostFailure.containerExitCode, 1);
        assert.equal(error.hostFailure.containerErrorCategory, fault === "daemon-error" ? "permission-denied" : "none");
      }
      return true;
    });
    assert.ok(f.commands.every(args => !args.includes("--ip") && !args.includes("--subnet") && !args.includes("--add-host") && !args.includes("host")));
  }
});
