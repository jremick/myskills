import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync, constants, openSync, closeSync, fstatSync, readSync, lstatSync, renameSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { join } from "node:path";

const containerStatuses = ["created", "running", "paused", "restarting", "removing", "exited", "dead"];
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const safeExitCode = value => Number.isSafeInteger(value) && value >= 0 && value <= 255 ? value : null;
const validPort = value => typeof value === "string" && /^[1-9][0-9]{0,4}$/.test(value) && Number(value) <= 65535;
const metadataShape = value => value === undefined ? "missing" : value === null ? "null" : Array.isArray(value) ? "array" : isRecord(value) ? "object" : "scalar";
const metadataMapCount = value => isRecord(value) ? Math.min(Object.keys(value).length, 8) : null;
const gatewayModeOption = "com.docker.network.bridge.gateway_mode_ipv4";
const inhibitIPv4Option = "com.docker.network.bridge.inhibit_ipv4";
function portMetadata(container, network, gateway) {
  const exposed = container.Config?.ExposedPorts, requested = container.HostConfig?.PortBindings, runtime = container.NetworkSettings?.Ports;
  const bindings = runtime?.["9000/tcp"], mode = container.HostConfig?.NetworkMode;
  const endpoint = container.NetworkSettings?.Networks?.[network];
  // Fixed fields and capped counts only. No map keys, addresses, Env or values
  // leave this boundary, even when the daemon returns an unexpected shape.
  const rows = Array.isArray(bindings) ? bindings.slice(0, 8) : [];
  const request = requested?.["9000/tcp"], requestedRows = Array.isArray(request) ? request.slice(0, 8) : [];
  const hostPort = requestedRows[0]?.HostPort;
  return { networkModeCategory: mode === network ? "owned-bridge" : mode === undefined ? "missing" : ["host", "none", "bridge", "default"].includes(mode) ? mode : "other",
    networkAttachmentCount: metadataMapCount(container.NetworkSettings?.Networks),
    endpointIPv4AddressShape: metadataShape(endpoint?.IPAddress),
    endpointIPv4AddressValid: typeof endpoint?.IPAddress === "string" && isIP(endpoint.IPAddress) === 4,
    endpointGatewayMatchesOwned: endpoint?.Gateway === gateway,
    endpointIDValid: typeof endpoint?.EndpointID === "string" && /^[a-f0-9]{64}$/.test(endpoint.EndpointID),
    exposedMapShape: metadataShape(exposed), exposedPortCount: metadataMapCount(exposed), exposedPortShape: metadataShape(exposed?.["9000/tcp"]),
    requestedMapShape: metadataShape(requested), requestedPortCount: metadataMapCount(requested), requestedBindingsShape: metadataShape(requested?.["9000/tcp"]),
    requestedBindingCount: Array.isArray(requested?.["9000/tcp"]) ? Math.min(requested["9000/tcp"].length, 8) : null,
    requestedObjectCount: requestedRows.filter(isRecord).length,
    requestedGatewayMatchCount: requestedRows.filter(row => isRecord(row) && row.HostIp === gateway).length,
    requestedHostPortCategory: !Array.isArray(request) ? "unavailable" : request.length === 0 ? "no-rows" : request.length !== 1 ? "multiple-rows"
      : !isRecord(request[0]) ? "invalid-row" : hostPort === "" ? "expected-empty" : hostPort === undefined ? "missing" : validPort(hostPort) ? "assigned" : "invalid",
    publishAllPortsCategory: container.HostConfig?.PublishAllPorts === false ? "disabled" : container.HostConfig?.PublishAllPorts === true ? "enabled"
      : container.HostConfig?.PublishAllPorts === undefined ? "missing" : "invalid",
    restartCount: Number.isSafeInteger(container.RestartCount) && container.RestartCount >= 0 ? Math.min(container.RestartCount, 255) : null,
    restartCountCapped: Number.isSafeInteger(container.RestartCount) && container.RestartCount > 255,
    runtimeMapShape: metadataShape(runtime), runtimePortCount: metadataMapCount(runtime), runtimeBindingsShape: metadataShape(bindings),
    runtimeBindingCount: Array.isArray(bindings) ? Math.min(bindings.length, 8) : null,
    runtimeObjectCount: rows.filter(isRecord).length,
    runtimeGatewayMatchCount: rows.filter(row => isRecord(row) && row.HostIp === gateway).length,
    runtimeValidPortCount: rows.filter(row => isRecord(row) && validPort(row.HostPort)).length };
}
function invalidBackupNetwork(stage, reason, container, metadata) {
  const error = new Error("HOST_BACKUP_NETWORK_INVALID");
  error.hostFailure = { operation: "docker.network.backup-endpoint", stage, reason };
  if (container) {
    // Never copy Error, Env, names, addresses or arbitrary daemon strings.
    error.hostFailure.containerStatus = containerStatuses.includes(container.State?.Status) ? container.State.Status : "unknown";
    error.hostFailure.containerExitCode = safeExitCode(container.State?.ExitCode);
  }
  if (metadata) error.hostFailure.portMetadata = metadata;
  throw error;
}
function inspection(response, stage) {
  let rows;
  try { rows = JSON.parse(response.stdout); } catch { return invalidBackupNetwork(stage, "inspect-json-invalid"); }
  if (!Array.isArray(rows) || rows.length !== 1 || !isRecord(rows[0])) return invalidBackupNetwork(stage, "inspect-shape-invalid");
  return rows[0];
}
// Command error categories are fixed. Container readback exports only
// Status/ExitCode and fixed port metadata; State.Error stays inside the boundary.
function commandErrorCategory(value) {
  const text = typeof value === "string" ? value.slice(0, 16_384) : "";
  return !text ? "none" : /user specified IP address|user configured subnets|invalid.*subnet|invalid.*ip address/i.test(text) ? "ipam-rejected"
    : /address already in use|port is already allocated/i.test(text) ? "port-unavailable"
      : /cannot connect to the Docker daemon/i.test(text) ? "daemon-unavailable"
        : /permission denied|access denied/i.test(text) ? "permission-denied" : "unclassified";
}
const ipv4Number = value => value.split(".").reduce((number, octet) => number * 256 + Number(octet), 0);
/** Exact owned bridge identity, dynamic IPAM and a usable assigned IPv4 gateway. */
function ownedGateway(response, network, owner, stage) {
  const row = inspection(response, stage);
  if (row.Name !== network || row.Driver !== "bridge" || row.Scope !== "local" || !/^[a-f0-9]{64}$/.test(row.Id ?? "")) return invalidBackupNetwork(stage, "network-identity-invalid");
  if (row.Labels?.["io.myskills.host-rehearsal"] !== owner) return invalidBackupNetwork(stage, "network-owner-mismatch");
  // IPAM can describe a gateway without proving an IPv4 publishing endpoint.
  // Docker28.3 inherits unspecified driver options; routed mode has no host port.
  if (row.Internal !== false || row.EnableIPv4 !== true || !isRecord(row.Options)
    || row.Options[gatewayModeOption] !== "nat" || row.Options[inhibitIPv4Option] !== "false") return invalidBackupNetwork(stage, "network-publication-mode-invalid");
  const configurations = Array.isArray(row.IPAM?.Config) ? row.IPAM.Config.filter(value => typeof value?.Gateway === "string" && isIP(value.Gateway) === 4) : [];
  if (configurations.length !== 1) return invalidBackupNetwork(stage, "network-ipam-invalid");
  const { Gateway: gateway, Subnet: subnet } = configurations[0];
  const parts = typeof subnet === "string" ? subnet.split("/") : [];
  const prefix = Number(parts[1]);
  if (parts.length !== 2 || isIP(parts[0]) !== 4 || !Number.isInteger(prefix) || prefix < 1 || prefix > 30 || /^(0|127|169\.254|22[4-9]|2[3-5]\d)\./.test(gateway)) return invalidBackupNetwork(stage, "network-gateway-invalid");
  const block = 2 ** (32 - prefix), start = Math.floor(ipv4Number(parts[0]) / block) * block, address = ipv4Number(gateway);
  if (address <= start || address >= start + block - 1) return invalidBackupNetwork(stage, "network-gateway-invalid");
  return { gateway, networkId: row.Id, subnet };
}

