#!/usr/bin/env node
import { backupConfiguration, restoreRegistryBackup, runPrefix } from "./lib/registry-backup.mjs";
import { armProcessDeadline } from "./lib/registry-recovery.mjs";

const args = process.argv.slice(2);
try {
  if (args.length === 1 && args[0] === "--help") {
    console.log("Usage: node scripts/restore-registry-backup.mjs --plan RUN_ID | --execute RUN_ID");
    console.log("Download a completed backup and restore only to new loopback PostgreSQL/S3 destinations. See docs/BACKUPS.md.");
  } else {
    if (args.length !== 2 || !["--plan", "--execute"].includes(args[0])) throw new Error("Invalid restore arguments.");
    const config = backupConfiguration(process.env, "restore");
    runPrefix(config, args[1]);
    if (args[0] === "--plan") console.log(JSON.stringify({ runId: args[1], destination: "new loopback database and object bucket", sourceConnections: false, timeoutMs: config.timeoutMs }));
    else {
      armProcessDeadline(config.timeoutMs);
      const { report, recoveryRoot } = await restoreRegistryBackup(process.env, args[1]);
      console.log(JSON.stringify(report));
      console.log(`Private recovery evidence: ${recoveryRoot}`);
      process.exitCode = report.passed ? 0 : 1;
    }
  }
} catch { console.error(JSON.stringify({ passed: false, failedPhase: "configuration-or-restore", guidance: "See docs/BACKUPS.md; raw provider errors are withheld." })); process.exitCode = 1; }
