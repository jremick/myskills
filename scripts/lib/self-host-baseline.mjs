import { spawnSync } from "node:child_process";

export const hostBaselineCommit = "c74ecd33ce987d24ef5ddf40a0fef98f1a50fc9b";
const publicSource = "https://github.com/jremick/myskills.git";

// The canonical controller snapshots only HEAD. Fetch this single public commit
// into the caller's already ledger-owned private directory when it is absent.
export function resolveHostBaseline(sourceRoot, destination, { commit = hostBaselineCommit, run = spawnSync } = {}) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Baseline requires an exact full commit.");
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/false" };
  const git = (cwd, args) => run("git", ["-c", "credential.helper=", "-c", "http.followRedirects=false",
    "-c", "protocol.file.allow=never", "-c", "transfer.fsckObjects=true", "-c", "fetch.fsckObjects=true",
    "-c", "http.lowSpeedLimit=1024", "-c", "http.lowSpeedTime=30", ...args],
  { cwd, env, encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024 });
  const identify = (cwd) => git(cwd, ["rev-parse", "--verify", `${commit}^{commit}`]);
  const existing = identify(sourceRoot);
  if (existing.status === 0 && existing.stdout.trim() === commit) return { repository: sourceRoot, commit, mode: "source-history" };
  if (git(sourceRoot, ["init", "--bare", "--quiet", destination]).status !== 0) throw new Error("Could not reserve private baseline Git source.");
  if (git(destination, ["fetch", "--quiet", "--no-tags", "--depth=1", publicSource, commit]).status !== 0) throw new Error("Exact public baseline fetch failed; no fallback or auth path was used.");
  const fetched = identify(destination);
  if (fetched.status !== 0 || fetched.stdout.trim() !== commit) throw new Error("Fetched baseline commit identity differs.");
  return { repository: destination, commit, mode: "public-exact-fetch", publicSource };
}