// Exactly two additional reads on binding failure. They do not retry launch or
// supply acceptance. Validate identity before exporting even fixed metadata.
function bindingConsistency(docker, network, owner, selected, id, initial) {
  const options = { timeout: 10_000, maxBuffer: 128 * 1024, killSignal: "SIGKILL" };
  const read = args => {
    const response = docker(args, options);
    if (response?.error || response?.signal || response?.status !== undefined && response.status !== 0) throw new Error("diagnostic-command-failed");
    if (typeof response?.stdout !== "string" || Buffer.byteLength(response.stdout) > options.maxBuffer) throw new Error("diagnostic-output-invalid");
    return inspection(response, "binding-diagnostic");
  };
  const category = error => error?.hostFailure?.reason === "inspect-json-invalid" ? "json-invalid"
    : error?.hostFailure?.reason === "inspect-shape-invalid" ? "shape-invalid" : error?.message === "diagnostic-output-invalid" ? "output-invalid" : "readback-failed";
  const evidence = {};
  try {
    const row = read(["network", "inspect", selected.networkId]);
    if (row.Id !== selected.networkId || row.Name !== network || row.Labels?.["io.myskills.host-rehearsal"] !== owner) evidence.network = { category: "identity-mismatch" };
    else {
      let current;
      try { current = ownedGateway({ stdout: JSON.stringify([row]) }, network, owner, "binding-diagnostic"); } catch { /* fixed contract result */ }
      const members = row.Containers, member = isRecord(members) ? members[id] : undefined;
      const endpoint = initial.NetworkSettings?.Networks?.[network];
      evidence.network = { category: "observed", contractMatches: Boolean(current && current.gateway === selected.gateway && current.subnet === selected.subnet),
        membershipCount: metadataMapCount(members), exactMembership: isRecord(members) && Object.keys(members).length === 1 && isRecord(member),
        memberEndpointIDValid: typeof member?.EndpointID === "string" && /^[a-f0-9]{64}$/.test(member.EndpointID),
        memberEndpointMatchesInitial: typeof endpoint?.EndpointID === "string" && /^[a-f0-9]{64}$/.test(endpoint.EndpointID) && member?.EndpointID === endpoint.EndpointID };
    }
  } catch (error) { evidence.network = { category: category(error) }; }
  try {
    const row = read(["container", "inspect", id]);
    if (row.Id !== id || row.Config?.Labels?.["io.myskills.host-rehearsal"] !== owner || row.Config?.Labels?.["io.myskills.host-rehearsal.role"] !== "backup") evidence.container = { category: "identity-mismatch" };
    else {
      const endpoint = initial.NetworkSettings?.Networks?.[network], current = row.NetworkSettings?.Networks?.[network];
      const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      evidence.container = { category: "observed", portMetadata: portMetadata(row, network, selected.gateway),
        containerStatus: containerStatuses.includes(row.State?.Status) ? row.State.Status : "unknown", containerExitCode: safeExitCode(row.State?.ExitCode),
        runningStateMatchesContract: row.State?.Status === "running" && safeExitCode(row.State?.ExitCode) !== null
          && row.State?.Running === true && row.State?.Paused === false && row.State?.Restarting === false,
        exactNetworkAttachment: isRecord(row.NetworkSettings?.Networks) && Object.keys(row.NetworkSettings.Networks).length === 1 && current?.NetworkID === selected.networkId,
        endpointUnchanged: Boolean(endpoint && current && ["NetworkID", "EndpointID", "IPAddress", "Gateway"].every(key => equal(endpoint[key], current[key]))),
        stateUnchanged: equal(initial.RestartCount, row.RestartCount) && ["Status", "Running", "Paused", "Restarting", "OOMKilled", "Dead", "ExitCode", "StartedAt", "FinishedAt"].every(key => equal(initial.State?.[key], row.State?.[key])),
        requestUnchanged: equal(initial.HostConfig?.PortBindings?.["9000/tcp"], row.HostConfig?.PortBindings?.["9000/tcp"])
          && equal(initial.HostConfig?.PublishAllPorts, row.HostConfig?.PublishAllPorts) && equal(initial.HostConfig?.NetworkMode, row.HostConfig?.NetworkMode),
        bindingsUnchanged: equal(initial.NetworkSettings?.Ports?.["9000/tcp"], row.NetworkSettings?.Ports?.["9000/tcp"]) };
    }
  } catch (error) { evidence.container = { category: category(error) }; }
  return evidence;
}

