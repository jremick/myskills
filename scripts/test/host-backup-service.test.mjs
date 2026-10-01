import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertHostCommandSucceeded, hostCommandFailure, prepareHostBackupService, observeHostPublication } from "../lib/host-backup-service.mjs";
import { hostDocker, saveHostLedger } from "../lib/host-rehearsal-resources.mjs";

function fixture(t, fail = false) {
  const proof = mkdtempSync(join(tmpdir(), "host-backup-source-")); t.after(() => rmSync(proof, { recursive: true, force: true }));
  const owner = "hc-0123456789abcdef", ledgerPath = join(proof, "ledger.json"), commands = [], diagnostics = [];
  saveHostLedger(ledgerPath, { schemaVersion: 1, owner, sequence: 0, resources: [] });
  const network = `${owner}-backup-network`, gateway = "172.28.0.1", networkId = "b".repeat(64), containerId = "a".repeat(64);
  // Synthetic Docker28-compatible shapes, not captured runtime evidence. HostConfig
  // retains the requested empty port; NetworkSettings contains the assigned port.
  const networkRow = { Id: networkId, Name: network, Driver: "bridge", Scope: "local", EnableIPv4: true, EnableIPv6: false,
    Internal: false, Attachable: false, Ingress: false, Labels: { "io.myskills.host-rehearsal": owner },
    IPAM: { Driver: "default", Options: null, Config: [{ Subnet: "172.28.0.0/16", Gateway: gateway }] },
    Options: { "com.docker.network.bridge.gateway_mode_ipv4": "nat", "com.docker.network.bridge.inhibit_ipv4": "false" }, Containers: {} };
  const containerRow = { Id: containerId, Name: `/${owner}-op-1`,
    State: { Status: "running", Running: true, Paused: false, Restarting: false, OOMKilled: false, Dead: false, Pid: 1234, ExitCode: 0, Error: "" },
    Config: { Image: "fixture-minio", ExposedPorts: { "9000/tcp": {} },
      Labels: { "io.myskills.host-rehearsal": owner, "io.myskills.host-rehearsal.role": "backup" } },
    RestartCount: 0,
    HostConfig: { NetworkMode: network, PublishAllPorts: false, PortBindings: { "9000/tcp": [{ HostIp: gateway, HostPort: "" }] } },
    NetworkSettings: { Ports: { "9000/tcp": [{ HostIp: gateway, HostPort: "34567" }] },
      Networks: { [network]: { IPAMConfig: null, Links: null, Aliases: null, DriverOpts: null,
        NetworkID: networkId, EndpointID: "c".repeat(64), Gateway: gateway, IPAddress: "172.28.0.2", IPPrefixLen: 16,
        IPv6Gateway: "", GlobalIPv6Address: "", GlobalIPv6PrefixLen: 0, DNSNames: [`${owner}-op-1`, containerId.slice(0, 12)] } } } };
  const executable = join(proof, "docker"), dispatchedPath = join(proof, "dispatched.json");
  // Models Docker's default-IPAM contract and its real create-response boundary.
  writeFileSync(executable, `#!${process.execPath}\nconst a=process.argv.slice(2);require('node:fs').writeFileSync(${JSON.stringify(dispatchedPath)},JSON.stringify(a));if(a.includes('--ip')||${fail}){process.stderr.write('daemon rejected request fixture-password https://secret.invalid');process.exit(1);}if(a[0]==='container')process.exit(1);process.stdout.write('a'.repeat(64));\n`, { mode: 0o755 });
  const update = work => { const ledger = JSON.parse(readFileSync(ledgerPath)); work(ledger); saveHostLedger(ledgerPath, ledger); };
  networkRow.Containers[containerId] = { EndpointID: "c".repeat(64), Name: `${owner}-op-1` };
  return { proof, owner, ledgerPath, dispatchedPath, commands, diagnostics, networkRow, containerRow, image: "fixture-minio", user: "fixture-user", password: "fixture-password$HOST_INTERPOLATION_PROBE$$",
    reserve: (kind, name) => update(ledger => ledger.resources.push({ kind, name, state: "creating" })),
    mark: (kind, name) => update(ledger => { ledger.resources.find(row => row.kind === kind && row.name === name).state = "created"; }),
    docker: args => { commands.push(args);
      if (args[0] === "network" && args[1] === "inspect") return { stdout: JSON.stringify([networkRow]) };
      if (args[0] === "container" && args[1] === "inspect") return { stdout: JSON.stringify([containerRow]) };
      return { status: 0 }; },
    call: (command, args) => { commands.push([command, ...args]); writeFileSync(join(proof, "certs/private.key"), "synthetic-key"); writeFileSync(join(proof, "certs/public.crt"), "-----BEGIN CERTIFICATE-----\ncHVibGljLWZpeHR1cmU=\n-----END CERTIFICATE-----\n"); },
    runService: (role, args, image, tail, contract) => {
      const command = ["run", "-d", "--label", `io.myskills.host-rehearsal.role=${role}`, ...args, image, ...tail]; commands.push(command);
      const result = hostDocker(ledgerPath, executable, command, { encoding: "utf8" }, { contract, record: value => diagnostics.push(value) }); assertHostCommandSucceeded("docker", command, result); return result.stdout.trim();
    } };
}

