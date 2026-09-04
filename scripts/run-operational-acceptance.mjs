#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runOperationalAcceptance } from "./operational-acceptance.mjs";

if (process.argv.includes("--help")) {
  console.log("Usage: node scripts/run-operational-acceptance.mjs --execute [--report /private/path/report.json]");
  console.log("Requires an existing local or verified staging API and built CLI. Creates isolated synthetic registry data; never resets a database. See docs/OPERATIONAL_ACCEPTANCE.md.");
} else {
  const args = process.argv.slice(2);
  const reportIndex = args.indexOf("--report");
  if (!args.includes("--execute") || args.some((arg, index) => arg !== "--execute" && arg !== "--report" && !(reportIndex >= 0 && index === reportIndex + 1)) || (reportIndex >= 0 && !args[reportIndex + 1])) {
    console.error("Use --execute and an optional --report path. Run --help for prerequisites.");
    process.exitCode = 1;
  } else {
    try {
      const report = await runOperationalAcceptance({ onCheck: (result) => console.log(`PASS ${result.name}`) });
      if (reportIndex >= 0) await writeFile(resolve(args[reportIndex + 1]), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      console.log(`Operational API/CLI acceptance passed (${report.checks.length} checks). Agent runtime recognition requires separate evidence.`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Operational acceptance failed.");
      process.exitCode = 1;
    }
  }
}
