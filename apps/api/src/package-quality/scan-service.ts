import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { AppError } from "@myskills-app/core";
import { hasBlockingFindings, loadStoredSkillManifestFromPackageFiles, scanPackageFiles, type ScanFinding } from "@myskills-app/skill-package";
import type { Database, DatabaseTransaction } from "../db/client.js";
import { readArtifactPayload, assertArtifactBodyMatchesMetadata, type ArtifactPayloadRecord } from "../artifacts/package-payload.js";
import type { ArtifactObjectStorage } from "../artifacts/storage.js";
import { PACKAGE_SCAN_LEASE_MS, PACKAGE_SCAN_MAX_ATTEMPTS, PACKAGE_SCAN_RUNNER_VERSION, type PackageScanClaim } from "./scan-jobs.js";

type JobRow = { id: string; status: string; attempts: number; payload: { versionId: string; artifactSha256: string; runnerVersion: string; scanRunId: string } };
type VersionRow = { id: string; slug: string; version: string; lifecycle_status: string; review_status: string; published_at: Date | null; deleted_at: Date | null };
type FailureCode = "artifact_integrity" | "artifact_unavailable" | "invalid_package" | "version_inactive" | "runner_incompatible" | "scan_error";
class ExpiredScanLease extends Error {}

/** Durable queue; no provider execution, shell, hooks or package instructions are executed. */
export class PackageScanService {
  constructor(private readonly db: Database, private readonly options: { artifactStorage?: ArtifactObjectStorage } = {}) {}

  async claimNext(): Promise<PackageScanClaim | null> {
    return this.db.transaction(async (tx) => {
      const result = await tx.execute(sql`SELECT id, status, attempts, payload FROM jobs
        WHERE type = 'package-scan' AND (
          (status = 'queued' AND available_at <= now()) OR
          (status = 'running' AND lease_expires_at <= now())
        ) ORDER BY available_at, created_at, id FOR UPDATE SKIP LOCKED LIMIT 1`);
      const job = result.rows[0] as JobRow | undefined;
      if (!job) return null;
      if (job.status === "running") {
        await tx.execute(sql`UPDATE scan_runs SET status = 'failed', completed_at = now(), failure_code = 'lease_expired'
          WHERE id = ${job.payload.scanRunId}::uuid AND status = 'running'`);
      }
      if (job.attempts >= PACKAGE_SCAN_MAX_ATTEMPTS) {
        // Terminalize the job here. A separate completion owns version locks; never
        // acquire them under a job lock (publication uses skill -> version -> job).
        await tx.execute(sql`UPDATE jobs SET status = 'failed', lease_id = NULL, lease_expires_at = NULL,
          failure_code = 'attempts_exhausted', updated_at = now() WHERE id = ${job.id}::uuid`);
        await audit(tx, job.payload.versionId, "exhausted", { attempts: job.attempts });
        return null;
      }
      const attempt = job.attempts + 1;
      const leaseId = randomUUID();
      let scanRunId = job.payload.scanRunId;
      if (job.attempts > 0) {
        scanRunId = randomUUID();
        await tx.execute(sql`INSERT INTO scan_runs (id, skill_version_id, artifact_sha256, runner_version, job_id, attempt)
          VALUES (${scanRunId}::uuid, ${job.payload.versionId}::uuid, ${job.payload.artifactSha256}, ${job.payload.runnerVersion}, ${job.id}::uuid, ${attempt})`);
      }
      await tx.execute(sql`UPDATE scan_runs SET status = 'running', started_at = now() WHERE id = ${scanRunId}::uuid AND status = 'queued'`);
      await tx.execute(sql`UPDATE jobs SET status = 'running', attempts = ${attempt}, lease_id = ${leaseId}::uuid,
        lease_expires_at = now() + ${PACKAGE_SCAN_LEASE_MS} * interval '1 millisecond',
        payload = ${JSON.stringify({ ...job.payload, scanRunId })}::jsonb, updated_at = now()
        WHERE id = ${job.id}::uuid`);
      await audit(tx, job.payload.versionId, "claimed", { attempt, runnerVersion: job.payload.runnerVersion });
      return { jobId: job.id, leaseId, scanRunId, versionId: job.payload.versionId, artifactSha256: job.payload.artifactSha256, runnerVersion: job.payload.runnerVersion, attempt };
    });
  }

