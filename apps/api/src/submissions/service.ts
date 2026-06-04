import { createHash } from "node:crypto";
import { AppError } from "@ai-skills-share/core";
import { hasBlockingFindings, scanPackageFiles, type PackageInputFile } from "@ai-skills-share/skill-package";
import type { Role } from "@ai-skills-share/auth";
import type { CreateSubmissionInput, StoredSubmission, SubmissionStore } from "./types.js";

const PACKAGE_CONTENT_TYPE = "application/vnd.ai-skills-share.package+json";

export class SubmissionService {
  constructor(private readonly store: SubmissionStore) {}

  async createSubmission(input: CreateSubmissionInput): Promise<StoredSubmission> {
    if (!canSubmit(input.actor.roles)) {
      throw new AppError("Submission requires author permissions.", "SUBMISSION_ROLE_REQUIRED", 403);
    }
    if (input.files.length === 0) {
      throw new AppError("Package files are required.", "PACKAGE_FILES_REQUIRED", 400);
    }

    let scan: ReturnType<typeof scanPackageFiles>;
    try {
      scan = scanPackageFiles(input.files);
    } catch (error) {
      throw new AppError(error instanceof Error ? error.message : "Invalid package payload.", "INVALID_PACKAGE_PAYLOAD", 400);
    }
    if (hasBlockingFindings(scan.findings)) {
      await this.store.recordDenied({
        actorId: input.actor.id,
        slug: input.manifest.name,
        version: input.manifest.version,
        reason: "blocking_scan_findings",
        findingCount: scan.findings.length,
      });
      throw new AppError("Package scan produced blocking findings.", "PACKAGE_SCAN_BLOCKED", 422, {
        findings: scan.findings,
      });
    }

    const artifact = artifactMetadata(input.manifest.name, input.manifest.version, input.files);
    return this.store.createSubmission({
      ...input,
      artifact,
      findings: scan.findings,
      securityStatus: scan.findings.length > 0 ? "warning" : "passed",
    });
  }
}

function canSubmit(roles: Role[]): boolean {
  return roles.some((role) => role === "owner" || role === "admin" || role === "maintainer" || role === "author");
}

function artifactMetadata(slug: string, version: string, files: PackageInputFile[]): StoredSubmission["artifact"] {
  const payload = canonicalPackagePayload(files);
  return {
    storageKey: `submissions/${slug}/${version}/${createHash("sha256").update(payload).digest("hex")}.json`,
    sha256: createHash("sha256").update(payload).digest("hex"),
    byteSize: Buffer.byteLength(payload),
    contentType: PACKAGE_CONTENT_TYPE,
  };
}

function canonicalPackagePayload(files: PackageInputFile[]): string {
  return JSON.stringify({
    files: [...files]
      .map((file) => ({ path: file.path, content: file.content }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  });
}