/** One TLS-valid gateway endpoint serves the host driver, bridge and recovery. */
export function prepareHostBackupService({ proof, owner, image, user, password, reserve, mark, docker, call, runService, publicationObserver }) {
  assert.match(owner, /^hc-[a-f0-9]{16}$/);
  assert.ok([user, password].every(value => typeof value === "string" && !/[\r\n\0]/.test(value)));
  const network = `${owner}-backup-network`;
  reserve("network", network);
  // Own these publication prerequisites rather than relying on daemon defaults.
  // The daemon still assigns IPAM and the real port, bound only to this gateway.
  docker(["network", "create", "--driver", "bridge", "--internal=false", "--ipv4=true",
    "--opt", `${gatewayModeOption}=nat`, "--opt", `${inhibitIPv4Option}=false`, "--label", `io.myskills.host-rehearsal=${owner}`, network]);
  mark("network", network);
  const selected = ownedGateway(docker(["network", "inspect", network]), network, owner, "initial-network");
  const certs = join(proof, "certs"); mkdirSync(certs, { mode: 0o700 });
  call("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", join(certs, "private.key"),
    "-out", join(certs, "public.crt"), "-subj", "/CN=MySkills disposable backup", "-addext", `subjectAltName=IP:${selected.gateway}`]);
  chmodSync(join(certs, "private.key"), 0o600);
  // Docker's env-file preserves literal dollars; never export these values in diagnostics.
  writeFileSync(join(proof, "backup-minio.env"), `MINIO_ROOT_USER=${user}\nMINIO_ROOT_PASSWORD=${password}\n`, { mode: 0o600 });
  const id = runService("backup", ["--network", network, "--publish", `${selected.gateway}::9000`, "--env-file", join(proof, "backup-minio.env"),
    "--mount", `type=bind,source=${certs},target=/certs,readonly`], image, ["server", "/data", "--certs-dir", "/certs"],
    { owner, network, gateway: selected.gateway, image, envFile: join(proof, "backup-minio.env"), certs });
  if (!/^[a-f0-9]{64}$/.test(id ?? "")) return invalidBackupNetwork("container-create", "container-id-invalid");
  // Read back the exact daemon-assigned port and owner; never infer an endpoint.
  const stage = "container-readback";
  const container = inspection(docker(["container", "inspect", id]), stage);
  if (container.Id !== id) return invalidBackupNetwork(stage, "container-id-mismatch", container);
  if (container.Config?.Labels?.["io.myskills.host-rehearsal"] !== owner) return invalidBackupNetwork(stage, "container-owner-mismatch", container);
  if (container.Config?.Labels?.["io.myskills.host-rehearsal.role"] !== "backup") return invalidBackupNetwork(stage, "container-role-mismatch", container);
  if (!containerStatuses.includes(container.State?.Status) || safeExitCode(container.State?.ExitCode) === null) return invalidBackupNetwork(stage, "container-state-invalid", container);
  // Detached launch success does not establish that the service is still live.
  if (container.State.Status !== "running") return invalidBackupNetwork(stage, "container-not-running", container);
  if (container.State.Running !== true || container.State.Paused !== false || container.State.Restarting !== false) return invalidBackupNetwork(stage, "container-state-inconsistent", container);
  if (container.NetworkSettings?.Networks?.[network]?.NetworkID !== selected.networkId) return invalidBackupNetwork(stage, "container-network-mismatch", container);
  const ports = container?.NetworkSettings?.Ports?.["9000/tcp"];
  const failBinding = (reason, metadata) => {
    try { invalidBackupNetwork(stage, reason, container, metadata); }
    catch (primary) {
      if (publicationObserver) {
        try { primary.hostFailure.livePublication = publicationObserver({ docker, network, owner, selected, id, container, publicCertificate: hostPublicCertificate(join(certs, "public.crt")) }); }
        catch { primary.hostFailure.livePublication = { category: "capture-failed" }; }
      }
      try { primary.hostFailure.bindingConsistency = bindingConsistency(docker, network, owner, selected, id, container); }
      catch { primary.hostFailure.bindingConsistency = { category: "capture-failed" }; }
      throw primary; // Even a now-valid second observation cannot recover acceptance.
    }
  };
  if (!Array.isArray(ports) || ports.length !== 1 || !isRecord(ports[0])) return failBinding("published-port-shape-invalid", portMetadata(container, network, selected.gateway));
  if (ports[0].HostIp !== selected.gateway) return failBinding("published-port-address-mismatch");
  if (!validPort(ports[0].HostPort)) return failBinding("published-port-number-invalid");
  const current = ownedGateway(docker(["network", "inspect", network]), network, owner, "network-recheck");
  if (current.networkId !== selected.networkId) return invalidBackupNetwork("network-recheck", "network-id-changed");
  if (current.gateway !== selected.gateway) return invalidBackupNetwork("network-recheck", "network-gateway-changed");
  return { network, gateway: selected.gateway, port: Number(ports[0].HostPort), endpoint: `https://${selected.gateway}:${ports[0].HostPort}` };
}

