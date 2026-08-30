import { AppError, type SkillLifecycleStatus } from "@myskills-app/core";
import {
  loadSkillManifestFromPackageFiles,
  PackageManifestFileError,
  type SkillManifest,
} from "@myskills-app/skill-package";
import { sanitizeAuditDetails } from "../audit/sanitize.js";
import type {
  CreateSubmissionInput,
  PublicBundle,
  PublicReleaseMetadata,
  ReleaseLifecycleAction,
  ReviewActionResult,
  ReviewSubmissionSummary,
  ReviewSubmissionBundle,
  SkillLifecycleAction,
  SkillManagementSummary,
  SkillMetadataUpdate,
  SkillReleaseSummary,
  StoredSubmission,
  SubmissionActor,
  SubmissionOwnerAction,
  SubmissionStore,
  UserSubmissionBundle,
  UserSubmissionSummary,
} from "./types.js";
import { assertNoVisibilityMetadataUpdate } from "./types.js";
import { artifactPayloadSha256 } from "./artifact-hash.js";

interface AuditRecord {
  action: string;
  decision: "allow" | "deny";
  actorId?: string | null;
  details: Record<string, unknown>;
}

export class MemorySubmissionStore implements SubmissionStore {
  private submissions = new Map<string, StoredSubmission>();
  private skillLifecycle = new Map<string, SkillLifecycleStatus>();
  private denied = 0;
  private audit: AuditRecord[] = [];

  async createSubmission(input: CreateSubmissionInput & {
    artifact: StoredSubmission["artifact"];
    findings: StoredSubmission["scan"]["findings"];
    securityStatus: StoredSubmission["securityStatus"];
  }): Promise<StoredSubmission> {
    const key = `${input.manifest.name}@${input.manifest.version}`;
    if (this.submissions.has(key)) {
      throw new AppError("Package version already exists.", "PACKAGE_VERSION_EXISTS", 409);
    }
    const submission: StoredSubmission = {
      id: `submission-${this.submissions.size + 1}`,
      ownerUserId: input.actor.id,
      skillSlug: input.manifest.name,
      title: input.manifest.title,
      summary: input.manifest.summary,
      version: input.manifest.version,
      visibility: input.manifest.visibility,
      lifecycleStatus: "submitted",
      platforms: input.manifest.platforms.map((platform) => ({
        name: platform.name,
        installTarget: platform.install_target,
        status: platform.status,
      })),
      reviewStatus: "unreviewed",
      securityStatus: input.securityStatus,
      approvedArtifactSha256: null,
      publishedAt: null,
      createdAt: new Date().toISOString(),
      artifact: input.artifact,
      scan: {
        status: "succeeded",
        findings: input.findings,
      },
    };
    this.submissions.set(key, submission);
    this.skillLifecycle.set(
      submission.skillSlug,
      this.skillLifecycle.get(submission.skillSlug) === "approved" ? "approved" : "submitted",
    );
    return submission;
  }

