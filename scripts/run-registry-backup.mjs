#!/usr/bin/env node
import { backupConfiguration, registryBackupStatus, runRegistryBackup } from "./lib/registry-backup.mjs";
import { armProcessDeadline } from "./lib/registry-recovery.mjs";

const args = process.argv.slice(2);
try {
  if (args.length !== 1 || !["--help", "--plan", "--execute", "--status"].includes(args[0])) throw new Error("Invalid backup arguments.");
  if (args[0] === "--help") {
    console.log("Usage: node scripts/run-registry-backup.mjs --plan | --execute | --status");
    console.log("One coordinated database/artifact backup, or a read-only 26-hour freshness check. See docs/BACKUPS.md.");
  } else {
    const config = backupConfiguration(process.env, args[0] === "--status" ? "status" : "execute");
    if (args[0] === "--plan") {
      console.log(JSON.stringify({ sourceReadOnly: true, separateBackupBucket: true, retentionDays: config.retentionDays,
        maximumBytesPerArchiveOrArtifacts: config.maximumBytes, timeoutMs: config.timeoutMs, scheduleEnabledByThisScript: false }));
    } else {
      const deadline = args[0] === "--status" ? Math.min(config.timeoutMs, 60_000) : config.timeoutMs;
      // Last resort if a third-party handle ignores cancellation. Railway does not kill stuck cron jobs.
      armProcessDeadline(deadline);
      const report = args[0] === "--status" ? await registryBackupStatus() : await runRegistryBackup();
      console.log(JSON.stringify(report));
      process.exitCode = report.passed ? 0 : 1;
    }
  }
} catch { console.error(JSON.stringify({ passed: false, failedPhase: "configuration-or-backup", guidance: "See docs/BACKUPS.md; raw provider errors are withheld." })); process.exitCode = 1; }