// Internal fixture handoff only. An already prepared observer gets one live
// window before the original failure reaches ledger cleanup. Never acceptance.
export const hostPublicationDirectory = "/tmp/myskills-host-publication-once";
export function privateHostObservation(path, maximum = 2048) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.uid !== process.getuid() || (before.mode & 0o777) !== 0o600 || before.size > maximum) throw new Error("private-observation-invalid");
    const buffer = Buffer.alloc(maximum + 1); const size = readSync(fd, buffer, 0, buffer.length, 0); const after = fstatSync(fd);
    if (size !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("private-observation-transition");
    return JSON.parse(buffer.subarray(0, size).toString());
  } finally { closeSync(fd); }
}
function hostPublicCertificate(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const before = fstatSync(fd); if (!before.isFile() || before.uid !== process.getuid() || before.size > 8192) throw new Error("public-certificate-file");
    const buffer = Buffer.alloc(8193); const size = readSync(fd, buffer, 0, buffer.length, 0); const after = fstatSync(fd);
    if (size !== before.size || before.size !== after.size || before.ctimeMs !== after.ctimeMs || before.mtimeMs !== after.mtimeMs) throw new Error("public-certificate-transition");
    const value = buffer.subarray(0, size).toString();
    if (!/^-----BEGIN CERTIFICATE-----\r?\n[\s\S]+\r?\n-----END CERTIFICATE-----\r?\n?$/.test(value) || value.includes("PRIVATE KEY")) throw new Error("public-certificate-shape");
    return value;
  } finally { closeSync(fd); }
}
export function observeHostPublication({ docker, network, owner, selected, id, container, candidate, runId, publicCertificate },
  { directory = hostPublicationDirectory, maximumMs = 15000, now = Date.now, wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } = {}) {
  const until = now() + Math.min(15000, maximumMs); let requestPath;
  try {
    const dir = lstatSync(directory);
    if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid() || (dir.mode & 0o777) !== 0o700) return { category: "observer-not-private" };
    const ready = privateHostObservation(join(directory, "ready.json"));
    if (!/^[a-f0-9]{40}$/.test(candidate ?? "") || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(runId ?? "")
      || ready.candidate !== candidate || ready.runId !== runId || ready.schemaVersion !== 1 || !/^[a-f0-9]{32}$/.test(ready.nonce) || !Number.isSafeInteger(ready.expiresAtMs)
      || ready.expiresAtMs <= now() || ready.expiresAtMs > now() + 7200000) return { category: "observer-not-ready" };
    const endpoint = container.NetworkSettings?.Networks?.[network];
    if (!/^hc-[a-f0-9]{16}$/.test(owner) || !/^[a-f0-9]{64}$/.test(id) || container.Id !== id
      || container.Config?.Labels?.["io.myskills.host-rehearsal"] !== owner || container.Config?.Labels?.["io.myskills.host-rehearsal.role"] !== "backup"
      || !/^[a-f0-9]{64}$/.test(endpoint?.EndpointID ?? "") || endpoint.NetworkID !== selected.networkId
      || endpoint.Gateway !== selected.gateway || isIP(endpoint.IPAddress) !== 4 || endpoint.IPAddress === selected.gateway
      || ipv4Number(endpoint.IPAddress) >>> (32 - Number(selected.subnet.split("/")[1])) !== ipv4Number(selected.gateway) >>> (32 - Number(selected.subnet.split("/")[1]))
      || container.State?.Status !== "running" || container.State.Running !== true || container.State.Paused !== false || container.State.Restarting !== false) return { category: "identity-rejected" };
    const token = randomBytes(16).toString("hex"); requestPath = join(directory, "request.json");
    // No Env, mounts, credentials, names or source data. Addresses stay private.
    const request = { schemaVersion: 1, candidate, runId, nonce: ready.nonce, token, owner, containerId: id, networkId: selected.networkId,
      endpointId: endpoint.EndpointID, gateway: selected.gateway, address: endpoint.IPAddress, publicCertificate, deadlineMs: until - 3000 };
    const temporary = join(directory, `${token}.tmp`);
    writeFileSync(temporary, JSON.stringify(request), { flag: "wx", mode: 0o600 }); renameSync(temporary, requestPath);
    let result;
    while (now() < until - 3000) {
      try { result = privateHostObservation(join(directory, `${token}.json`)); break; }
      catch (error) { if (error.code !== "ENOENT") return { category: "observer-output-invalid" }; }
      wait(Math.min(50, Math.max(1, until - 3000 - now())));
    }
    if (!result) return { category: "observer-deadline" };
    if (result.candidate !== candidate || result.runId !== runId || result.token !== token || result.nonce !== ready.nonce || result.containerId !== id || result.networkId !== selected.networkId
      || result.endpointId !== endpoint.EndpointID) return { category: "observer-identity-rejected" };
    const categories = ["observed", "unavailable", "namespace-changed", "output-invalid", "command-failed"];
    if (!categories.includes(result.category) || !["bridgeAddress", "forwarding", "listener"].every(key => ["present", "absent", "unavailable"].includes(result[key]))) return { category: "observer-output-invalid" };
    if (now() >= until) return { category: "observer-deadline" };
    const tlsCategories = ["ready", "not-ready", "tls-rejected", "unreachable", "deadline", "unavailable"];
    if (!tlsCategories.includes(result.ubuntuTls) || result.backendTls !== "unavailable" || !["confirmed", "unconfirmed"].includes(result.adapterTermination)) return { category: "observer-output-invalid" };
    let dockerPort = "unavailable";
    if (now() < until - 1500) {
      try {
      const published = docker(["port", id, "9000/tcp"], { timeout: Math.min(750, until - now() - 1500), maxBuffer: 2048, killSignal: "SIGKILL" });
      if (!published.error && !published.signal && published.status === 0 && typeof published.stdout === "string" && Buffer.byteLength(published.stdout) <= 2048) {
        const output = published.stdout.trim();
        dockerPort = !output ? "empty" : /^[1-9][0-9]{0,4}$/.test(result.observedPort ?? "") && Number(result.observedPort) <= 65535
          && output === `${selected.gateway}:${result.observedPort}` ? "matches-observed" : "other";
      }
      } catch { /* fixed unavailable category; primary failure remains */ }
    }
    if (now() >= until) return { category: "observer-deadline" };
    const checked = docker(["container", "inspect", id], { timeout: Math.min(1500, until - now()), maxBuffer: 128 * 1024, killSignal: "SIGKILL" });
    if (checked.error || checked.signal || checked.status !== undefined && checked.status !== 0 || typeof checked.stdout !== "string" || Buffer.byteLength(checked.stdout) > 128 * 1024) return { category: "capture-failed" };
    const current = inspection(checked, "publication-diagnostic");
    const actual = current.NetworkSettings?.Networks?.[network];
    if (current.Id !== id || current.Config?.Labels?.["io.myskills.host-rehearsal"] !== owner || current.Config?.Labels?.["io.myskills.host-rehearsal.role"] !== "backup"
      || current.State?.Status !== "running" || current.State.Running !== true || current.State.Paused !== false || current.State.Restarting !== false
      || ["NetworkID", "EndpointID", "IPAddress", "Gateway"].some(key => actual?.[key] !== endpoint[key])
      || current.RestartCount !== container.RestartCount || current.State.StartedAt !== container.State.StartedAt) return { category: "identity-changed" };
    return { category: result.category, bridgeAddress: result.bridgeAddress, forwarding: result.forwarding, listener: result.listener,
      identityStable: true, ubuntuTls: result.ubuntuTls, backendTls: result.backendTls, adapterTermination: result.adapterTermination, dockerPort, acceptanceRecovered: false };
  } catch (error) { return { category: error.code === "ENOENT" ? "observer-not-armed" : "capture-failed" }; }
  finally { if (requestPath) { try { unlinkSync(requestPath); } catch { /* observer files are private, never fixture resources */ } } }
}

