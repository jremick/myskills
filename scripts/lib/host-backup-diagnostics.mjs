import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { hostBackupStartCommand } from "./host-backup-service.mjs";

// Identity is measured through one descriptor, with a finite byte budget. No
// private path, environment, Docker configuration or raw command output leaves.
function executableIdentity(executable) {
  let fd;
  try {
    const resolved = realpathSync(executable);
    fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile()) return { category: "not-regular", sha256: null };
    if (!(before.mode & 0o111)) return { category: "not-executable", sha256: null };
    if (before.size > 128 * 1024 * 1024) return { category: "size-limit", sha256: null };
    const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
    for (let offset = 0; offset < before.size;) {
      const bytes = readSync(fd, buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (!bytes) return { category: "file-changed", sha256: null };
      hash.update(buffer.subarray(0, bytes)); offset += bytes;
    }
    const after = fstatSync(fd);
    if (["dev", "ino", "mode", "size", "mtimeMs", "ctimeMs"].some(key => before[key] !== after[key])) return { category: "file-changed", sha256: null };
    return { category: "regular-executable", sha256: hash.digest("hex") };
  } catch { return { category: "identity-unavailable", sha256: null }; }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* diagnostic only */ } } }
}
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
function versionFields(value) {
  if (!record(value)) return { category: "missing-or-invalid" };
  const matching = (key, pattern) => typeof value[key] === "string" && pattern.test(value[key]) ? value[key] : null;
  return { category: "captured", version: matching("Version", /^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-(?:rc|beta|dev)\.?\d{0,3})?$/),
    gitCommit: matching("GitCommit", /^[a-f0-9]{7,40}$/i), apiVersion: matching("ApiVersion", /^\d{1,3}\.\d{1,3}$/),
    os: ["linux", "windows", "darwin"].includes(value.Os) ? value.Os : null,
    architecture: ["amd64", "arm64", "arm", "386", "ppc64le", "s390x", "riscv64"].includes(value.Arch) ? value.Arch : null };
}
export function captureHostDockerIdentity(executable) {
  const identity = executableIdentity(executable);
  try {
    const result = spawnSync(executable, ["version", "--format", "{{json .}}"], { encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024 });
    // A disconnected server can still leave a valid client JSON receipt.
    let version;
    try { version = JSON.parse(result.stdout); } catch { /* fixed category below */ }
    const category = result.error?.code === "ENOBUFS" ? "output-limit" : result.error?.code === "ETIMEDOUT" ? "timeout"
      : result.error || result.signal ? "command-unavailable" : result.status !== 0 ? "command-failed" : !record(version) ? "json-invalid" : "captured";
    return { executable: identity, version: { category, client: versionFields(version?.Client), server: versionFields(version?.Server) } };
  } catch { return { executable: identity, version: { category: "command-unavailable" } }; }
}

/** The owned backup caller supplies expectations; argv supplies observed facts. */
export function backupInvocationReceipt(args, contract, owner, name) {
  if (!record(contract) || contract.owner !== owner || !/^hc-[a-f0-9]{16}$/.test(owner)
    || contract.network !== `${owner}-backup-network` || typeof contract.gateway !== "string" || isIP(contract.gateway) !== 4
    || typeof contract.image !== "string" || !contract.image || contract.image.length > 256
    || ![contract.envFile, contract.certs].every(value => typeof value === "string" && isAbsolute(value))) return { category: "contract-invalid" };
  const expected = ["run", "--name", name, "--label", `io.myskills.host-rehearsal=${owner}`, "-d", "--label", "io.myskills.host-rehearsal.role=backup",
    "--network", contract.network, "--publish", "127.0.0.1::9000", "--env-file", contract.envFile,
    "--mount", `type=bind,source=${contract.certs},target=/certs,readonly`, "--entrypoint", "/bin/sh", contract.image, "-ec", hostBackupStartCommand];
  const same = (start, end) => args.slice(start, end).every((value, index) => value === expected[start + index]) && args.slice(start, end).length === end - start;
  const publishCount = args.filter(value => typeof value === "string" && (value === "--publish" || value === "-p" || value.startsWith("--publish=") || /^-p.+/.test(value))).length;
  const vectorMatches = args.length === expected.length && same(0, expected.length);
  return { category: vectorMatches ? "matched" : "mismatch", vectorMatches,
    ownershipMatches: same(0, 8) && typeof name === "string" && name.startsWith(`${owner}-op-`) && /^[1-9][0-9]*$/.test(name.slice(`${owner}-op-`.length)),
    networkMatches: same(8, 10), publishCount: Math.min(publishCount, 8), publishMatches: publishCount === 1 && same(10, 12),
    envFileMatches: same(12, 14), mountMatches: same(14, 16), entrypointMatches: same(16, 18), imagePositionMatches: same(18, 19) && args.length === expected.length,
    tailMatches: same(19, expected.length) && args.length === expected.length };
}
