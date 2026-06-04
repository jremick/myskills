import { AppError } from "@ai-skills-share/core";
import type {
  CreateSubmissionInput,
  PublicBundle,
  PublicReleaseMetadata,
  ReviewActionResult,
  ReviewSubmissionSummary,
  StoredSubmission,
  SubmissionStore,
} from "./types.js";

interface AuditRecord {
  action: string;
  decision: "allow" | "deny";
  actorId?: string | null;
  details: Record<string, unknown>;
}

export class MemorySubmissionStore implements SubmissionStore {
  private submissions = new Map<string, StoredSubmission>();
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
      skillSlug: input.manifest.name,
      title: input.manifest.title,
      summary: input.manifest.summary,
      version: input.manifest.version,
      visibility: input.manifest.visibility,
      platforms: input.manifest.platforms.map((platform) => ({
        name: platform.name,
        installTarget: platform.install_target,
        status: platform.status,
      })),
      reviewStatus: "unreviewed",
      securityStatus: input.securityStatus,
      publishedAt: null,
      artifact: input.artifact,
      scan: {
        status: "succeeded",
        findings: input.findings,
      },
    };
    this.submissions.set(key, submission);
    return submission;
  }

  async listReviewSubmissions(): Promise<ReviewSubmissionSummary[]> {
    return [...this.submissions.values()]
      .filter((submission) => ["unreviewed", "changes-requested"].includes(submission.reviewStatus))
      .map((submission) => ({
        id: submission.id,
        slug: submission.skillSlug,
        title: submission.title,
        version: submission.version,
        visibility: submission.visibility,
        reviewStatus: submission.reviewStatus,
        securityStatus: submission.securityStatus,
        platforms: submission.platforms,
        findingCount: submission.scan.findings.length,
        createdAt: "2026-01-01T00:00:00.000Z",
      }));
  }

  async approveSubmission(input: { actorId: string; submissionId: string; reason?: string }): Promise<ReviewActionResult> {
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
    submission.reviewStatus = "approved";
    this.recordAudit("review.approve", "allow", input.actorId, {
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
    submission.publishedAt = new Date().toISOString();
    this.recordAudit("release.publish", "allow", input.actorId, {
      submissionId: submission.id,
      slug: submission.skillSlug,
      version: submission.version,
      reason: input.reason,
    });
    return reviewActionResult(submission);
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

  async getPublicRelease(input: { slug: string; version: string }): Promise<PublicReleaseMetadata | null> {
    const submission = this.findPublicSubmission(input.slug, input.version);
    return submission ? publicRelease(submission) : null;
  }

  async getPublicBundle(input: { slug: string; version: string; platform?: string }): Promise<PublicBundle | null> {
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

  private findPublicSubmission(slug: string, version: string): StoredSubmission | null {
    return [...this.submissions.values()].find((submission) => (
      submission.skillSlug === slug &&
      submission.version === version &&
      submission.visibility === "public" &&
      submission.reviewStatus === "approved" &&
      submission.securityStatus === "passed" &&
      Boolean(submission.publishedAt)
    )) ?? null;
  }

  private recordAudit(action: string, decision: "allow" | "deny", actorId: string | null | undefined, details: Record<string, unknown>): void {
    this.audit.push({ action, decision, actorId, details: sanitizeAuditDetails(details) });
  }
}

function reviewActionResult(submission: StoredSubmission): ReviewActionResult {
  return {
    id: submission.id,
    slug: submission.skillSlug,
    version: submission.version,
    visibility: submission.visibility,
    lifecycleStatus: submission.publishedAt ? "approved" : "review",
    reviewStatus: submission.reviewStatus,
    securityStatus: submission.securityStatus,
    publishedAt: submission.publishedAt,
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

function sanitizeAuditDetails(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, sanitizeAuditValue(value)]),
  );
}

function sanitizeAuditValue(input: unknown): unknown {
  if (typeof input === "string") {
    if (/token|secret|password|cookie|private[-_ ]?key|package content/i.test(input)) {
      return "[redacted]";
    }
    const redacted = input
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
      .replace(/ATATT[A-Za-z0-9_-]+/g, "[redacted-token]")
      .replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/g, "[redacted-private-key]");
    return redacted.length > 200 ? `${redacted.slice(0, 200)}...` : redacted;
  }
  if (Array.isArray(input)) {
    return input.map(sanitizeAuditValue);
  }
  if (input && typeof input === "object") {
    return sanitizeAuditDetails(input as Record<string, unknown>);
  }
  return input;
}
