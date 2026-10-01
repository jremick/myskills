import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";

const containerStatuses = ["created", "running", "paused", "restarting", "removing", "exited", "dead"];
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const safeExitCode = value => Number.isSafeInteger(value) && value >= 0 && value <= 255 ? value : null;
const validPort = value => typeof value === "string" && /^[1-9][0-9]{0,4}$/.test(value) && Number(value) <= 65535;
const metadataShape = value => value === undefined ? "missing" : value === null ? "null" : Array.isArray(value) ? "array" : isRecord(value) ? "object" : "scalar";
const metadataMapCount = value => isRecord(value) ? Math.min(Object.keys(value).length, 8) : null;
function portMetadata(container, network, gateway) {
  const exposed = container.Config?.ExposedPorts, requested = container.HostConfig?.PortBindings, runtime = container.NetworkSettings?.Ports;
  const bindings = runtime?.["9000/tcp"], mode = container.HostConfig?.NetworkMode;
  // Fixed fields and capped counts only. No map keys, addresses, Env or values
  // leave this boundary, even when the daemon returns an unexpected shape.
  const rows = Array.isArray(bindings) ? bindings.slice(0, 8) : [];
  return { networkModeCategory: mode === network ? "owned-bridge" : mode === undefined ? "missing" : ["host", "none", "bridge", "default"].includes(mode) ? mode : "other",
    networkAttachmentCount: metadataMapCount(container.NetworkSettings?.Networks),
    exposedMapShape: metadataShape(exposed), exposedPortCount: metadataMapCount(exposed), exposedPortShape: metadataShape(exposed?.["9000/tcp"]),
    requestedMapShape: metadataShape(requested), requestedPortCount: metadataMapCount(requested), requestedBindingsShape: metadataShape(requested?.["9000/tcp"]),
    requestedBindingCount: Array.isArray(requested?.["9000/tcp"]) ? Math.min(requested["9000/tcp"].length, 8) : null,
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
  const configurations = Array.isArray(row.IPAM?.Config) ? row.IPAM.Config.filter(value => typeof value?.Gateway === "string" && isIP(value.Gateway) === 4) : [];
  if (configurations.length !== 1) return invalidBackupNetwork(stage, "network-ipam-invalid");
  const { Gateway: gateway, Subnet: subnet } = configurations[0];
  const parts = typeof subnet === "string" ? subnet.split("/") : [];
  const prefix = Number(parts[1]);
  if (parts.length !== 2 || isIP(parts[0]) !== 4 || !Number.isInteger(prefix) || prefix < 1 || prefix > 30 || /^(0|127|169\.254|22[4-9]|2[3-5]\d)\./.test(gateway)) return invalidBackupNetwork(stage, "network-gateway-invalid");
  const block = 2 ** (32 - prefix), start = Math.floor(ipv4Number(parts[0]) / block) * block, address = ipv4Number(gateway);
  if (address <= start || address >= start + block - 1) return invalidBackupNetwork(stage, "network-gateway-invalid");
  return { gateway, networkId: row.Id };
}

/** One TLS-valid gateway endpoint serves the host driver, bridge and recovery. */
export function prepareHostBackupService({ proof, owner, image, user, password, reserve, mark, docker, call, runService }) {
  assert.match(owner, /^hc-[a-f0-9]{16}$/);
  assert.ok([user, password].every(value => typeof value === "string" && !/[\r\n\0]/.test(value)));
  const network = `${owner}-backup-network`;
  reserve("network", network);
  docker(["network", "create", "--driver", "bridge", "--label", `io.myskills.host-rehearsal=${owner}`, network]);
  mark("network", network);
  const selected = ownedGateway(docker(["network", "inspect", network]), network, owner, "initial-network");
  const certs = join(proof, "certs"); mkdirSync(certs, { mode: 0o700 });
  call("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", join(certs, "private.key"),
    "-out", join(certs, "public.crt"), "-subj", "/CN=MySkills disposable backup", "-addext", `subjectAltName=IP:${selected.gateway}`]);
  chmodSync(join(certs, "private.key"), 0o600);
  // Docker's env-file preserves literal dollars; never export these values in diagnostics.
  writeFileSync(join(proof, "backup-minio.env"), `MINIO_ROOT_USER=${user}\nMINIO_ROOT_PASSWORD=${password}\n`, { mode: 0o600 });
  const id = runService("backup", ["--network", network, "--publish", `${selected.gateway}::9000`, "--env-file", join(proof, "backup-minio.env"),
    "--mount", `type=bind,source=${certs},target=/certs,readonly`], image, ["server", "/data", "--certs-dir", "/certs"]);
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
  if (!Array.isArray(ports) || ports.length !== 1 || !isRecord(ports[0])) return invalidBackupNetwork(stage, "published-port-shape-invalid", container, portMetadata(container, network, selected.gateway));
  if (ports[0].HostIp !== selected.gateway) return invalidBackupNetwork(stage, "published-port-address-mismatch", container);
  if (!validPort(ports[0].HostPort)) return invalidBackupNetwork(stage, "published-port-number-invalid", container);
  const current = ownedGateway(docker(["network", "inspect", network]), network, owner, "network-recheck");
  if (current.networkId !== selected.networkId) return invalidBackupNetwork("network-recheck", "network-id-changed");
  if (current.gateway !== selected.gateway) return invalidBackupNetwork("network-recheck", "network-gateway-changed");
  return { network, gateway: selected.gateway, port: Number(ports[0].HostPort), endpoint: `https://${selected.gateway}:${ports[0].HostPort}` };
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
