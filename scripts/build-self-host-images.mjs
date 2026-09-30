#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { git, parseOptions, planSelfHostImages } from "./lib/self-host-release.mjs";

try {
  const options = parseOptions(process.argv.slice(2), ["--source", "--out", "--platform"], ["--execute"]);
  if (options.help) console.log("Usage: node scripts/build-self-host-images.mjs --source <full-commit-SHA> --out <external-absent-directory> [--platform linux/amd64,linux/arm64] [--execute]\nDefaults to a plan. --execute builds local OCI archives only; never pushes or loads images.");
  else {
    if (!options.source || !options.out) throw new Error("--source and --out are required.");
    const root = process.cwd();
    const plan = planSelfHostImages({ root, commit: options.source, outputDir: options.out, ...(options.platform ? { platforms: options.platform.split(",") } : {}) });
    if (options.execute) {
      const output = resolve(options.out);
      mkdirSync(output);
      mkdirSync(plan.context.path);
      const archive = resolve(output, ".source.tar");
      try {
        writeFileSync(archive, git(root, ["archive", "--format=tar", plan.source.commit], { encoding: null }), { flag: "wx" });
        execFileSync("tar", ["-xf", archive, "-C", plan.context.path], { stdio: "inherit" });
        for (const build of plan.builds) execFileSync(build.command[0], build.command.slice(1), { stdio: "inherit" });
        plan.execution = "local-oci-build-completed";
      } catch { throw new Error("Local OCI build failed; partial output is preserved. No image publication was requested."); }
      finally { rmSync(archive, { force: true }); rmSync(plan.context.path, { recursive: true, force: true }); }
      writeFileSync(resolve(output, "build-plan.json"), JSON.stringify(plan, null, 2) + "\n", { flag: "wx" });
    }
    console.log(JSON.stringify(plan, null, 2));
  }
} catch (error) {
  console.error(`Self-host release: ${error.code ? "Filesystem operation failed." : error.message}`);
  process.exitCode = 1;
}
