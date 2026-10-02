#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

// Local compatibility/negative evidence. This never connects a human host account.
const root = process.cwd();
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--out") throw new Error("Usage: verify-trust-mcp.mjs --out dist/trust-evidence");
const out = resolve(args[1]);
const local = relative(resolve(root, "dist"), out);
if (!local || local.startsWith("..") || isAbsolute(local)) throw new Error("Evidence must use a fresh subdirectory of dist.");
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
if (git("status", "--porcelain", "--untracked-files=all")) throw new Error("Commit first: exact-revision evidence requires a clean checkout.");
for (let dir = resolve(root, "dist"); dir !== out; ) {
  try { if (lstatSync(dir).isSymbolicLink()) throw new Error("Evidence directory must not traverse symbolic links."); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const rest = relative(dir, out).split(/[\\/]/);
  if (!rest.length || rest[0] === "") break;
  dir = resolve(dir, rest[0]);
}
mkdirSync(resolve(out, ".."), { recursive: true });
mkdirSync(out);
const suites = [
  { id: "api-artifact-stream", files: ["apps/api/test/artifact-stream.e2e.test.ts", "apps/api/test/artifact-storage.test.ts"] },
  { id: "api-mcp-delivery", files: ["apps/mcp/test/trust-delivery.e2e.test.ts", "apps/mcp/test/read-skill-file.test.ts", "apps/mcp/test/skills.test.ts"] },
  { id: "mcp-wire-compatibility", files: ["apps/mcp/test/skills-wire.test.ts"] },
  { id: "oauth-action-audit", files: ["apps/mcp/test/application-parity.e2e.test.ts", "apps/api/test/delegated-actions.e2e.test.ts"] },
  { id: "provenance-cli", files: ["scripts/test/trust-provenance.e2e.test.mjs"], plainJs: true },
];
const results = [];
for (const suite of suites) {
  const result = spawnSync(process.execPath, [...(suite.plainJs ? [] : ["--import", "tsx"]), "--test", "--test-reporter=tap", ...suite.files], {
    cwd: root, encoding: "utf8", timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: "en_US.UTF-8", CI: "true" },
  });
  const raw = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const log = raw.replace(/Bearer\s+[^\s"'\\]+/gi, "Bearer [redacted]")
    .replace(/\b(?:aiss_|myskills_at\.|myskills_rt\.)[A-Za-z0-9._~+/-]+/g, "[redacted-credential]");
  const number = (name) => Number(new RegExp(`^# ${name} (\\d+)$`, "m").exec(log)?.[1] ?? -1);
  const passed = result.status === 0 && number("tests") > 0 && number("fail") === 0 && number("skipped") === 0 && number("cancelled") === 0;
  const file = `${suite.id}.tap`;
  writeFileSync(resolve(out, file), log, { flag: "wx" });
  results.push({ id: suite.id, files: suite.files, status: passed ? "passed" : "failed", exitCode: result.status, tests: number("tests"), passed: number("pass"), failed: number("fail"), skipped: number("skipped"), log: { file, sha256: hash(log) } });
  console.log(`${suite.id}: ${passed ? "passed" : "failed"} (${number("tests")} checks)`);
}
const summary = {
  schemaVersion: 1, sourceRevision: git("rev-parse", "HEAD"), node: process.version,
  status: results.every(result => result.status === "passed") ? "passed" : "failed",
  evidenceLevel: "local API/MCP sockets and memory domain stores; real SDK S3 stream against loopback fixture",
  officialConformanceCertification: false, postgres: "not_run", deployedMinio: "not_run", realHostAcceptance: "not_run", releaseSigning: "not_run",
  suites: results,
};
writeFileSync(resolve(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" });
if (summary.status !== "passed") process.exitCode = 1;
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
