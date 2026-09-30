import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveHostBaseline } from "../lib/self-host-baseline.mjs";

test("one-commit canonical source obtains and verifies the exact baseline through the bounded public-fetch contract", (t) => {
  const root = mkdtempSync(join(tmpdir(), "myskills-baseline-test-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = join(root, "origin"); mkdirSync(repository);
  const git = (args, cwd = repository) => {
    const result = spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@operator.test", ...args], { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git(["init", "--quiet"]); writeFileSync(join(repository, "baseline.txt"), "baseline fixture\n"); git(["add", "."]); git(["commit", "--quiet", "-m", "baseline"]);
  const baseline = git(["rev-parse", "HEAD"]);
  writeFileSync(join(repository, "candidate.txt"), "candidate fixture\n"); git(["add", "."]); git(["commit", "--quiet", "-m", "candidate"]);
  const snapshot = join(root, "snapshot"); git(["clone", "--quiet", "--depth=1", `file://${repository}`, snapshot]);
  assert.equal(git(["rev-list", "--count", "HEAD"], snapshot), "1");
  let fetches = 0;
  const run = (command, args, options) => {
    if (args.includes("fetch")) {
      fetches++; assert.ok(args.includes("https://github.com/jremick/myskills.git")); assert.equal(args.at(-1), baseline);
      assert.equal(options.env.GIT_TERMINAL_PROMPT, "0"); assert.equal(options.env.GIT_CONFIG_GLOBAL, process.env.GIT_CONFIG_GLOBAL);
      args = args.map((arg) => arg === "https://github.com/jremick/myskills.git" ? `file://${repository}` : arg === "protocol.file.allow=never" ? "protocol.file.allow=always" : arg);
    }
    return spawnSync(command, args, options);
  };
  const source = resolveHostBaseline(snapshot, join(root, "private-baseline.git"), { commit: baseline, run });
  assert.equal(fetches, 1); assert.equal(source.mode, "public-exact-fetch"); assert.equal(git(["rev-parse", `${baseline}^{commit}`], source.repository), baseline);
  assert.equal(resolveHostBaseline(repository, join(root, "unused"), { commit: baseline, run }).mode, "source-history");
  assert.equal(fetches, 1);
});

test("failed fetch and wrong source identity fail closed without asking for credentials", () => {
  let calls = 0;
  assert.throws(() => resolveHostBaseline("/fixture/source", "/fixture/owned/baseline.git", { run: (_command, args, options) => {
    calls++; assert.equal(options.env.GIT_ASKPASS, "/bin/false");
    return { status: args.includes("init") ? 0 : 1, stdout: "", stderr: "withheld" };
  } }), /fetch failed/);
  assert.equal(calls, 3);
  assert.throws(() => resolveHostBaseline("/fixture/source", "/fixture/owned/baseline.git", { run: () => ({ status: 0, stdout: "a".repeat(40), stderr: "" }) }), /identity differs/);
});
