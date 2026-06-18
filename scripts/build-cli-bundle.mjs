#!/usr/bin/env node

import { chmod, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");
const cliRoot = join(repoRoot, "apps", "cli");
const cliRequire = createRequire(join(cliRoot, "package.json"));
const { build } = cliRequire("esbuild");
const packageJson = JSON.parse(await readFile(join(cliRoot, "package.json"), "utf8"));
const outfile = join(cliRoot, "dist", "index.js");

await build({
  entryPoints: [join(cliRoot, "src", "index.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["@napi-rs/keyring"],
  banner: {
    js: "import { createRequire as __myskillsCreateRequire } from 'node:module'; const require = __myskillsCreateRequire(import.meta.url);",
  },
  define: {
    "process.env.MYSKILLS_CLI_VERSION": JSON.stringify(packageJson.version),
  },
});

await chmod(outfile, 0o755);