test("backup setup reserves ownership before launch and aligns owned gateway, port and TLS and literal credentials without static IP", t => {
  const f = fixture(t), service = prepareHostBackupService(f);
  const create = f.commands.find(args => args[0] === "network"), run = f.commands.find(args => args[0] === "run"), cert = f.commands.find(args => args[0] === "openssl");
  assert.equal(create.at(-1), service.network);
  assert.deepEqual(create, ["network", "create", "--driver", "bridge", "--internal=false", "--ipv4=true",
    "--opt", "com.docker.network.bridge.gateway_mode_ipv4=nat", "--opt", "com.docker.network.bridge.inhibit_ipv4=false",
    "--label", `io.myskills.host-rehearsal=${f.owner}`, service.network]);
  assert.equal(run.includes("--ip"), false);
  assert.equal(run[run.indexOf("--publish") + 1], `${service.gateway}::9000`);
  assert.equal(run.includes("--network-alias"), false);
  const dispatched = JSON.parse(readFileSync(f.dispatchedPath, "utf8"));
  assert.deepEqual(dispatched, ["run", "--name", `${f.owner}-op-1`, "--label", `io.myskills.host-rehearsal=${f.owner}`, ...run.slice(1)],
    "the actual hostDocker subprocess preserves the exact gateway publication and backup role");
  assert.deepEqual(f.diagnostics, [{ category: "matched", vectorMatches: true, ownershipMatches: true, networkMatches: true,
    publishCount: 1, publishMatches: true, envFileMatches: true, mountMatches: true, imagePositionMatches: true, tailMatches: true }]);
  assert.doesNotMatch(JSON.stringify(f.diagnostics), /fixture-password|fixture-user|host-backup-source|172\.28|hc-|MINIO|certs|\.env/);
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

function expectFailure(f, stage, reason, state) {
  let failure;
  assert.throws(() => prepareHostBackupService(f), error => {
    assert.equal(error.message, "HOST_BACKUP_NETWORK_INVALID");
    failure = error.hostFailure;
    const { portMetadata, bindingConsistency, ...identity } = failure;
    assert.deepEqual(identity, { operation: "docker.network.backup-endpoint", stage, reason, ...state });
    if (reason === "published-port-shape-invalid") {
      assert.deepEqual(Object.keys(portMetadata), ["networkModeCategory", "networkAttachmentCount", "endpointIPv4AddressShape", "endpointIPv4AddressValid", "endpointGatewayMatchesOwned", "endpointIDValid", "exposedMapShape", "exposedPortCount", "exposedPortShape", "requestedMapShape", "requestedPortCount", "requestedBindingsShape", "requestedBindingCount",
        "requestedObjectCount", "requestedGatewayMatchCount", "requestedHostPortCategory", "publishAllPortsCategory", "restartCount", "restartCountCapped",
        "runtimeMapShape", "runtimePortCount", "runtimeBindingsShape", "runtimeBindingCount", "runtimeObjectCount", "runtimeGatewayMatchCount", "runtimeValidPortCount"]);
      for (const [key, value] of Object.entries(portMetadata)) {
        if (key === "networkModeCategory") assert.ok(["owned-bridge", "missing", "host", "none", "bridge", "default", "other"].includes(value));
        else if (key === "requestedHostPortCategory") assert.ok(["unavailable", "no-rows", "multiple-rows", "invalid-row", "expected-empty", "missing", "assigned", "invalid"].includes(value));
        else if (key === "publishAllPortsCategory") assert.ok(["disabled", "enabled", "missing", "invalid"].includes(value));
        else if (key.endsWith("Shape")) assert.ok(["missing", "null", "array", "object", "scalar"].includes(value));
        else if (key === "endpointIPv4AddressValid" || key === "endpointGatewayMatchesOwned" || key === "endpointIDValid" || key === "restartCountCapped") assert.equal(typeof value, "boolean");
        else if (key === "restartCount") assert.ok(value === null || Number.isInteger(value) && value >= 0 && value <= 255);
        else assert.ok(value === null || Number.isInteger(value) && value >= 0 && value <= 8);
      }
    } else assert.equal(portMetadata, undefined);
    assert.equal(bindingConsistency !== undefined, reason.startsWith("published-port-"));
    assert.doesNotMatch(JSON.stringify(error.hostFailure), /fixture-password|private-provider-output|secret.invalid/);
    return true;
  });
  assert.ok(f.commands.every(args => !args.includes("--ip") && !args.includes("--subnet") && !args.includes("--add-host") && !args.includes("host")));
  return failure;
}

test("backup shape diagnostics separate CLI exposure/request from runtime mappings using only fixed shapes and capped counts", async t => {
  const expected = { networkModeCategory: "owned-bridge", networkAttachmentCount: 1,
    endpointIPv4AddressShape: "scalar", endpointIPv4AddressValid: true, endpointGatewayMatchesOwned: true, endpointIDValid: true,
    exposedMapShape: "object", exposedPortCount: 1, exposedPortShape: "object", requestedMapShape: "object", requestedPortCount: 1, requestedBindingsShape: "array", requestedBindingCount: 1,
    requestedObjectCount: 1, requestedGatewayMatchCount: 1, requestedHostPortCategory: "expected-empty", publishAllPortsCategory: "disabled", restartCount: 0, restartCountCapped: false,
    runtimeMapShape: "object", runtimePortCount: 1, runtimeBindingsShape: "missing", runtimeBindingCount: null, runtimeObjectCount: 0, runtimeGatewayMatchCount: 0, runtimeValidPortCount: 0 };
  const cases = [
    ["missing runtime map", f => { delete f.containerRow.NetworkSettings.Ports; }, { runtimeMapShape: "missing", runtimePortCount: null }],
    ["null runtime map", f => { f.containerRow.NetworkSettings.Ports = null; }, { runtimeMapShape: "null", runtimePortCount: null }],
    ["scalar runtime map", f => { f.containerRow.NetworkSettings.Ports = "private-provider-output"; }, { runtimeMapShape: "scalar", runtimePortCount: null }],
    ["unrelated port", f => { f.containerRow.NetworkSettings.Ports = { "private-provider-output": [{ HostIp: "secret.invalid", HostPort: "fixture-password" }] }; }, {}],
    ["null binding", f => { f.containerRow.NetworkSettings.Ports["9000/tcp"] = null; }, { runtimeBindingsShape: "null" }],
    ["empty binding", f => { f.containerRow.NetworkSettings.Ports["9000/tcp"] = []; }, { runtimeBindingsShape: "array", runtimeBindingCount: 0 }],
    ["nonobject binding", f => { f.containerRow.NetworkSettings.Ports["9000/tcp"] = ["private-provider-output"]; }, { runtimeBindingsShape: "array", runtimeBindingCount: 1 }],
    ["extra IPv6 binding", f => { f.containerRow.NetworkSettings.Ports["9000/tcp"].push({ HostIp: "::", HostPort: "" }); },
      { runtimeBindingsShape: "array", runtimeBindingCount: 2, runtimeObjectCount: 2, runtimeGatewayMatchCount: 1, runtimeValidPortCount: 1 }],
    ["duplicate exact binding", f => { f.containerRow.NetworkSettings.Ports["9000/tcp"].push({ ...f.containerRow.NetworkSettings.Ports["9000/tcp"][0] }); },
      { runtimeBindingsShape: "array", runtimeBindingCount: 2, runtimeObjectCount: 2, runtimeGatewayMatchCount: 2, runtimeValidPortCount: 2 }],
    ["missing CLI request", f => { f.containerRow.NetworkSettings.Ports = {}; delete f.containerRow.Config.ExposedPorts; delete f.containerRow.HostConfig.PortBindings; },
      { exposedMapShape: "missing", exposedPortCount: null, exposedPortShape: "missing", requestedMapShape: "missing", requestedPortCount: null, requestedBindingsShape: "missing", requestedBindingCount: null,
        requestedObjectCount: 0, requestedGatewayMatchCount: 0, requestedHostPortCategory: "unavailable", runtimePortCount: 0 }],
    ["malformed CLI request", f => { f.containerRow.NetworkSettings.Ports = {}; f.containerRow.Config.ExposedPorts = { "9000/tcp": "fixture-password" };
      f.containerRow.HostConfig.PortBindings = { "9000/tcp": { HostIp: "secret.invalid", HostPort: "fixture-password" } }; },
      { exposedPortShape: "scalar", requestedBindingsShape: "object", requestedBindingCount: null, requestedObjectCount: 0, requestedGatewayMatchCount: 0, requestedHostPortCategory: "unavailable", runtimePortCount: 0 }],
    ["capped mappings", f => { f.containerRow.NetworkSettings.Ports["9000/tcp"] = Array.from({ length: 30 }, () => ({ HostIp: "secret.invalid", HostPort: "fixture-password" }));
      f.containerRow.HostConfig.PortBindings["9000/tcp"] = Array(30).fill(null); },
      { requestedBindingCount: 8, requestedObjectCount: 0, requestedGatewayMatchCount: 0, requestedHostPortCategory: "multiple-rows", runtimeBindingsShape: "array", runtimeBindingCount: 8, runtimeObjectCount: 8 }],
    ["unexpected host mode", f => { f.containerRow.NetworkSettings.Ports = {}; f.containerRow.HostConfig.NetworkMode = "host"; },
      { networkModeCategory: "host", runtimePortCount: 0 }],
    ["missing network mode", f => { f.containerRow.NetworkSettings.Ports = {}; delete f.containerRow.HostConfig.NetworkMode; },
      { networkModeCategory: "missing", runtimePortCount: 0 }],
    ["foreign network mode and extra attachment", f => { f.containerRow.NetworkSettings.Ports = {}; f.containerRow.HostConfig.NetworkMode = "private-provider-output";
      f.containerRow.NetworkSettings.Networks["private-provider-output"] = { NetworkID: "secret.invalid" }; },
      { networkModeCategory: "other", networkAttachmentCount: 2, runtimePortCount: 0 }],
  ];
  for (const [name, change, metadata] of cases) await t.test(name, t => {
    const f = fixture(t); change(f);
    f.containerRow.State.Error = "private-provider-output fixture-password https://secret.invalid";
    f.containerRow.Config.Env = ["MINIO_ROOT_PASSWORD=fixture-password"];
    const failure = expectFailure(f, "container-readback", "published-port-shape-invalid", { containerStatus: "running", containerExitCode: 0 });
    assert.deepEqual(failure.portMetadata, { ...expected, ...metadata });
    assert.doesNotMatch(JSON.stringify(failure), /172\.28|34567|9000|MINIO_ROOT|"(?:HostIp|HostPort|Env)":/);
    assert.equal(f.commands.filter(args => args[0] === "container" && args[1] === "inspect").length, 2);
    assert.equal(f.commands.filter(args => args[0] === "network" && args[1] === "inspect").length, 2);
  });
});

test("empty runtime bindings report only owned endpoint IPv4 shape, validity and gateway match without changing failure guards", async t => {
  const cases = [
    ["valid IPv4", () => {}, "scalar", true, true],
    ["missing address", endpoint => { delete endpoint.IPAddress; }, "missing", false, true],
    ["null address", endpoint => { endpoint.IPAddress = null; }, "null", false, true],
    ["empty address", endpoint => { endpoint.IPAddress = ""; }, "scalar", false, true],
    ["malformed address", endpoint => { endpoint.IPAddress = "private-provider-output fixture-password https://secret.invalid"; }, "scalar", false, true],
    ["IPv6 address", endpoint => { endpoint.IPAddress = "fd00:1234::2"; }, "scalar", false, true],
    ["numeric address", endpoint => { endpoint.IPAddress = 1234; }, "scalar", false, true],
    ["array address", endpoint => { endpoint.IPAddress = ["private-provider-output"]; }, "array", false, true],
    ["object address", endpoint => { endpoint.IPAddress = { secret: "fixture-password" }; }, "object", false, true],
    ["missing gateway", endpoint => { delete endpoint.Gateway; }, "scalar", true, false],
    ["foreign gateway", endpoint => { endpoint.Gateway = "192.168.1.1"; }, "scalar", true, false],
    ["malformed gateway", endpoint => { endpoint.Gateway = { private: "fixture-password" }; }, "scalar", true, false],
  ];
  for (const [name, change, shape, valid, matches] of cases) await t.test(name, t => {
    const f = fixture(t), endpoint = f.containerRow.NetworkSettings.Networks[f.networkRow.Name]; change(endpoint);
    f.containerRow.NetworkSettings.Ports["9000/tcp"] = [];
    f.containerRow.NetworkSettings.Networks["private-provider-output"] = { IPAddress: "172.28.0.3", Gateway: f.networkRow.IPAM.Config[0].Gateway };
    f.containerRow.Config.Env = ["MINIO_ROOT_PASSWORD=fixture-password"];
    const failure = expectFailure(f, "container-readback", "published-port-shape-invalid", { containerStatus: "running", containerExitCode: 0 });
    assert.equal(failure.portMetadata.endpointIPv4AddressShape, shape);
    assert.equal(failure.portMetadata.endpointIPv4AddressValid, valid);
    assert.equal(failure.portMetadata.endpointGatewayMatchesOwned, matches);
    assert.equal(failure.portMetadata.runtimeBindingCount, 0);
    assert.doesNotMatch(JSON.stringify(failure), /172\.28|192\.168|fd00|9000|MINIO_ROOT|IPAddress|Gateway":|Env/);
    assert.equal(f.commands.filter(args => args[0] === "container" && args[1] === "inspect").length, 2);
    assert.equal(f.commands.filter(args => args[0] === "network" && args[1] === "inspect").length, 2);
  });
  await t.test("endpoint metadata observation does not replace actual binding acceptance", t => {
    const f = fixture(t), endpoint = f.containerRow.NetworkSettings.Networks[f.networkRow.Name];
    endpoint.IPAddress = null; endpoint.Gateway = "private-provider-output";
    assert.equal(prepareHostBackupService(f).endpoint, "https://172.28.0.1:34567");
  });
});

test("backup endpoint accepts an assigned IPv4 port with a second IPv6 IPAM entry and unrelated unpublished port", t => {
  const f = fixture(t);
  f.networkRow.EnableIPv6 = true;
  f.networkRow.IPAM.Config.push({ Subnet: "fd00:1234::/64", Gateway: "fd00:1234::1" });
  f.containerRow.NetworkSettings.Ports["9001/tcp"] = null;
  f.containerRow.NetworkSettings.Ports["9000/tcp"][0].HostPort = "65535";
  const service = prepareHostBackupService(f);
  assert.equal(service.endpoint, "https://172.28.0.1:65535");
  assert.equal(service.port, 65535);
  assert.equal(f.containerRow.HostConfig.PortBindings["9000/tcp"][0].HostPort, "");
});

test("backup owns IPv4 NAT publication despite incompatible inherited daemon options", t => {
  const f = fixture(t), docker = f.docker;
  // Synthetic daemon default-network-opts merge: explicit create values win.
  // This is a source contract control, not a claim about the Windows daemon.
  f.networkRow.EnableIPv4 = false;
  f.networkRow.Options["com.docker.network.bridge.gateway_mode_ipv4"] = "routed";
  f.networkRow.Options["com.docker.network.bridge.inhibit_ipv4"] = "true";
  f.docker = args => {
    if (args[0] === "network" && args[1] === "create") {
      if (args.includes("--ipv4=true")) f.networkRow.EnableIPv4 = true;
      for (let index = 0; index < args.length; index++) if (args[index] === "--opt") {
        const [key, value] = args[index + 1].split("="); f.networkRow.Options[key] = value;
      }
    }
    return docker(args);
  };
  assert.equal(prepareHostBackupService(f).endpoint, "https://172.28.0.1:34567");
  assert.equal(f.commands.filter(args => args[0] === "network" && args[1] === "inspect").length, 2);
});

test("backup rejects an unusable publication mode before launch and again on network recheck", async t => {
  const changes = [
    ["internal", row => { row.Internal = true; }],
    ["missing internal flag", row => { delete row.Internal; }],
    ["IPv4 disabled", row => { row.EnableIPv4 = false; }],
    ["missing IPv4 flag", row => { delete row.EnableIPv4; }],
    ["missing options", row => { delete row.Options; }],
    ["null options", row => { row.Options = null; }],
    ["array options", row => { row.Options = []; }],
    ["unspecified gateway mode", row => { delete row.Options["com.docker.network.bridge.gateway_mode_ipv4"]; }],
    ...["routed", "isolated", "nat-unprotected", "private-provider-output"].map(mode =>
      [mode === "private-provider-output" ? "unknown gateway mode" : mode, row => { row.Options["com.docker.network.bridge.gateway_mode_ipv4"] = mode; }]),
    ["IPv4 bridge inhibited", row => { row.Options["com.docker.network.bridge.inhibit_ipv4"] = "true"; }],
    ["unspecified IPv4 inhibition", row => { delete row.Options["com.docker.network.bridge.inhibit_ipv4"]; }],
  ];
  for (const stage of ["initial-network", "network-recheck"]) for (const [name, change] of changes) await t.test(`${stage}: ${name}`, t => {
    const f = fixture(t), docker = f.docker; let reads = 0;
    f.docker = args => {
      if (args[0] === "network" && args[1] === "inspect" && ++reads === (stage === "initial-network" ? 1 : 2)) change(f.networkRow);
      return docker(args);
    };
    expectFailure(f, stage, "network-publication-mode-invalid");
    assert.equal(f.commands.filter(args => args[0] === "run").length, stage === "initial-network" ? 0 : 1);
    assert.equal(f.commands.filter(args => args[0] === "openssl").length, stage === "initial-network" ? 0 : 1);
    assert.equal(JSON.parse(readFileSync(f.ledgerPath)).resources.find(row => row.kind === "network").state, "created");
  });
});

test("backup network rejects each identity, IPAM and gateway failure with a fixed category", async t => {
  const cases = [
    ["name", "network-identity-invalid", row => { row.Name = "private-provider-output"; }],
    ["driver", "network-identity-invalid", row => { row.Driver = "host"; }],
    ["scope", "network-identity-invalid", row => { row.Scope = "swarm"; }],
    ["id", "network-identity-invalid", row => { row.Id = "private-provider-output"; }],
    ["owner", "network-owner-mismatch", row => { row.Labels["io.myskills.host-rehearsal"] = "private-provider-output"; }],
    ["missing IPAM", "network-ipam-invalid", row => { row.IPAM = null; }],
    ["missing IPv4", "network-ipam-invalid", row => { row.IPAM.Config = [{ Gateway: "::1" }]; }],
    ["ambiguous IPv4", "network-ipam-invalid", row => { row.IPAM.Config.push({ ...row.IPAM.Config[0] }); }],
    ["missing subnet", "network-gateway-invalid", row => { delete row.IPAM.Config[0].Subnet; }],
    ["invalid prefix", "network-gateway-invalid", row => { row.IPAM.Config[0].Subnet = "172.28.0.0/31"; }],
    ["loopback", "network-gateway-invalid", row => { row.IPAM.Config[0] = { Gateway: "127.0.0.1", Subnet: "127.0.0.0/8" }; }],
    ["outside subnet", "network-gateway-invalid", row => { row.IPAM.Config[0].Gateway = "192.168.1.1"; }],
    ["network address", "network-gateway-invalid", row => { row.IPAM.Config[0].Gateway = "172.28.0.0"; }],
    ["broadcast address", "network-gateway-invalid", row => { row.IPAM.Config[0].Gateway = "172.28.255.255"; }],
  ];
  for (const [name, reason, change] of cases) await t.test(name, t => {
    const f = fixture(t); change(f.networkRow);
    expectFailure(f, "initial-network", reason);
    assert.equal(f.commands.some(args => args[0] === "run"), false);
  });
});

test("backup readback rejects each container identity, attachment and published-port failure safely", async t => {
  const cases = [
    ["id", "container-id-mismatch", f => { f.containerRow.Id = "d".repeat(64); }],
    ["owner", "container-owner-mismatch", f => { f.containerRow.Config.Labels["io.myskills.host-rehearsal"] = "private-provider-output"; }],
    ["role", "container-role-mismatch", f => { f.containerRow.Config.Labels["io.myskills.host-rehearsal.role"] = "driver"; }],
    ["inconsistent Running", "container-state-inconsistent", f => { f.containerRow.State.Running = false; }],
    ["inconsistent Paused", "container-state-inconsistent", f => { f.containerRow.State.Paused = true; }],
    ["inconsistent Restarting", "container-state-inconsistent", f => { f.containerRow.State.Restarting = true; }],
    ["missing attachment", "container-network-mismatch", f => { f.containerRow.NetworkSettings.Networks = {}; }],
    ["foreign network ID", "container-network-mismatch", f => { f.containerRow.NetworkSettings.Networks[f.networkRow.Name].NetworkID = "d".repeat(64); }],
    ["missing settings", "container-network-mismatch", f => { f.containerRow.NetworkSettings = null; }],
    ["empty port map", "published-port-shape-invalid", f => { f.containerRow.NetworkSettings.Ports = {}; }],
    ["null binding", "published-port-shape-invalid", f => { f.containerRow.NetworkSettings.Ports["9000/tcp"] = null; }],
    ["empty binding", "published-port-shape-invalid", f => { f.containerRow.NetworkSettings.Ports["9000/tcp"] = []; }],
    ["null row", "published-port-shape-invalid", f => { f.containerRow.NetworkSettings.Ports["9000/tcp"] = [null]; }],
    ["object instead of array", "published-port-shape-invalid", f => { f.containerRow.NetworkSettings.Ports["9000/tcp"] = { 0: { HostIp: "172.28.0.1", HostPort: "34567" }, length: 1 }; }],
    ["two bindings", "published-port-shape-invalid", f => { f.containerRow.NetworkSettings.Ports["9000/tcp"].push({ HostIp: "::", HostPort: "" }); }],
    ["broad address", "published-port-address-mismatch", f => { f.containerRow.NetworkSettings.Ports["9000/tcp"][0].HostIp = "0.0.0.0"; }],
    ["foreign address", "published-port-address-mismatch", f => { f.containerRow.NetworkSettings.Ports["9000/tcp"][0].HostIp = "192.168.1.1"; }],
    ...["", "0", "65536", "034567", "private-provider-output", 34567, null].map(port =>
      [`invalid port ${typeof port}:${port === null ? "null" : typeof port === "string" && !/^\d*$/.test(port) ? "text" : port}`, "published-port-number-invalid", f => { f.containerRow.NetworkSettings.Ports["9000/tcp"][0].HostPort = port; }]),
  ];
  for (const [name, reason, change] of cases) await t.test(name, t => {
    const f = fixture(t); change(f);
    f.containerRow.State.Error = "private-provider-output fixture-password https://secret.invalid";
    f.containerRow.Config.Env = ["MINIO_ROOT_PASSWORD=fixture-password"];
    expectFailure(f, "container-readback", reason, { containerStatus: "running", containerExitCode: 0 });
    assert.equal(f.commands.filter(args => args[0] === "network" && args[1] === "inspect").length, reason.startsWith("published-port-") ? 2 : 1);
    const ledger = JSON.parse(readFileSync(f.ledgerPath));
    assert.equal(ledger.resources.find(row => row.kind === "container").state, "created");
  });
});

test("backup detached launch diagnoses terminal or pending state before missing runtime ports without speculative retry", async t => {
  for (const status of ["created", "paused", "restarting", "removing", "exited", "dead"]) await t.test(status, t => {
    const f = fixture(t);
    Object.assign(f.containerRow.State, { Status: status, Running: status === "paused", Paused: status === "paused", Restarting: status === "restarting", Dead: status === "dead", ExitCode: status === "exited" ? 1 : 0,
      Error: "private-provider-output fixture-password https://secret.invalid" });
    f.containerRow.NetworkSettings.Ports = {};
    expectFailure(f, "container-readback", "container-not-running", { containerStatus: status, containerExitCode: status === "exited" ? 1 : 0 });
    assert.equal(f.commands.filter(args => args[0] === "container" && args[1] === "inspect").length, 1);
  });
  for (const state of [null, { Status: "private-provider-output", ExitCode: 0 }, { Status: "running", ExitCode: "fixture-password" }, { Status: "running", ExitCode: -1 }, { Status: "running", ExitCode: 256 }]) await t.test("invalid state shape", t => {
    const f = fixture(t); f.containerRow.State = state;
    expectFailure(f, "container-readback", "container-state-invalid", {
      containerStatus: state?.Status === "running" ? "running" : "unknown", containerExitCode: state?.ExitCode === 0 ? 0 : null });
  });
});

test("backup creation ID rejection retains the owned reservation without inspecting a guessed container", t => {
  const f = fixture(t), runService = f.runService;
  f.runService = (...args) => { runService(...args); return "private-provider-output"; };
  expectFailure(f, "container-create", "container-id-invalid");
  assert.equal(f.commands.some(args => args[0] === "container" && args[1] === "inspect"), false);
  assert.equal(JSON.parse(readFileSync(f.ledgerPath)).resources.find(row => row.kind === "container").state, "created");
});

test("requested rows, publish-all, restart and endpoint observations are bounded and never supply runtime acceptance", async t => {
  const cases = [
    ["null row", f => { f.containerRow.HostConfig.PortBindings["9000/tcp"] = [null]; }, { requestedObjectCount: 0, requestedGatewayMatchCount: 0, requestedHostPortCategory: "invalid-row" }],
    ["scalar row", f => { f.containerRow.HostConfig.PortBindings["9000/tcp"] = ["fixture-password"]; }, { requestedObjectCount: 0, requestedGatewayMatchCount: 0, requestedHostPortCategory: "invalid-row" }],
    ["foreign request IP", f => { f.containerRow.HostConfig.PortBindings["9000/tcp"][0].HostIp = "secret.invalid"; }, { requestedObjectCount: 1, requestedGatewayMatchCount: 0, requestedHostPortCategory: "expected-empty" }],
    ["missing request port", f => { delete f.containerRow.HostConfig.PortBindings["9000/tcp"][0].HostPort; }, { requestedHostPortCategory: "missing" }],
    ["fixed request port", f => { f.containerRow.HostConfig.PortBindings["9000/tcp"][0].HostPort = "34567"; }, { requestedHostPortCategory: "assigned" }],
    ["secret request port", f => { f.containerRow.HostConfig.PortBindings["9000/tcp"][0].HostPort = "fixture-password"; }, { requestedHostPortCategory: "invalid" }],
    ["empty request", f => { f.containerRow.HostConfig.PortBindings["9000/tcp"] = []; }, { requestedBindingCount: 0, requestedObjectCount: 0, requestedGatewayMatchCount: 0, requestedHostPortCategory: "no-rows" }],
    ["many requests", f => { f.containerRow.HostConfig.PortBindings["9000/tcp"] = Array(40).fill({ HostIp: "172.28.0.1", HostPort: "" }); }, { requestedBindingCount: 8, requestedObjectCount: 8, requestedGatewayMatchCount: 8, requestedHostPortCategory: "multiple-rows" }],
    ["publish all", f => { f.containerRow.HostConfig.PublishAllPorts = true; }, { publishAllPortsCategory: "enabled" }],
    ["invalid publish all", f => { f.containerRow.HostConfig.PublishAllPorts = "fixture-password"; }, { publishAllPortsCategory: "invalid" }],
    ["missing publish all", f => { delete f.containerRow.HostConfig.PublishAllPorts; }, { publishAllPortsCategory: "missing" }],
    ["restart count", f => { f.containerRow.RestartCount = 5; }, { restartCount: 5, restartCountCapped: false }],
    ["capped restart count", f => { f.containerRow.RestartCount = 9999; }, { restartCount: 255, restartCountCapped: true }],
    ["invalid restart count", f => { f.containerRow.RestartCount = "fixture-password"; }, { restartCount: null, restartCountCapped: false }],
    ["invalid endpoint", f => { f.containerRow.NetworkSettings.Networks[f.networkRow.Name].EndpointID = "fixture-password"; }, { endpointIDValid: false }],
  ];
  for (const [name, change, fields] of cases) await t.test(name, t => {
    const f = fixture(t); change(f); f.containerRow.NetworkSettings.Ports["9000/tcp"] = [];
    const failure = expectFailure(f, "container-readback", "published-port-shape-invalid", { containerStatus: "running", containerExitCode: 0 });
    for (const [key, value] of Object.entries(fields)) assert.equal(failure.portMetadata[key], value);
    assert.equal(f.diagnostics[0].category, "matched");
    assert.doesNotMatch(JSON.stringify(failure), /fixture-password|secret.invalid|172\.28|34567|MINIO_ROOT|hc-/);
  });
});

test("binding failure takes exactly two bounded readbacks, records continuity and always retains the first failure", async t => {
  const cases = [
    ["stable", () => {}, { network: { category: "observed", contractMatches: true, exactMembership: true, memberEndpointMatchesInitial: true },
      container: { category: "observed", endpointUnchanged: true, stateUnchanged: true, requestUnchanged: true, bindingsUnchanged: true, exactNetworkAttachment: true } }],
    ["now populated", f => { f.containerRow.NetworkSettings.Ports["9000/tcp"] = [{ HostIp: "172.28.0.1", HostPort: "34567" }]; }, { container: { bindingsUnchanged: false } }],
    ["new endpoint", f => { f.containerRow.NetworkSettings.Networks[f.networkRow.Name].EndpointID = "d".repeat(64); }, { container: { endpointUnchanged: false } }],
    ["restart", f => { f.containerRow.RestartCount = 1; }, { container: { stateUnchanged: false } }],
    ["start changed", f => { f.containerRow.State.StartedAt = "secret.invalid"; }, { container: { stateUnchanged: false } }],
    ["state changed", f => { f.containerRow.State.Status = "exited"; }, { container: { stateUnchanged: false } }],
    ["request changed", f => { f.containerRow.HostConfig.PortBindings["9000/tcp"][0].HostPort = "34567"; }, { container: { requestUnchanged: false } }],
    ["network mode changed", f => { f.networkRow.Options["com.docker.network.bridge.gateway_mode_ipv4"] = "routed"; }, { network: { contractMatches: false } }],
    ["gateway changed", f => { f.networkRow.IPAM.Config[0].Gateway = "172.28.0.3"; }, { network: { contractMatches: false } }],
    ["membership missing", f => { f.networkRow.Containers = {}; }, { network: { exactMembership: false, membershipCount: 0, memberEndpointMatchesInitial: false } }],
    ["foreign member", f => { f.networkRow.Containers["foreign"] = { Env: ["fixture-password"], Name: "secret.invalid" }; }, { network: { exactMembership: false, membershipCount: 2 } }],
    ["member endpoint changed", f => { f.networkRow.Containers[f.containerRow.Id].EndpointID = "d".repeat(64); }, { network: { memberEndpointMatchesInitial: false } }],
    ["network replaced", f => { f.networkRow.Id = "d".repeat(64); }, { network: { category: "identity-mismatch" } }],
    ["network owner changed", f => { f.networkRow.Labels["io.myskills.host-rehearsal"] = "foreign"; }, { network: { category: "identity-mismatch" } }],
    ["container replaced", f => { f.containerRow.Id = "d".repeat(64); }, { container: { category: "identity-mismatch" } }],
    ["container owner changed", f => { f.containerRow.Config.Labels["io.myskills.host-rehearsal"] = "foreign"; }, { container: { category: "identity-mismatch" } }],
    ["container role changed", f => { f.containerRow.Config.Labels["io.myskills.host-rehearsal.role"] = "driver"; }, { container: { category: "identity-mismatch" } }],
  ];
  for (const [name, change, expected] of cases) await t.test(name, t => {
    const f = fixture(t), docker = f.docker, extra = []; f.containerRow.NetworkSettings.Ports["9000/tcp"] = [];
    f.docker = (args, options) => {
      if (options) { extra.push({ args, options }); if (extra.length === 1) change(f); }
      return docker(args);
    };
    const failure = expectFailure(f, "container-readback", "published-port-shape-invalid", { containerStatus: "running", containerExitCode: 0 });
    assert.equal(failure.portMetadata.runtimeBindingCount, 0);
    assert.deepEqual(extra, [
      { args: ["network", "inspect", "b".repeat(64)], options: { timeout: 10_000, maxBuffer: 128 * 1024, killSignal: "SIGKILL" } },
      { args: ["container", "inspect", "a".repeat(64)], options: { timeout: 10_000, maxBuffer: 128 * 1024, killSignal: "SIGKILL" } },
    ]);
    for (const [surface, fields] of Object.entries(expected)) for (const [key, value] of Object.entries(fields)) assert.equal(failure.bindingConsistency[surface][key], value);
    for (const surface of ["network", "container"]) if (failure.bindingConsistency[surface].category === "identity-mismatch") assert.deepEqual(failure.bindingConsistency[surface], { category: "identity-mismatch" });
    assert.doesNotMatch(JSON.stringify(failure), /foreign|fixture-password|secret.invalid|172\.28|34567|hc-/);
    const ledger = JSON.parse(readFileSync(f.ledgerPath)); assert.equal(ledger.resources.find(row => row.kind === "container").state, "created");
  });
});

test("failed consistency commands, malformed or excessive output preserve the primary failure and two-call bound", async t => {
  for (const [name, response, expected] of [
    ["throw", () => { throw new Error("fixture-password secret.invalid"); }, "readback-failed"],
    ["nonzero", () => ({ status: 1, stdout: "[]", stderr: "fixture-password" }), "readback-failed"],
    ["timeout", () => ({ status: null, error: { code: "ETIMEDOUT", message: "fixture-password" } }), "readback-failed"],
    ["JSON", () => ({ stdout: "fixture-password" }), "json-invalid"],
    ["shape", () => ({ stdout: "[null]" }), "shape-invalid"],
    ["output limit", () => ({ stdout: "fixture-password".repeat(20000) }), "output-invalid"],
  ]) await t.test(name, t => {
    const f = fixture(t), docker = f.docker; let extra = 0; f.containerRow.NetworkSettings.Ports["9000/tcp"] = [];
    f.docker = (args, options) => { if (options) { extra++; f.commands.push(args); return response(); } return docker(args); };
    const failure = expectFailure(f, "container-readback", "published-port-shape-invalid", { containerStatus: "running", containerExitCode: 0 });
    assert.deepEqual(failure.bindingConsistency, { network: { category: expected }, container: { category: expected } }); assert.equal(extra, 2);
    assert.equal(failure.portMetadata.runtimeBindingCount, 0);
  });
});

test("backup inspect parsing and repeated network identity have fixed stages and preserve reserved resources", async t => {
  for (const stage of ["initial-network", "container-readback", "network-recheck"]) {
    const cases = [
      ["malformed JSON", "inspect-json-invalid", () => "private-provider-output fixture-password"],
      ["object", "inspect-shape-invalid", () => "{}"],
      ["null", "inspect-shape-invalid", () => "null"],
      ["empty array", "inspect-shape-invalid", () => "[]"],
      ["null row", "inspect-shape-invalid", () => "[null]"],
      ["extra row", "inspect-shape-invalid", row => JSON.stringify([row, row])],
      ...(stage === "network-recheck" ? [
        ["changed ID", "network-id-changed", row => JSON.stringify([{ ...row, Id: "d".repeat(64) }])],
        ["changed gateway", "network-gateway-changed", row => JSON.stringify([{ ...row, IPAM: { Config: [{ Subnet: "172.28.0.0/16", Gateway: "172.28.0.3" }] } }])],
        ["changed owner", "network-owner-mismatch", row => JSON.stringify([{ ...row, Labels: { "io.myskills.host-rehearsal": "private-provider-output" } }])],
      ] : []),
    ];
    for (const [name, reason, response] of cases) await t.test(`${stage}: ${name}`, t => {
      const f = fixture(t), docker = f.docker; let networkReads = 0;
      f.docker = args => {
        const result = docker(args);
        if (args[1] !== "inspect") return result;
        if (args[0] === "network") networkReads++;
        const currentStage = args[0] === "container" ? "container-readback" : networkReads === 1 ? "initial-network" : "network-recheck";
        return currentStage === stage ? { stdout: response(JSON.parse(result.stdout)[0]) } : result;
      };
      expectFailure(f, stage, reason);
      const ledger = JSON.parse(readFileSync(f.ledgerPath));
      assert.equal(ledger.resources.find(row => row.kind === "network").state, "created");
      assert.equal(ledger.resources.some(row => row.kind === "container"), stage !== "initial-network");
    });
  }
});

test("live failure observer is finite, private, identity checked and cannot recover acceptance or consume cleanup reservations", async t => {
  for (const scenario of ["observed", "foreign", "overflow", "deadline", "changed", "throws"]) await t.test(scenario, t => {
    const f = fixture(t); f.containerRow.NetworkSettings.Ports["9000/tcp"] = [];
    const directory = mkdtempSync(join(tmpdir(), "host-observer-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
    writeFileSync(join(directory, "ready.json"), JSON.stringify({ schemaVersion: 1, candidate: "d".repeat(40), runId: "fixture-owned-run", nonce: "e".repeat(32), expiresAtMs: 20000 }), { mode: 0o600 });
    let time = 1000, waits = 0, calls = 0;
    const docker = f.docker;
    f.publicationObserver = context => {
      calls++; if (scenario === "throws") throw new Error("fixture-password");
      return observeHostPublication({ ...context, candidate: "d".repeat(40), runId: "fixture-owned-run" }, { directory, maximumMs: 3500, now: () => time, wait: ms => {
        waits++; time += ms;
        if (scenario === "deadline") return;
        const request = JSON.parse(readFileSync(join(directory, "request.json")));
        assert.deepEqual(Object.keys(request).sort(), ["schemaVersion", "candidate", "runId", "nonce", "token", "owner", "containerId", "networkId", "endpointId", "gateway", "address", "publicCertificate", "deadlineMs"].sort());
        const value = { ...request, category: "observed", bridgeAddress: "present", forwarding: "present", listener: "absent", ubuntuTls: "ready", backendTls: "unavailable", adapterTermination: "confirmed", observedPort: "34567", secret: "fixture-password" };
        if (scenario === "foreign") value.containerId = "d".repeat(64);
        if (scenario === "changed") f.containerRow.Config.Labels["io.myskills.host-rehearsal"] = "foreign";
        writeFileSync(join(directory, `${request.token}.json`), scenario === "overflow" ? "x".repeat(2049) : JSON.stringify(value), { mode: 0o600 });
      } });
    };
    let bounded = 0;
    f.docker = (args, options) => { if (options?.timeout <= 3000) { bounded++; assert.equal(options.killSignal, "SIGKILL"); assert.ok([2048, 128 * 1024].includes(options.maxBuffer)); } return docker(args, options); };
    let failure;
    assert.throws(() => prepareHostBackupService(f), error => {
      assert.equal(error.message, "HOST_BACKUP_NETWORK_INVALID"); failure = error.hostFailure;
      assert.equal(failure.reason, "published-port-shape-invalid"); assert.equal(failure.stage, "container-readback");
      assert.equal(failure.containerStatus, "running"); assert.equal(failure.containerExitCode, 0); return true;
    });
    assert.equal(calls, 1); assert.ok(waits <= 10); assert.ok(bounded <= 2);
    assert.equal(failure.livePublication.category, { observed: "observed", foreign: "observer-identity-rejected", overflow: "observer-output-invalid",
      deadline: "observer-deadline", changed: "identity-changed", throws: "capture-failed" }[scenario]);
    assert.doesNotMatch(JSON.stringify(failure), /fixture-password|172\.28|hc-|foreign/);
    const ledger = JSON.parse(readFileSync(f.ledgerPath));
    assert.equal(ledger.resources.find(row => row.kind === "network").state, "created");
    assert.equal(ledger.resources.find(row => row.kind === "container").state, "created");
  });
});