  async listUserSubmissions(userId: string): Promise<UserSubmissionSummary[]> {
    return [...this.submissions.values()]
      .filter((submission) => submission.ownerUserId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(userSubmissionSummary);
  }

  async getUserSubmissionBundle(input: { userId: string; submissionId: string; platform?: string }): Promise<UserSubmissionBundle | null> {
    const submission = this.findSubmission(input.submissionId);
    if (!submission || submission.ownerUserId !== input.userId) {
      return null;
    }
    if (input.platform && !submission.platforms.some((platform) => (
      platform.name === input.platform &&
      platform.status === "supported"
    ))) {
      return null;
    }
    return {
      ...userSubmissionSummary(submission),
      payload: submission.artifact.payload,
    };
  }

  async performSubmissionOwnerAction(input: { actorId: string; submissionId: string; action: SubmissionOwnerAction; reason?: string }): Promise<UserSubmissionSummary> {
    const submission = this.findSubmission(input.submissionId);
    if (!submission || submission.ownerUserId !== input.actorId) {
      this.recordAudit(`submission.${input.action}`, "deny", input.actorId, {
        submissionId: input.submissionId,
        reason: "not_owner_or_missing",
      });
      throw new AppError("Submission not found.", "SUBMISSION_NOT_FOUND", 404);
    }
    if (input.action !== "withdraw") {
      throw new AppError("Unsupported submission action.", "INVALID_SUBMISSION_ACTION", 400);
    }
    if (!submissionAllowedActions(submission).includes("withdraw")) {
      this.recordAudit("submission.withdraw", "deny", input.actorId, {
        submissionId: submission.id,
        slug: submission.skillSlug,
        version: submission.version,
        reason: "not_withdrawable",
      });
      throw new AppError("Submission cannot be withdrawn.", "SUBMISSION_NOT_WITHDRAWABLE", 409);
    }
    submission.reviewStatus = "rejected";
    submission.lifecycleStatus = "archived";
    this.recordAudit("submission.withdraw", "allow", input.actorId, {
      submissionId: submission.id,
      slug: submission.skillSlug,
      version: submission.version,
      reason: input.reason,
    });
    return userSubmissionSummary(submission);
  }

  async listReviewSubmissions(): Promise<ReviewSubmissionSummary[]> {
    return [...this.submissions.values()]
      .filter((submission) => isReviewQueueSubmission(submission, this.skillLifecycle.get(submission.skillSlug)))
      .map((submission) => reviewSubmissionSummary(submission, this.skillLifecycle.get(submission.skillSlug)));
  }

  async getReviewSubmissionBundle(input: { submissionId: string; platform?: string }): Promise<ReviewSubmissionBundle | null> {
    const submission = this.findSubmission(input.submissionId);
    if (!submission || !isReviewQueueSubmission(submission, this.skillLifecycle.get(submission.skillSlug))) {
      return null;
    }
    if (input.platform && !submission.platforms.some((platform) => (
      platform.name === input.platform &&
      platform.status === "supported"
    ))) {
      return null;
    }
    return {
      ...reviewSubmissionSummary(submission, this.skillLifecycle.get(submission.skillSlug)),
      artifact: {
        sha256: artifactPayloadSha256(submission.artifact.payload),
        byteSize: Buffer.byteLength(JSON.stringify(submission.artifact.payload)),
        contentType: submission.artifact.contentType,
      },
      payload: submission.artifact.payload,
    };
  }

  async approveSubmission(input: { actorId: string; submissionId: string; artifactSha256: string; reason?: string }): Promise<ReviewActionResult> {
    const submission = this.findSubmission(input.submissionId);
    if (!submission) {
      this.recordAudit("review.approve", "deny", input.actorId, {
        submissionId: input.submissionId,
        reason: "missing_submission",
      });
      throw new AppError("Submission not found.", "SUBMISSION_NOT_FOUND", 404);
    }
    if (submission.securityStatus !== "passed") {
      this.recordAudit("review.approve", "deny", input.actorId, {
        submissionId: submission.id,
        slug: submission.skillSlug,
        version: submission.version,
        reason: "scan_not_passed",
      });
      throw new AppError("Package scan must pass before approval.", "PACKAGE_SCAN_NOT_PASSED", 422);
    }
    if (!["unreviewed", "changes-requested"].includes(submission.reviewStatus)) {
      this.recordAudit("review.approve", "deny", input.actorId, {
        submissionId: submission.id,
        slug: submission.skillSlug,
        version: submission.version,
        reason: "not_reviewable",
      });
      throw new AppError("Submission is not reviewable.", "SUBMISSION_NOT_REVIEWABLE", 409);
    }
    if (!isActiveReviewSubmission(submission, this.skillLifecycle.get(submission.skillSlug))) {
      this.recordAudit("review.approve", "deny", input.actorId, {
        submissionId: submission.id,
        slug: submission.skillSlug,
        version: submission.version,
        reason: "not_reviewable",
      });
      throw new AppError("Submission is not reviewable.", "SUBMISSION_NOT_REVIEWABLE", 409);
    }
    const currentArtifactSha256 = artifactPayloadSha256(submission.artifact.payload);
    if (input.artifactSha256 !== currentArtifactSha256) {
      this.recordAudit("review.approve", "deny", input.actorId, {
        submissionId: submission.id,
        slug: submission.skillSlug,
        version: submission.version,
        reason: "artifact_hash_mismatch",
      });
      throw new AppError("Approval artifact hash does not match the current submission artifact.", "ARTIFACT_HASH_MISMATCH", 409);
    }
    submission.reviewStatus = "approved";
    submission.lifecycleStatus = "review";
    submission.approvedArtifactSha256 = input.artifactSha256;
    this.recordAudit("review.approve", "allow", input.actorId, {
      submissionId: submission.id,
      slug: submission.skillSlug,
      version: submission.version,
      artifactSha256: input.artifactSha256,
      reason: input.reason,
    });
    return reviewActionResult(submission);
  }

  async requestChanges(input: { actorId: string; submissionId: string; reason?: string }): Promise<ReviewActionResult> {
    const submission = this.findSubmission(input.submissionId);
    if (!submission) {
      this.recordAudit("review.request_changes", "deny", input.actorId, {
        submissionId: input.submissionId,
        reason: "missing_submission",
      });
      throw new AppError("Submission not found.", "SUBMISSION_NOT_FOUND", 404);
    }
    if (!isActiveReviewSubmission(submission, this.skillLifecycle.get(submission.skillSlug)) || !["unreviewed", "changes-requested"].includes(submission.reviewStatus)) {
      this.recordAudit("review.request_changes", "deny", input.actorId, {
        submissionId: submission.id,
        slug: submission.skillSlug,
        version: submission.version,
        reason: "not_reviewable",
      });
      throw new AppError("Submission is not reviewable.", "SUBMISSION_NOT_REVIEWABLE", 409);
    }
    submission.reviewStatus = "changes-requested";
    submission.lifecycleStatus = "review";
    this.recordAudit("review.request_changes", "allow", input.actorId, {
      submissionId: submission.id,
      slug: submission.skillSlug,
      version: submission.version,
      reason: input.reason,
    });
    return reviewActionResult(submission);
  }

  async rejectSubmission(input: { actorId: string; submissionId: string; reason?: string }): Promise<ReviewActionResult> {
    const submission = this.findSubmission(input.submissionId);
    if (!submission) {
      this.recordAudit("review.reject", "deny", input.actorId, {
        submissionId: input.submissionId,
        reason: "missing_submission",
      });
      throw new AppError("Submission not found.", "SUBMISSION_NOT_FOUND", 404);
    }
    if (!isActiveReviewSubmission(submission, this.skillLifecycle.get(submission.skillSlug)) || !["unreviewed", "changes-requested"].includes(submission.reviewStatus)) {
      this.recordAudit("review.reject", "deny", input.actorId, {
        submissionId: submission.id,
        slug: submission.skillSlug,
        version: submission.version,
        reason: "not_reviewable",
      });
      throw new AppError("Submission is not reviewable.", "SUBMISSION_NOT_REVIEWABLE", 409);
    }
    submission.reviewStatus = "rejected";
    submission.lifecycleStatus = "archived";
    this.recordAudit("review.reject", "allow", input.actorId, {
      submissionId: submission.id,
      slug: submission.skillSlug,
      version: submission.version,
      reason: input.reason,
    });
    return reviewActionResult(submission);
  }

  async publishSubmission(input: { actorId: string; submissionId: string; reason?: string }): Promise<ReviewActionResult> {
    const submission = this.findSubmission(input.submissionId);
    if (!submission) {
      this.recordAudit("release.publish", "deny", input.actorId, {
        submissionId: input.submissionId,
        reason: "missing_submission",
      });
      throw new AppError("Submission not found.", "SUBMISSION_NOT_FOUND", 404);
    }
    if (submission.securityStatus !== "passed") {
      this.recordAudit("release.publish", "deny", input.actorId, {
        submissionId: submission.id,
        slug: submission.skillSlug,
        version: submission.version,
        reason: "scan_not_passed",
      });
      throw new AppError("Package scan must pass before publication.", "PACKAGE_SCAN_NOT_PASSED", 422);
    }
    if (submission.reviewStatus !== "approved") {
      this.recordAudit("release.publish", "deny", input.actorId, {
        submissionId: submission.id,
        slug: submission.skillSlug,
        version: submission.version,
        reason: "not_approved",
      });
      throw new AppError("Submission must be approved before publication.", "SUBMISSION_NOT_APPROVED", 409);
    }
    if (submission.publishedAt) {
      this.recordAudit("release.publish", "deny", input.actorId, {
        submissionId: submission.id,
        slug: submission.skillSlug,
        version: submission.version,
        reason: "already_published",
      });
      throw new AppError("Submission is already published.", "SUBMISSION_ALREADY_PUBLISHED", 409);
    }
    if (!isActiveReviewSubmission(submission, this.skillLifecycle.get(submission.skillSlug))) {
      this.recordAudit("release.publish", "deny", input.actorId, {
        submissionId: submission.id,
        slug: submission.skillSlug,
        version: submission.version,
        reason: "not_reviewable",
      });
      throw new AppError("Submission is not reviewable.", "SUBMISSION_NOT_REVIEWABLE", 409);
    }
    const currentArtifactSha256 = artifactPayloadSha256(submission.artifact.payload);
    if (!submission.approvedArtifactSha256) {
      this.recordAudit("release.publish", "deny", input.actorId, {
        submissionId: submission.id,
        slug: submission.skillSlug,
        version: submission.version,
        reason: "missing_approved_artifact_hash",
      });
      throw new AppError("Submission approval must include an artifact hash before publication.", "APPROVED_ARTIFACT_HASH_REQUIRED", 409);
    }
    if (submission.approvedArtifactSha256 !== currentArtifactSha256) {
      this.recordAudit("release.publish", "deny", input.actorId, {
        submissionId: submission.id,
        slug: submission.skillSlug,
        version: submission.version,
        reason: "approved_artifact_hash_mismatch",
      });
      throw new AppError("Approved artifact hash does not match the current submission artifact.", "APPROVED_ARTIFACT_HASH_MISMATCH", 409);
    }
    try {
      assertArtifactManifestMatchesSubmission(submission);
    } catch (error) {
      this.recordAudit("release.publish", "deny", input.actorId, {
        submissionId: submission.id,
        slug: submission.skillSlug,
        version: submission.version,
        reason: error instanceof AppError ? error.code : "invalid_artifact_manifest",
      });
      throw error;
    }
    submission.publishedAt = new Date().toISOString();
    submission.lifecycleStatus = "approved";
    this.skillLifecycle.set(submission.skillSlug, "approved");
    this.recordAudit("release.publish", "allow", input.actorId, {
      submissionId: submission.id,
      slug: submission.skillSlug,
      version: submission.version,
      reason: input.reason,
    });
    return reviewActionResult(submission);
  }

  async getSkillManagement(input: { slug: string; actor: SubmissionActor }): Promise<SkillManagementSummary | null> {
    const submissions = this.findSubmissionsBySlug(input.slug);
    const first = submissions[0];
    if (!first) {
      return null;
    }
    assertCanManageSkill(first, input.actor);
    return skillManagementSummary(submissions, this.skillLifecycle.get(input.slug));
  }

  async updateSkillMetadata(input: { slug: string; actor: SubmissionActor; update: SkillMetadataUpdate; reason?: string }): Promise<SkillManagementSummary> {
    assertNoVisibilityMetadataUpdate(input.update);
    const submissions = this.findSubmissionsBySlug(input.slug);
    const first = submissions[0];
    if (!first) {
      throw new AppError("Skill not found.", "SKILL_NOT_FOUND", 404);
    }
    assertCanManageSkill(first, input.actor);
    for (const submission of submissions) {
      if (input.update.title !== undefined) {
        submission.title = input.update.title;
      }
      if (input.update.summary !== undefined) {
        submission.summary = input.update.summary;
      }
    }
    this.recordAudit("skill.metadata.update", "allow", input.actor.id, {
      slug: input.slug,
      fields: Object.keys(input.update),
      reason: input.reason,
    });
    return skillManagementSummary(submissions, this.skillLifecycle.get(input.slug));
  }

  async performSkillAction(input: { slug: string; actor: SubmissionActor; action: SkillLifecycleAction; reason?: string }): Promise<SkillManagementSummary> {
    const submissions = this.findSubmissionsBySlug(input.slug);
    const first = submissions[0];
    if (!first) {
      throw new AppError("Skill not found.", "SKILL_NOT_FOUND", 404);
    }
    assertCanManageSkill(first, input.actor);
    const lifecycleStatus = input.action === "restore"
      ? restoredSkillLifecycle(submissions)
      : "archived";
    this.skillLifecycle.set(input.slug, lifecycleStatus);
    this.recordAudit(`skill.${input.action}`, "allow", input.actor.id, {
      slug: input.slug,
      lifecycleStatus,
      reason: input.reason,
    });
    return {
      ...skillManagementSummary(submissions, lifecycleStatus),
      lifecycleStatus,
    };
  }

  async listSkillReleases(input: { slug: string; actor?: SubmissionActor | null }): Promise<SkillReleaseSummary[]> {
    const submissions = this.findSubmissionsBySlug(input.slug);
    if (submissions.length === 0) {
      return [];
    }
    const canManage = Boolean(input.actor && canManageSkill(submissions[0]!, input.actor));
    const skillLifecycle = this.skillLifecycle.get(input.slug) ?? restoredSkillLifecycle(submissions);
    return submissions
      .filter((submission) => canManage || isPubliclyVisibleRelease(submission, skillLifecycle))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((submission) => releaseSummary(submission, input.actor ?? null));
  }

  async performReleaseAction(input: { slug: string; version: string; actor: SubmissionActor; action: ReleaseLifecycleAction; reason?: string; replacement?: string }): Promise<SkillReleaseSummary> {
    const submission = this.findSubmissionBySlugVersion(input.slug, input.version);
    if (!submission) {
      throw new AppError("Release not found.", "RELEASE_NOT_FOUND", 404);
    }
    assertCanManageSkill(submission, input.actor);
    if (input.action === "restore" && submission.lifecycleStatus === "revoked") {
      if (!isPrivilegedReleaseActor(input.actor)) {
        this.recordAudit("release.restore", "deny", input.actor.id, {
          slug: input.slug,
          version: input.version,
          reason: "privileged_restore_required",
        });
        throw new AppError("Restoring a revoked release requires maintainer permissions.", "RELEASE_RESTORE_ROLE_REQUIRED", 403);
      }
      if (!isSafeRevokedRestore(submission)) {
        this.recordAudit("release.restore", "deny", input.actor.id, {
          slug: input.slug,
          version: input.version,
          reason: "unsafe_release_state",
        });
        throw new AppError("Revoked release artifact and scan state must be safe before restore.", "RELEASE_RESTORE_UNSAFE", 409);
      }
    }
    const allowed = releaseAllowedActions(submission);
    if (!allowed.includes(input.action)) {
      this.recordAudit(`release.${input.action}`, "deny", input.actor.id, {
        slug: input.slug,
        version: input.version,
        reason: "action_not_allowed",
      });
      throw new AppError("Release action is not allowed.", "RELEASE_ACTION_NOT_ALLOWED", 409);
    }
    submission.lifecycleStatus = lifecycleForReleaseAction(input.action);
    this.recordAudit(`release.${input.action}`, "allow", input.actor.id, {
      slug: input.slug,
      version: input.version,
      replacement: input.replacement,
      reason: input.reason,
    });
    return releaseSummary(submission);
  }

  async recordReviewDenied(input: {
    actorId: string;
    action: string;
    submissionId?: string;
    reason: string;
  }): Promise<void> {
    this.recordAudit(input.action, "deny", input.actorId, {
      submissionId: input.submissionId,
      reason: input.reason,
    });
  }

  async getPublicRelease(input: { slug: string; version: string; actorId?: string | null }): Promise<PublicReleaseMetadata | null> {
    const submission = this.findPublicSubmission(input.slug, input.version);
    return submission ? publicRelease(submission) : null;
  }

  async getPublicBundle(input: { slug: string; version: string; platform?: string; actorId?: string | null }): Promise<PublicBundle | null> {
    const submission = this.findPublicSubmission(input.slug, input.version);
    if (!submission) {
      return null;
    }
    if (input.platform && !submission.platforms.some((platform) => (
      platform.name === input.platform &&
      platform.status === "supported"
    ))) {
      return null;
    }
    return {
      ...publicRelease(submission),
      payload: submission.artifact.payload,
    };
  }

  async recordArtifactAccess(input: {
    actorId?: string | null;
    slug: string;
    version: string;
    platform?: string;
    decision: "allow" | "deny";
    reason?: string;
  }): Promise<void> {
    this.recordAudit("artifact.bundle", input.decision, input.actorId ?? null, {
      slug: input.slug,
      version: input.version,
      platform: input.platform,
      reason: input.reason,
    });
  }

  count(): number {
    return this.submissions.size;
  }

  async recordDenied(): Promise<void> {
    this.denied += 1;
  }

  deniedCount(): number {
    return this.denied;
  }

  auditEvents(): AuditRecord[] {
    return this.audit;
  }

  private findSubmission(id: string): StoredSubmission | null {
    return [...this.submissions.values()].find((submission) => submission.id === id) ?? null;
  }

  private findSubmissionBySlugVersion(slug: string, version: string): StoredSubmission | null {
    return [...this.submissions.values()].find((submission) => (
      submission.skillSlug === slug &&
      submission.version === version
    )) ?? null;
  }

  private findSubmissionsBySlug(slug: string): StoredSubmission[] {
    return [...this.submissions.values()].filter((submission) => submission.skillSlug === slug);
  }

  private findPublicSubmission(slug: string, version: string): StoredSubmission | null {
    const skillLifecycle = this.skillLifecycle.get(slug) ?? restoredSkillLifecycle(this.findSubmissionsBySlug(slug));
    return [...this.submissions.values()].find((submission) => (
      submission.skillSlug === slug &&
      submission.version === version &&
      isPubliclyVisibleRelease(submission, skillLifecycle)
    )) ?? null;
  }

  private recordAudit(action: string, decision: "allow" | "deny", actorId: string | null | undefined, details: Record<string, unknown>): void {
    this.audit.push({ action, decision, actorId, details: sanitizeAuditDetails(details) });
  }
}

function canManageSkill(submission: StoredSubmission, actor: SubmissionActor): boolean {
  return submission.ownerUserId === actor.id || actor.roles.some((role) => role === "owner" || role === "admin" || role === "maintainer");
}

function assertCanManageSkill(submission: StoredSubmission, actor: SubmissionActor): void {
  if (!canManageSkill(submission, actor)) {
    throw new AppError("Skill management requires owner or maintainer permissions.", "SKILL_MANAGEMENT_ROLE_REQUIRED", 403);
  }
}

function skillManagementSummary(submissions: StoredSubmission[], lifecycleStatus?: SkillLifecycleStatus): SkillManagementSummary {
  const latest = [...submissions].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!latest) {
    throw new AppError("Skill not found.", "SKILL_NOT_FOUND", 404);
  }
  return {
    slug: latest.skillSlug,
    title: latest.title,
    summary: latest.summary,
    lifecycleStatus: lifecycleStatus ?? restoredSkillLifecycle(submissions),
    visibility: latest.visibility,
    tags: [],
    allowedActions: ["edit", "archive", "restore", "delete"],
  };
}