  async processClaim(claim: PackageScanClaim): Promise<boolean> {
    let findings: ScanFinding[] | null = null;
    let failure: FailureCode | null = null;
    let prepared: { artifact: ArtifactPayloadRecord; manifest: { name: string; version: string } } | null = null;
    try {
      if (claim.runnerVersion !== PACKAGE_SCAN_RUNNER_VERSION) throw new AppError("Runner changed.", "RUNNER_INCOMPATIBLE", 409);
      const artifactResult = await this.db.execute(sql`SELECT storage_key AS "storageKey", sha256, byte_size AS "byteSize", content_type AS "contentType", payload
        FROM skill_artifacts WHERE skill_version_id = ${claim.versionId}::uuid`);
      const artifact = artifactResult.rows[0] as unknown as ArtifactPayloadRecord | undefined;
      if (!artifact || artifact.sha256 !== claim.artifactSha256) throw new AppError("Artifact changed.", "ARTIFACT_METADATA_MISMATCH", 409);
      const payload = await readArtifactPayload({ artifactStorage: this.options.artifactStorage, artifact });
      assertArtifactBodyMatchesMetadata(JSON.stringify(payload), artifact);
      // This performs package limits and path checks before accepting manifest bytes.
      findings = scanPackageFiles(payload.files).findings;
      const manifest = loadStoredSkillManifestFromPackageFiles(payload.files);
      prepared = { artifact, manifest };
    } catch (error) {
      failure = failureCode(error);
    }
    return this.complete(claim, findings, failure, prepared);
  }

  async runOnce(batchSize = 5): Promise<number> {
    let count = 0;
    for (let i = 0; i < Math.min(Math.max(batchSize, 1), 25); i++) {
      const claim = await this.claimNext();
      if (!claim) break;
      await this.processClaim(claim);
      count++;
    }
    await this.reconcileExhausted();
    return count;
  }

