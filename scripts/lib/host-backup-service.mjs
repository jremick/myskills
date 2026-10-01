import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";

// These fixed fields can cross the protected HOST evidence boundary. Never copy
// daemon error text, inspect payloads, container environment or credentials.
function invalidBackupNetwork(reason, container) {
  const error = new Error("HOST_BACKUP_NETWORK_INVALID");
  const state = container?.State;
  error.hostFailure = { operation: "docker.network.backup-endpoint", reason,
    ...(container ? { containerStatus: ["created", "running", "paused", "restarting", "removing", "exited", "dead"].includes(state?.Status) ? state.Status : "unknown",
      containerExitCode: Number.isInteger(state?.ExitCode) && state.ExitCode >= 0 && state.ExitCode <= 255 ? state.ExitCode : null,
      containerErrorCategory: commandErrorCategory(state?.Error) } : {}) };
  throw error;
}
function commandErrorCategory(value) {
  const text = typeof value === "string" ? value.slice(0, 16_384) : "";
  return !text ? "none" : /user specified IP address|user configured subnets|invalid.*subnet|invalid.*ip address/i.test(text) ? "ipam-rejected"
    : /address already in use|port is already allocated/i.test(text) ? "port-unavailable"
      : /cannot connect to the Docker daemon/i.test(text) ? "daemon-unavailable"
        : /permission denied|access denied/i.test(text) ? "permission-denied" : "unclassified";
}
const ipv4Number = value => value.split(".").reduce((number, octet) => number * 256 + Number(octet), 0);
/** Exact owned bridge identity, dynamic IPAM and a usable assigned IPv4 gateway. */
function ownedGateway(response, network, owner) {
  let row;
  try { row = JSON.parse(response.stdout)[0]; } catch { return invalidBackupNetwork("network-inspect-invalid"); }
  if (row?.Name !== network || row.Driver !== "bridge" || row.Scope !== "local" || !/^[a-f0-9]{64}$/.test(row.Id ?? "") || row.Labels?.["io.myskills.host-rehearsal"] !== owner) return invalidBackupNetwork("network-identity-invalid");
  const configurations = Array.isArray(row.IPAM?.Config) ? row.IPAM.Config.filter(value => typeof value?.Gateway === "string" && isIP(value.Gateway) === 4) : [];
  if (configurations?.length !== 1) return invalidBackupNetwork("network-gateway-absent");
  const { Gateway: gateway, Subnet: subnet } = configurations[0];
  const parts = typeof subnet === "string" ? subnet.split("/") : [];
  const prefix = Number(parts[1]);
  if (parts.length !== 2 || isIP(parts[0]) !== 4 || !Number.isInteger(prefix) || prefix < 1 || prefix > 30 || /^(0|127|169\.254|22[4-9]|2[3-5]\d)\./.test(gateway)) return invalidBackupNetwork("network-subnet-invalid");
  const block = 2 ** (32 - prefix), start = Math.floor(ipv4Number(parts[0]) / block) * block, address = ipv4Number(gateway);
  if (address <= start || address >= start + block - 1) return invalidBackupNetwork("network-gateway-outside");
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
  const selected = ownedGateway(docker(["network", "inspect", network]), network, owner);
  const certs = join(proof, "certs"); mkdirSync(certs, { mode: 0o700 });
  call("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", join(certs, "private.key"),
    "-out", join(certs, "public.crt"), "-subj", "/CN=MySkills disposable backup", "-addext", `subjectAltName=IP:${selected.gateway}`]);
  chmodSync(join(certs, "private.key"), 0o600);
  // Docker's env-file preserves literal dollars; never export these values in diagnostics.
  writeFileSync(join(proof, "backup-minio.env"), `MINIO_ROOT_USER=${user}\nMINIO_ROOT_PASSWORD=${password}\n`, { mode: 0o600 });
  const id = runService("backup", ["--network", network, "--publish", `${selected.gateway}::9000`, "--env-file", join(proof, "backup-minio.env"),
    "--mount", `type=bind,source=${certs},target=/certs,readonly`], image, ["server", "/data", "--certs-dir", "/certs"]);
  if (!/^[a-f0-9]{64}$/.test(id ?? "")) return invalidBackupNetwork("container-create-id-invalid");
  // Read back the exact daemon-assigned port and owner; never infer an endpoint.
  let container;
  try { container = JSON.parse(docker(["container", "inspect", id]).stdout)[0]; } catch { return invalidBackupNetwork("container-inspect-invalid"); }
  const ports = container?.NetworkSettings?.Ports?.["9000/tcp"];
  if (container?.Id !== id || container.Config?.Labels?.["io.myskills.host-rehearsal"] !== owner || container.Config?.Labels?.["io.myskills.host-rehearsal.role"] !== "backup") return invalidBackupNetwork("container-identity-invalid", container);
  if (container.State?.Status !== "running" || container.State.Running !== true || container.State.Paused !== false || container.State.Restarting !== false) return invalidBackupNetwork("container-not-running", container);
  if (container.NetworkSettings?.Networks?.[network]?.NetworkID !== selected.networkId) return invalidBackupNetwork("container-network-invalid", container);
  if (!Array.isArray(ports) || ports.length === 0) return invalidBackupNetwork("port-binding-absent", container);
  if (ports.length !== 1) return invalidBackupNetwork("port-binding-count-invalid", container);
  if (ports[0]?.HostIp !== selected.gateway) return invalidBackupNetwork("port-binding-address-invalid", container);
  if (!/^[1-9][0-9]{0,4}$/.test(ports[0].HostPort) || Number(ports[0].HostPort) > 65535) return invalidBackupNetwork("port-binding-number-invalid", container);
  const current = ownedGateway(docker(["network", "inspect", network]), network, owner);
  if (current.gateway !== selected.gateway || current.networkId !== selected.networkId) return invalidBackupNetwork("network-changed", container);
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