function restoredSkillLifecycle(submissions: StoredSubmission[]): SkillLifecycleStatus {
  if (submissions.some((submission) => isPubliclyVisibleRelease(submission, "approved"))) {
    return "approved";
  }
  if (submissions.some((submission) => submission.publishedAt)) {
    return "unpublished";
  }
  if (submissions.some((submission) => submission.reviewStatus !== "rejected")) {
    return "submitted";
  }
  return "archived";
}

function releaseSummary(submission: StoredSubmission, actor: SubmissionActor | null = null): SkillReleaseSummary {
  const allowedActions = releaseAllowedActions(submission);
  return {
    id: submission.id,
    slug: submission.skillSlug,
    version: submission.version,
    lifecycleStatus: submission.lifecycleStatus,
    reviewStatus: submission.reviewStatus,
    securityStatus: submission.securityStatus,
    publishedAt: submission.publishedAt,
    platforms: submission.platforms,
    findingCount: submission.scan.findings.length,
    allowedActions: submission.lifecycleStatus === "revoked" && !isPrivilegedReleaseActor(actor)
      ? allowedActions.filter((action) => action !== "restore")
      : allowedActions,
  };
}

function isPrivilegedReleaseActor(actor: SubmissionActor | null): boolean {
  return Boolean(actor?.roles.some((role) => role === "owner" || role === "admin" || role === "maintainer"));
}