  private async complete(claim: PackageScanClaim, findings: ScanFinding[] | null, failure: FailureCode | null,
    prepared: { artifact: ArtifactPayloadRecord; manifest: { name: string; version: string } } | null): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      // Match publication and owner-action lock order. Artifact/storage I/O happened outside it.
      await tx.execute(sql`SELECT s.id FROM skills s INNER JOIN skill_versions v ON v.skill_id = s.id
        WHERE v.id = ${claim.versionId}::uuid FOR UPDATE OF s`);
      const versions = await tx.execute(sql`SELECT v.id, s.slug, v.version, v.lifecycle_status, v.review_status, v.published_at, v.deleted_at
        FROM skill_versions v INNER JOIN skills s ON s.id = v.skill_id WHERE v.id = ${claim.versionId}::uuid FOR NO KEY UPDATE OF v`);
      const version = versions.rows[0] as VersionRow | undefined;
      const jobs = await tx.execute(sql`SELECT id FROM jobs WHERE id = ${claim.jobId}::uuid AND status = 'running'
        AND lease_id = ${claim.leaseId}::uuid
        AND payload->>'scanRunId' = ${claim.scanRunId} FOR UPDATE`);
      if (!jobs.rows.length) return false;
      // now() is transaction-start time. Recheck actual time after acquiring the lock.
      const live = await tx.execute(sql`SELECT id FROM jobs WHERE id = ${claim.jobId}::uuid AND lease_expires_at > clock_timestamp()`);
      if (!live.rows.length) return false;
      if (!version || version.deleted_at || version.published_at || version.review_status === "approved" || version.review_status === "rejected"
        || !["submitted", "review"].includes(version.lifecycle_status)) failure = "version_inactive";
      const artifact = await tx.execute(sql`SELECT sha256 FROM skill_artifacts WHERE skill_version_id = ${claim.versionId}::uuid FOR SHARE`);
      if (!artifact.rows.length || artifact.rows[0]!.sha256 !== claim.artifactSha256) failure = "artifact_integrity";
      if (!failure && prepared) {
        const unchanged = await tx.execute(sql`SELECT id FROM skill_artifacts WHERE skill_version_id = ${claim.versionId}::uuid
          AND storage_key = ${prepared.artifact.storageKey} AND sha256 = ${prepared.artifact.sha256}
          AND byte_size = ${prepared.artifact.byteSize} AND content_type = ${prepared.artifact.contentType}
          AND payload = ${JSON.stringify(prepared.artifact.payload)}::jsonb`);
        if (!unchanged.rows.length || prepared.manifest.name !== version?.slug || prepared.manifest.version !== version?.version) failure = "artifact_integrity";
      }
      const retry = failure && ["artifact_unavailable", "scan_error"].includes(failure) && claim.attempt < PACKAGE_SCAN_MAX_ATTEMPTS;
      if (!failure && findings?.length) {
        await tx.execute(sql`INSERT INTO scan_findings (scan_run_id, category, severity, message, path)
          SELECT ${claim.scanRunId}::uuid, f.category, f.severity, f.message, f.path
          FROM jsonb_to_recordset(${JSON.stringify(findings)}::jsonb) AS f(category text, severity text, message text, path text)`);
      }
      await tx.execute(sql`UPDATE scan_runs SET status = ${failure ? "failed" : "succeeded"}::job_status,
        completed_at = now(), failure_code = ${failure} WHERE id = ${claim.scanRunId}::uuid AND status = 'running'`);
      const completed = await tx.execute(sql`UPDATE jobs SET status = ${retry ? "queued" : failure ? "failed" : "succeeded"}::job_status,
        lease_id = NULL, lease_expires_at = NULL, failure_code = ${failure},
        available_at = now() + ${claim.attempt * 5000} * interval '1 millisecond', updated_at = now()
        WHERE id = ${claim.jobId}::uuid AND lease_id = ${claim.leaseId}::uuid AND lease_expires_at > clock_timestamp() RETURNING id`);
      if (!completed.rows.length) throw new ExpiredScanLease();
      if (version && !version.published_at && version.review_status !== "approved" && version.review_status !== "rejected" && !version.deleted_at) {
        const security = failure ? retry ? "not-run" : "failed" : hasBlockingFindings(findings ?? []) ? "failed" : findings?.length ? "warning" : "passed";
        await tx.execute(sql`UPDATE skill_versions SET security_status = ${security}::security_status WHERE id = ${claim.versionId}::uuid`);
      }
      await audit(tx, claim.versionId, retry ? "retry" : failure ? "failed" : "completed", {
        attempt: claim.attempt, artifactSha256: claim.artifactSha256, runnerVersion: claim.runnerVersion,
        findingCount: failure ? 0 : findings?.length ?? 0, failureCode: failure,
      });
      return true;
    }).catch((error: unknown) => {
      // Roll back every finding and status write if the lease expires during completion.
      if (error instanceof ExpiredScanLease) return false;
      throw error;
    });
  }

  private async reconcileExhausted(): Promise<void> {
    // Keep this separate from claim locks to preserve publication's lock order.
    await this.db.execute(sql`UPDATE skill_versions v SET security_status = 'failed'
      WHERE v.security_status = 'not-run' AND v.published_at IS NULL AND v.review_status IN ('unreviewed', 'changes-requested')
        AND EXISTS (SELECT 1 FROM jobs j WHERE j.type = 'package-scan' AND j.status = 'failed'
          AND j.failure_code = 'attempts_exhausted' AND j.payload->>'versionId' = v.id::text)`);
  }
}

function failureCode(error: unknown): FailureCode {
  if (error instanceof AppError) {
    if (error.code === "ARTIFACT_PAYLOAD_UNAVAILABLE") return "artifact_unavailable";
    if (error.code === "ARTIFACT_METADATA_MISMATCH") return "artifact_integrity";
    if (error.code === "RUNNER_INCOMPATIBLE") return "runner_incompatible";
    return "invalid_package";
  }
  return "scan_error";
}

async function audit(tx: DatabaseTransaction, versionId: string, action: string, details: Record<string, unknown>): Promise<void> {
  await tx.execute(sql`INSERT INTO audit_events (action, decision, resource_type, resource_id, details)
    VALUES (${`package_scan.${action}`}, 'allow', 'skill_version', ${versionId}::uuid, ${JSON.stringify(details)}::jsonb)`);
}
