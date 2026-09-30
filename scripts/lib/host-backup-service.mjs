import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Stable DNS on the owned bridge works with Docker's default IPAM. */
export function prepareHostBackupService({ proof, owner, image, user, password, reserve, mark, docker, call, runService }) {
  assert.match(owner, /^hc-[a-f0-9]{16}$/);
  assert.ok([user, password].every(value => typeof value === "string" && !/[\r\n\0]/.test(value)));
  const network = `${owner}-backup-network`, hostname = `${owner}-backup`;
  reserve("network", network);
  docker(["network", "create", "--label", `io.myskills.host-rehearsal=${owner}`, network]);
  mark("network", network);
  const certs = join(proof, "certs"); mkdirSync(certs, { mode: 0o700 });
  call("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", join(certs, "private.key"),
    "-out", join(certs, "public.crt"), "-subj", "/CN=MySkills disposable backup", "-addext", `subjectAltName=DNS:${hostname}`]);
  chmodSync(join(certs, "private.key"), 0o600);
  // Docker's env-file preserves literal dollars; never export these values in diagnostics.
  writeFileSync(join(proof, "backup-minio.env"), `MINIO_ROOT_USER=${user}\nMINIO_ROOT_PASSWORD=${password}\n`, { mode: 0o600 });
  runService("backup", ["--network", network, "--network-alias", hostname, "--env-file", join(proof, "backup-minio.env"),
    "--mount", `type=bind,source=${certs},target=/certs,readonly`], image, ["server", "/data", "--certs-dir", "/certs"]);
  return { network, hostname, endpoint: `https://${hostname}:9000` };
}

/** Only fixed operation names and process status leave the fixture boundary. */
export function hostCommandFailure(command, args, result) {
  const verb = ["run", "compose", "network", "container", "build", "pull", "push", "tag", "inspect", "req", "rev-parse", "status"].includes(args[0]) ? args[0] : "command";
  const tool = command === "openssl" ? "openssl" : command === "git" ? "git" : command === "sh" ? "operator" : "docker";
  const role = args.find(value => /^io\.myskills\.host-rehearsal\.role=(backup|registry|driver)$/.test(value))?.split("=")[1];
  const sub = ["create", "inspect", "connect", "rm", "up", "run", "pull", "config", "stop"].includes(args[1]) ? args[1] : null;
  // Classification reports only a known daemon rejection category, never raw text.
  const stderr = typeof result.stderr === "string" ? result.stderr.slice(0, 16_384) : "";
  const reason = /user specified IP address|user configured subnets|invalid.*subnet|invalid.*ip address/i.test(stderr) ? "ipam-rejected"
    : /address already in use|port is already allocated/i.test(stderr) ? "port-unavailable"
      : /cannot connect to the Docker daemon/i.test(stderr) ? "daemon-unavailable"
        : /permission denied|access denied/i.test(stderr) ? "permission-denied" : "unclassified";
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