function isSafeRevokedRestore(submission: StoredSubmission): boolean {
  return submission.reviewStatus === "approved" &&
    submission.securityStatus === "passed" &&
    submission.scan.status === "succeeded" &&
    Boolean(submission.publishedAt) &&
    Boolean(submission.approvedArtifactSha256) &&
    submission.approvedArtifactSha256 === submission.artifact.sha256;
}

function reviewSubmissionSummary(submission: StoredSubmission, skillLifecycle?: SkillLifecycleStatus): ReviewSubmissionSummary {
  return {
    id: submission.id,
    slug: submission.skillSlug,
    title: submission.title,
    version: submission.version,
    visibility: submission.visibility,
    lifecycleStatus: submission.lifecycleStatus,
    reviewStatus: submission.reviewStatus,
    securityStatus: submission.securityStatus,
    approvedArtifactSha256: submission.approvedArtifactSha256,
    platforms: submission.platforms,
    findingCount: submission.scan.findings.length,
    createdAt: submission.createdAt,
    allowedActions: reviewAllowedActions(submission, skillLifecycle),
  };
}

function reviewAllowedActions(submission: StoredSubmission, skillLifecycle?: SkillLifecycleStatus): ReviewSubmissionSummary["allowedActions"] {
  if (!isActiveReviewSubmission(submission, skillLifecycle)) {
    return [];
  }
  if (submission.reviewStatus === "approved" && !submission.publishedAt && submission.securityStatus === "passed") {
    return submission.approvedArtifactSha256 ? ["publish"] : [];
  }
  if (["unreviewed", "changes-requested"].includes(submission.reviewStatus)) {
    return submission.securityStatus === "passed"
      ? ["approve", "request-changes", "reject"]
      : ["request-changes", "reject"];
  }
  return [];
}

