#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { armProcessDeadline, captureSnapshot, createRecoveryDirectory, destinationConfiguration, postgresClient, recoveryDefaults,
  restoreSnapshot, snapshotStatus, sourceConfiguration, storageClient, withDeadline } from "./lib/registry-recovery.mjs";

/** No network or file changes. Restore destinations are always newly created on loopback. */
export function recoveryConfiguration(env = process.env) {
  return { ...recoveryDefaults(env), ...sourceConfiguration(env), ...destinationConfiguration(env), requireObjectBacked: true };
}

/** Preserve the original capture-and-rehearse workflow; never reset an existing destination. */
export async function rehearseRegistryRecovery(env = process.env, dependencies = {}) {
  const config = recoveryConfiguration(env);
  const recoveryRoot = await createRecoveryDirectory(config);
  const startedAt = new Date().toISOString();
  let failedPhase = "connect-source";
  let destinations = {};
  try {
    return await withDeadline(config.timeoutMs, async (signal) => {
      const source = (dependencies.postgresClient ?? postgresClient)(config.sourceDatabase, signal);
      const s3 = (dependencies.storageClient ?? storageClient)(config.sourceStorage);
      const context = { signal, phase: (value) => { failedPhase = value; }, onDestinations: (value) => { destinations = value; } };
      try {
        await source.connect();
        const manifest = await captureSnapshot(config, source, s3, recoveryRoot, context, dependencies.dumpDatabase);
        const destination = await restoreSnapshot(config, manifest, recoveryRoot, context, dependencies);
        const report = { schemaVersion: 1, passed: true, startedAt, completedAt: new Date().toISOString(),
          elapsedSeconds: Math.ceil((Date.now() - Date.parse(startedAt)) / 1000), ...snapshotStatus(manifest), ...destination };
        await writeFile(join(recoveryRoot, "report.json"), `${JSON.stringify(report)}\n`, { flag: "wx", mode: 0o600, signal });
        return { report, recoveryRoot };
      } finally { s3.destroy(); await source.end(); }
    });
  } catch {
    await writeFile(join(recoveryRoot, "failure.json"), `${JSON.stringify({ schemaVersion: 1, passed: false, startedAt, failedPhase, ...destinations })}\n`, { mode: 0o600 });
    throw new Error(`Recovery rehearsal failed during ${failedPhase}. Partial backup and isolated destinations were retained for operator inspection.`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log("Usage: node scripts/rehearse-registry-recovery.mjs --plan | --execute");
    console.log("Copies one consistent source snapshot to newly created loopback Postgres/S3 destinations. Backups contain private application data. See docs/BACKUPS.md.");
  } else if (args.length === 1 && ["--plan", "--execute"].includes(args[0])) {
    try {
      const config = recoveryConfiguration();
      if (args[0] === "--plan") {
        console.log(JSON.stringify({ sourceReadOnly: true, destination: "new loopback database and object bucket", maximumBytesPerArchiveOrArtifacts: config.maximumBytes }));
      } else {
        armProcessDeadline(config.timeoutMs);
        const { report, recoveryRoot } = await rehearseRegistryRecovery();
        console.log(JSON.stringify(report, null, 2));
        console.log(`Private recovery evidence: ${recoveryRoot}`);
      }
    } catch { console.error("Recovery rehearsal failed. Inspect the private failure report and configuration."); process.exitCode = 1; }
  } else { console.error("Use --plan or --execute. Run --help for prerequisites."); process.exitCode = 1; }
}