/** Only fixed operation names and process status leave the fixture boundary. */
export function hostCommandFailure(command, args, result) {
  const verb = ["run", "compose", "network", "container", "build", "pull", "push", "tag", "inspect", "req", "rev-parse", "status"].includes(args[0]) ? args[0] : "command";
  const tool = command === "openssl" ? "openssl" : command === "git" ? "git" : command === "sh" ? "operator" : "docker";
  const role = args.find(value => /^io\.myskills\.host-rehearsal\.role=(backup|registry|driver)$/.test(value))?.split("=")[1];
  const sub = ["create", "inspect", "connect", "rm", "up", "run", "pull", "config", "stop"].includes(args[1]) ? args[1] : null;
  // Classification reports only a known daemon rejection category, never raw text.
  const category = commandErrorCategory(result.stderr);
  const reason = category === "none" ? "unclassified" : category;
  return { operation: [tool, verb, sub, role].filter(Boolean).join("."),
    exitStatus: Number.isInteger(result.status) ? result.status : null,
    signal: ["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT"].includes(result.signal) ? result.signal : null,
    processErrorCode: ["ETIMEDOUT", "ENOENT", "EACCES", "EPERM", "ENOBUFS"].includes(result.error?.code) ? result.error.code : null, reason };
}

export function assertHostCommandSucceeded(command, args, result) {
  if (result.status !== 0 || result.error || result.signal) {
    const error = new Error("bounded-command-failed");
    error.hostFailure = hostCommandFailure(command, args, result);
    throw error;
  }
}