function isReviewQueueSubmission(submission: StoredSubmission, skillLifecycle?: SkillLifecycleStatus): boolean {
  if (!isActiveReviewSubmission(submission, skillLifecycle)) {
    return false;
  }
  return ["unreviewed", "changes-requested"].includes(submission.reviewStatus) ||
    (submission.reviewStatus === "approved" && !submission.publishedAt);
}

function isActiveReviewSubmission(submission: StoredSubmission, skillLifecycle?: SkillLifecycleStatus): boolean {
  return submission.lifecycleStatus !== "archived" && skillLifecycle !== "archived";
}

function submissionAllowedActions(submission: StoredSubmission): UserSubmissionSummary["allowedActions"] {
  const actions: UserSubmissionSummary["allowedActions"] = ["export"];
  if (!submission.publishedAt && ["unreviewed", "changes-requested"].includes(submission.reviewStatus)) {
    actions.push("withdraw");
  }
  return actions;
}

function releaseAllowedActions(submission: StoredSubmission): ReleaseLifecycleAction[] {
  if (submission.reviewStatus !== "approved" || submission.securityStatus !== "passed") {
    return [];
  }
  if (!submission.publishedAt) {
    return ["delete"];
  }
  if (submission.lifecycleStatus === "approved") {
    return ["deprecate", "unpublish", "revoke"];
  }
  if (submission.lifecycleStatus === "deprecated") {
    return ["restore", "unpublish", "revoke"];
  }
  if (submission.lifecycleStatus === "unpublished" || submission.lifecycleStatus === "revoked") {
    return ["restore", "delete"];
  }
  return [];
}

