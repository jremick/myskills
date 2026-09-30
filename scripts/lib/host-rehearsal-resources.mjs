import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

// The controller owns the parent directory. This exact-name child ledger covers
// transient operator containers as well as the resources planned by the fixture.
export function saveHostLedger(path, value) {
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

export function hostDocker(path, executable, args) {
  const ledger = JSON.parse(readFileSync(path, "utf8"));
  let name;
  if (args[0] === "run") {
    name = `${ledger.owner}-op-${++ledger.sequence}`;
    ledger.resources.push({ kind: "container", name, state: "creating" });
    saveHostLedger(path, ledger); // Reserve BEFORE the daemon can create it.
    args = ["run", "--name", name, "--label", `io.myskills.host-rehearsal=${ledger.owner}`, ...args.slice(1)];
  }
  const result = spawnSync(executable, args, { stdio: "inherit" });
  if (name && result.status === 0) {
    const completed = JSON.parse(readFileSync(path, "utf8"));
    completed.resources.find((resource) => resource.name === name).state = "created";
    saveHostLedger(path, completed);
  }
  return result;
}

export function cleanupHostLedger(path, executable = "docker") {
  if (!existsSync(path)) return ["host-ledger-missing"];
  const ledger = JSON.parse(readFileSync(path, "utf8"));
  if (ledger.schemaVersion !== 1 || !/^hc-[a-f0-9]{16}$/.test(ledger.owner) || !Array.isArray(ledger.resources)
    || ledger.resources.length > 512) return ["host-ledger-invalid"];
  const failures = [];
  const docker = (args) => spawnSync(executable, args, { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
  for (const resource of [...ledger.resources].reverse()) {
    if (!["created", "creating", "remove-failed"].includes(resource.state)) continue;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,240}$/.test(resource.name) || !resource.name.includes(ledger.owner)) {
      failures.push("host-resource-invalid"); continue;
    }
    let result;
    if (resource.kind === "compose-project") {
      const filter = `label=com.docker.compose.project=${resource.name}`;
      const remove = (kind, list) => {
        const listed = docker(list);
        if (listed.status !== 0) return false;
        const ids = listed.stdout.trim().split(/\s+/).filter(Boolean);
        if (!ids.every((id) => /^[a-f0-9]{12,64}$/.test(id))) return false;
        return ids.length === 0 || docker([kind, "rm", ...(kind === "container" ? ["-f", "-v"] : []), ...ids]).status === 0;
      };
      result = remove("container", ["ps", "-aq", "--filter", filter]);
      result = remove("network", ["network", "ls", "-q", "--filter", filter]) && result;
      // Docker volume names are validated and removed by exact label/name, never prefix.
      const volumes = docker(["volume", "ls", "-q", "--filter", filter]);
      const names = volumes.stdout.trim().split(/\s+/).filter(Boolean);
      result = volumes.status === 0 && names.every((name) => /^[a-zA-Z0-9_.-]+$/.test(name))
        && (names.length === 0 || docker(["volume", "rm", ...names]).status === 0) && result;
    } else if (["container", "network", "image"].includes(resource.kind)) {
      if (resource.state === "creating") resource.creationUnconfirmed = true;
      const inspected = docker([resource.kind, "inspect", resource.name]);
      if (inspected.status !== 0) {
        // An interrupted create can still finish in the daemon after its CLI
        // dies. Retain the reservation rather than treating absence as proof.
        result = !resource.creationUnconfirmed && /No such|not found/i.test(inspected.stderr);
      } else if (resource.kind === "container" || resource.kind === "network") {
        const identity = JSON.parse(inspected.stdout)[0];
        const labels = resource.kind === "container" ? identity.Config.Labels : identity.Labels;
        result = labels?.["io.myskills.host-rehearsal"] === ledger.owner
          && docker([resource.kind, "rm", ...(resource.kind === "container" ? ["-f", "-v"] : []), resource.name]).status === 0;
      } else result = docker(["image", "rm", resource.name]).status === 0;
    } else result = false;
    resource.state = result ? "removed" : "remove-failed";
    if (!result) failures.push(`host-${resource.kind}-cleanup`);
    saveHostLedger(path, ledger);
  }
  ledger.cleanup = failures.length === 0 ? "complete" : "failed";
  saveHostLedger(path, ledger);
  return failures;
}
