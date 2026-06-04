import { createHash, randomUUID } from "node:crypto";
import { AppError } from "@ai-skills-share/core";
import {
  hasBlockingFindings,
  loadSkillManifestFromPackageFiles,
  normalizePackageFilePath,
  PackageManifestFileError,
  scanPackageFiles,
  type PackageInputFile,
  type SkillManifest,
} from "@ai-skills-share/skill-package";
import type { Role } from "@ai-skills-share/auth";
import type {
  ArtifactPayload,
  CreateSubmissionInput,
  PublicBundle,
  PublicReleaseMetadata,
  ReviewAction,
  ReviewActionResult,
  ReviewSubmissionSummary,
  StoredSubmission,
  SubmissionActor,
  SubmissionStore,
} from "./types.js";

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
    const packageManifest = validatePackageManifest(input.manifest, input.files);

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

    const artifact = artifactMetadata(input.files);
    return this.store.createSubmission({
      ...input,
      manifest: packageManifest,
      artifact,
      findings: scan.findings,
      securityStatus: scan.findings.length > 0 ? "warning" : "passed",
    });
  }

  async listReviewSubmissions(actor: SubmissionActor): Promise<ReviewSubmissionSummary[]> {
    if (!canReview(actor.roles)) {
      await this.store.recordReviewDenied({
        actorId: actor.id,
        action: "review.submissions.list",
        reason: "review_role_required",
      });
      throw new AppError("Review requires maintainer permissions.", "REVIEW_ROLE_REQUIRED", 403);
    }
    return this.store.listReviewSubmissions();
  }

  async performReviewAction(input: {
    actor: SubmissionActor;
    submissionId: string;
    action: ReviewAction;
    reason?: string;
  }): Promise<ReviewActionResult> {
    if (!canReview(input.actor.roles)) {
      await this.store.recordReviewDenied({
        actorId: input.actor.id,
        action: `review.${input.action}`,
        submissionId: input.submissionId,
        reason: "review_role_required",
      });
      throw new AppError("Review requires maintainer permissions.", "REVIEW_ROLE_REQUIRED", 403);
    }

    if (input.action === "approve") {
      return this.store.approveSubmission({
        actorId: input.actor.id,
        submissionId: input.submissionId,
        reason: input.reason,
      });
    }

    return this.store.publishSubmission({
      actorId: input.actor.id,
      submissionId: input.submissionId,
      reason: input.reason,
    });
  }

  async getPublicRelease(input: { slug: string; version: string }): Promise<PublicReleaseMetadata | null> {
    return this.store.getPublicRelease(input);
  }

  async getPublicBundle(input: { slug: string; version: string; platform?: string; actorId?: string | null }): Promise<PublicBundle | null> {
    const bundle = await this.store.getPublicBundle(input);
    await this.store.recordArtifactAccess({
      actorId: input.actorId ?? null,
      slug: input.slug,
      version: input.version,
      platform: input.platform,
      decision: bundle ? "allow" : "deny",
      reason: bundle ? undefined : "not_public_or_missing",
    });
    return bundle;
  }
}

function canSubmit(roles: Role[]): boolean {
  return roles.some((role) => role === "owner" || role === "admin" || role === "maintainer" || role === "author");
}

function canReview(roles: Role[]): boolean {
  return roles.some((role) => role === "owner" || role === "admin" || role === "maintainer");
}

function validatePackageManifest(submittedManifest: SkillManifest, files: PackageInputFile[]): SkillManifest {
  let packageManifest: SkillManifest;
  try {
    packageManifest = loadSkillManifestFromPackageFiles(files);
  } catch (error) {
    if (error instanceof PackageManifestFileError) {
      throw new AppError(error.message, error.code, 400);
    }
    throw new AppError(error instanceof Error ? error.message : "Invalid package payload.", "INVALID_PACKAGE_PAYLOAD", 400);
  }
  if (canonicalManifest(submittedManifest) !== canonicalManifest(packageManifest)) {
    throw new AppError("Submitted manifest must match the package manifest file.", "PACKAGE_MANIFEST_MISMATCH", 400);
  }
  return packageManifest;
}

function canonicalManifest(manifest: SkillManifest): string {
  return JSON.stringify({
    name: manifest.name,
    title: manifest.title,
    summary: manifest.summary,
    version: manifest.version,
    license: manifest.license,
    visibility: manifest.visibility,
    platforms: manifest.platforms.map((platform) => ({
      name: platform.name,
      install_target: platform.install_target,
      status: platform.status,
    })),
    tags: manifest.tags,
  });
}

function artifactMetadata(files: PackageInputFile[]): StoredSubmission["artifact"] {
  const artifactPayload = canonicalArtifactPayload(files);
  const payload = JSON.stringify(artifactPayload);
  const sha256 = createHash("sha256").update(payload).digest("hex");
  return {
    storageKey: `submissions/${randomUUID()}.json`,
    sha256,
    byteSize: Buffer.byteLength(payload),
    contentType: PACKAGE_CONTENT_TYPE,
    payload: artifactPayload,
  };
}

function canonicalArtifactPayload(files: PackageInputFile[]): ArtifactPayload {
  return {
    files: [...files]
      .map((file) => ({ path: normalizePackageFilePath(file.path), content: file.content }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
}