function lifecycleForReleaseAction(action: ReleaseLifecycleAction): SkillLifecycleStatus {
  if (action === "deprecate") {
    return "deprecated";
  }
  if (action === "unpublish") {
    return "unpublished";
  }
  if (action === "revoke") {
    return "revoked";
  }
  if (action === "restore") {
    return "approved";
  }
  return "archived";
}

function isPubliclyVisibleRelease(submission: StoredSubmission, skillLifecycle: SkillLifecycleStatus): boolean {
  return (skillLifecycle === "approved" || skillLifecycle === "deprecated") &&
    submission.visibility === "public" &&
    submission.reviewStatus === "approved" &&
    submission.securityStatus === "passed" &&
    (submission.lifecycleStatus === "approved" || submission.lifecycleStatus === "deprecated") &&
    Boolean(submission.publishedAt);
}

function reviewActionResult(submission: StoredSubmission): ReviewActionResult {
  return {
    id: submission.id,
    slug: submission.skillSlug,
    version: submission.version,
    visibility: submission.visibility,
    lifecycleStatus: submission.lifecycleStatus,
    reviewStatus: submission.reviewStatus,
    securityStatus: submission.securityStatus,
    approvedArtifactSha256: submission.approvedArtifactSha256,
    publishedAt: submission.publishedAt,
  };
}

