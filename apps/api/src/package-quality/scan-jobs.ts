import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { DatabaseTransaction } from "../db/client.js";

/** Change on a scanner/policy change; do not reuse evidence from another runner. */
export const PACKAGE_SCAN_RUNNER_VERSION = "package-scan-v1";
export const PACKAGE_SCAN_MAX_ATTEMPTS = 3;
export const PACKAGE_SCAN_LEASE_MS = 120_000;

export interface PackageScanClaim {
  jobId: string;
  leaseId: string;
  scanRunId: string;
  versionId: string;
  artifactSha256: string;
  runnerVersion: string;
  attempt: number;
}

/** Called inside the version/artifact transaction, including Library/draft import hooks. */
export async function enqueuePackageScan(tx: DatabaseTransaction, input: { versionId: string; artifactSha256: string }): Promise<void> {
  const jobId = randomUUID();
  const scanRunId = randomUUID();
  const payload = { ...input, runnerVersion: PACKAGE_SCAN_RUNNER_VERSION, scanRunId };
  await tx.execute(sql`INSERT INTO jobs (id, type, payload, dedupe_key)
    VALUES (${jobId}::uuid, 'package-scan', ${JSON.stringify(payload)}::jsonb,
      ${`${input.versionId}:${input.artifactSha256}:${PACKAGE_SCAN_RUNNER_VERSION}`})`);
  await tx.execute(sql`INSERT INTO scan_runs (id, skill_version_id, artifact_sha256, runner_version, job_id, attempt)
    VALUES (${scanRunId}::uuid, ${input.versionId}::uuid, ${input.artifactSha256}, ${PACKAGE_SCAN_RUNNER_VERSION}, ${jobId}::uuid, 1)`);
}