function userSubmissionSummary(submission: StoredSubmission): UserSubmissionSummary {
  return {
    id: submission.id,
    slug: submission.skillSlug,
    title: submission.title,
    summary: submission.summary,
    version: submission.version,
    visibility: submission.visibility,
    lifecycleStatus: submission.lifecycleStatus,
    reviewStatus: submission.reviewStatus,
    securityStatus: submission.securityStatus,
    platforms: submission.platforms,
    findingCount: submission.scan.findings.length,
    artifact: {
      sha256: submission.artifact.sha256,
      byteSize: submission.artifact.byteSize,
      contentType: submission.artifact.contentType,
    },
    createdAt: submission.createdAt,
    publishedAt: submission.publishedAt,
    allowedActions: submissionAllowedActions(submission),
  };
}

function publicRelease(submission: StoredSubmission): PublicReleaseMetadata {
  if (!submission.publishedAt) {
    throw new AppError("Published release is missing publication time.", "INVALID_RELEASE_STATE", 500);
  }
  return {
    slug: submission.skillSlug,
    title: submission.title,
    summary: submission.summary,
    version: submission.version,
    lifecycleStatus: submission.lifecycleStatus === "deprecated" ? "deprecated" : "approved",
    reviewStatus: "approved",
    securityStatus: "passed",
    publishedAt: submission.publishedAt,
    platforms: submission.platforms,
    artifact: {
      sha256: submission.artifact.sha256,
      byteSize: submission.artifact.byteSize,
      contentType: submission.artifact.contentType,
    },
  };
}

function assertArtifactManifestMatchesSubmission(submission: StoredSubmission): void {
  const manifest = manifestFromArtifactPayload(submission.artifact.payload);
  if (manifest.name !== submission.skillSlug || manifest.version !== submission.version) {
    throw new AppError("Package manifest does not match the reviewed submission.", "PACKAGE_MANIFEST_MISMATCH", 422);
  }
}

function manifestFromArtifactPayload(input: StoredSubmission["artifact"]["payload"]): SkillManifest {
  try {
    return loadSkillManifestFromPackageFiles(input.files);
  } catch (error) {
    if (error instanceof PackageManifestFileError) {
      throw new AppError(error.message, error.code, 422);
    }
    throw new AppError(error instanceof Error ? error.message : "Invalid artifact payload.", "INVALID_PACKAGE_PAYLOAD", 422);
  }
}
