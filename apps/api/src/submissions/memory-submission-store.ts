import {
  AppError,
  assertValidOrganizationPolicyV1,
  defaultOrganizationPolicyV1,
  evaluateOrganizationRead,
  type OrganizationMembershipRole,
  type OrganizationPolicyV1,
  type OrganizationStatus,
  type SharingSettings,
  type SkillLifecycleStatus,
} from "@myskills-app/core";
import {
  loadSkillManifestFromPackageFiles,
  PackageManifestFileError,
  type SkillManifest,
} from "@myskills-app/skill-package";
import { sanitizeAuditDetails } from "../audit/sanitize.js";
import { isEffectiveTeamMembership } from "../teams/effective-membership.js";
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
  UserSubmissionDetail,
  ReviewSubmissionDetail,
  SubmissionFeedback,
  ManagedSkillFilters,
} from "./types.js";
import { assertNoVisibilityMetadataUpdate } from "./types.js";
import { artifactPayloadSha256 } from "./artifact-hash.js";
import { submissionReviewHistory } from "./feedback.js";

interface AuditRecord {
  action: string;
  decision: "allow" | "deny";
  actorId?: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

interface MemoryOrganization {
  id: string;
  status: OrganizationStatus;
  currentPolicyRevisionId: string | null;
  policy: OrganizationPolicyV1;
}

interface MemoryOrganizationMembership {
  userId: string;
  organizationId: string;
  role: OrganizationMembershipRole;
  removedAt: string | null;
}

interface MemoryOrganizationGrant {
  organizationId: string;
  policyRevisionId: string;
}

export interface MemorySubmissionStoreOptions {
  /** Instance sharing flags used by direct release metadata and bundle reads. */
  sharingSettings?: Partial<SharingSettings>;
  /** Organization snapshots used by the actor-aware visibility evaluator. */
  organizations?: Array<{
    id: string;
    name?: string;
    slug?: string;
    status?: OrganizationStatus;
    currentPolicyRevisionId?: string | null;
    policy?: OrganizationPolicyV1;
  }>;
  organizationMemberships?: Array<{
    userId: string;
    organizationId: string;
    role?: OrganizationMembershipRole;
    removedAt?: string | null;
  }>;
  organizationGrants?: Array<{
    slug: string;
    organizationId: string;
    policyRevisionId?: string | null;
  }>;
  /** Existing non-organization visibility fixtures for parity tests. */
  teams?: Array<{ id: string; organizationId?: string | null }>;
  teamMemberships?: Array<{ userId: string; teamId: string; organizationId?: string | null }>;
  teamGrants?: Array<{ slug: string; teamId: string }>;
  userGrants?: Array<{ slug: string; userId: string }>;
}

type RequiredSharingSettings = Required<SharingSettings>;

const DEFAULT_SHARING_SETTINGS: RequiredSharingSettings = {
  publicVisibilityEnabled: true,
  authenticatedVisibilityEnabled: true,
  teamsEnabled: true,
  teamVisibilityEnabled: true,
  userVisibilityEnabled: true,
  organizationVisibilityEnabled: false,
};

export class MemorySubmissionStore implements SubmissionStore {
  private submissions = new Map<string, StoredSubmission>();
  private skillLifecycle = new Map<string, SkillLifecycleStatus>();
  private sharingSettings: RequiredSharingSettings = { ...DEFAULT_SHARING_SETTINGS };
  private organizations = new Map<string, MemoryOrganization>();
  private organizationMemberships = new Map<string, MemoryOrganizationMembership>();
  private organizationGrants = new Map<string, Map<string, MemoryOrganizationGrant>>();
  private teamMemberships = new Set<string>();
  private teamOrganizations = new Map<string, string | null>();
  private teamGrants = new Set<string>();
  private userGrants = new Set<string>();
  private denied = 0;
  private audit: AuditRecord[] = [];
  private tags = new Map<string, string[]>();

  constructor(options: MemorySubmissionStoreOptions = {}) {
    this.sharingSettings = normalizeSharingSettings(options.sharingSettings);
    for (const team of options.teams ?? []) {
      this.addTeam(team);
    }
    for (const organization of options.organizations ?? []) {
      this.addOrganization(organization);
    }
    for (const membership of options.organizationMemberships ?? []) {
      this.addOrganizationMembership(membership.userId, membership.organizationId, {
        role: membership.role,
        removedAt: membership.removedAt,
      });
    }
    for (const grant of options.organizationGrants ?? []) {
      this.addOrganizationGrant(grant.slug, grant.organizationId, grant.policyRevisionId);
    }
    for (const membership of options.teamMemberships ?? []) {
      if (membership.organizationId !== undefined) {
        this.setTeamOrganization(membership.teamId, membership.organizationId);
      }
      this.addTeamMembership(membership.userId, membership.teamId);
    }
    for (const grant of options.teamGrants ?? []) {
      this.addTeamGrant(grant.slug, grant.teamId);
    }
    for (const grant of options.userGrants ?? []) {
      this.addUserGrant(grant.slug, grant.userId);
    }
  }

  addOrganization(input: {
    id: string;
    name?: string;
    slug?: string;
    status?: OrganizationStatus;
    currentPolicyRevisionId?: string | null;
    policy?: OrganizationPolicyV1;
  }): void {
    this.organizations.set(input.id, {
      id: input.id,
      status: input.status ?? "active",
      currentPolicyRevisionId: input.currentPolicyRevisionId === undefined
        ? `${input.id}:policy:1`
        : input.currentPolicyRevisionId,
      policy: assertValidOrganizationPolicyV1(input.policy ?? defaultOrganizationPolicyV1),
    });
  }

  addOrganizationMembership(
    userId: string,
    organization: string | {
      id: string;
      name?: string;
      slug?: string;
      status?: OrganizationStatus;
      role: OrganizationMembershipRole;
    },
    options: { role?: OrganizationMembershipRole; removedAt?: string | null } | OrganizationMembershipRole = {},
  ): void {
    const organizationId = typeof organization === "string" ? organization : organization.id;
    const role = typeof organization === "string"
      ? (typeof options === "string" ? options : options.role)
      : organization.role;
    if (typeof organization !== "string" && !this.organizations.has(organizationId)) {
      this.addOrganization(organization);
    }
    this.organizationMemberships.set(`${userId}\u0000${organizationId}`, {
      userId,
      organizationId,
      role: role ?? "member",
      removedAt: typeof options === "string" ? null : options.removedAt ?? null,
    });
  }

  removeOrganizationMembership(userId: string, organizationId: string): void {
    this.organizationMemberships.delete(`${userId}\u0000${organizationId}`);
  }

  setOrganizationStatus(organizationId: string, status: OrganizationStatus): void {
    const organization = this.organizations.get(organizationId);
    if (!organization) {
      throw new AppError("Organization not found.", "ORGANIZATION_NOT_FOUND", 404);
    }
    organization.status = status;
  }

  setOrganizationPolicy(
    organizationId: string,
    policy: OrganizationPolicyV1,
    currentPolicyRevisionId = `${organizationId}:policy:${Date.now()}`,
  ): void {
    const organization = this.organizations.get(organizationId);
    if (!organization) {
      throw new AppError("Organization not found.", "ORGANIZATION_NOT_FOUND", 404);
    }
    organization.policy = assertValidOrganizationPolicyV1(policy);
    organization.currentPolicyRevisionId = currentPolicyRevisionId;
  }

  addOrganizationGrant(slug: string, organizationId: string, policyRevisionId?: string | null): void {
    const organization = this.organizations.get(organizationId);
    if (!organization) {
      throw new AppError("Organization not found.", "ORGANIZATION_NOT_FOUND", 404);
    }
    const revisionId = policyRevisionId ?? organization.currentPolicyRevisionId;
    if (!revisionId) {
      throw new AppError("Organization current policy is required.", "ORGANIZATION_POLICY_REQUIRED", 403);
    }
    const grants = this.organizationGrants.get(slug) ?? new Map<string, MemoryOrganizationGrant>();
    grants.set(organizationId, { organizationId, policyRevisionId: revisionId });
    this.organizationGrants.set(slug, grants);
  }

  setSharingSettings(settings: Partial<SharingSettings>): void {
    this.sharingSettings = normalizeSharingSettings({ ...this.sharingSettings, ...settings });
  }

  async updateSharingSettings(settings: Partial<SharingSettings>): Promise<RequiredSharingSettings> {
    this.setSharingSettings(settings);
    return { ...this.sharingSettings };
  }

  addTeamMembership(userId: string, teamId: string, options: { organizationId?: string | null } = {}): void {
    if (options.organizationId !== undefined) {
      this.setTeamOrganization(teamId, options.organizationId);
    }
    this.teamMemberships.add(`${userId}\u0000${teamId}`);
  }

  addTeam(input: { id: string; organizationId?: string | null }): void {
    this.teamOrganizations.set(input.id, input.organizationId ?? null);
  }

  removeTeamMembership(userId: string, teamId: string): void {
    this.teamMemberships.delete(`${userId}\u0000${teamId}`);
  }

  setTeamOrganization(teamId: string, organizationId: string | null): void {
    this.teamOrganizations.set(teamId, organizationId);
  }

  addTeamGrant(slug: string, teamId: string): void {
    this.teamGrants.add(`${slug}\u0000${teamId}`);
  }

  addUserGrant(slug: string, userId: string): void {
    this.userGrants.add(`${slug}\u0000${userId}`);
  }

  async createSubmission(input: CreateSubmissionInput & {
    release: StoredSubmission["release"];
    artifact: StoredSubmission["artifact"];
    findings: StoredSubmission["scan"]["findings"];
    securityStatus: StoredSubmission["securityStatus"];
  }): Promise<StoredSubmission> {
    const key = `${input.manifest.name}@${input.manifest.version}`;
    const existing = this.findSubmissionsBySlug(input.manifest.name)[0];
    if (existing && existing.ownerUserId !== input.actor.id) {
      throw new AppError("Package slug is unavailable.", "PACKAGE_SLUG_UNAVAILABLE", 409);
    }
    if (this.submissions.has(key)) {
      throw new AppError("Package version already exists.", "PACKAGE_VERSION_EXISTS", 409);
    }
    if (input.manifest.visibility === "organization" && !this.sharingSettings.organizationVisibilityEnabled) {
      throw new AppError("Organization sharing is disabled for this instance.", "ORGANIZATION_SHARING_DISABLED", 403);
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
      release: input.release,
      artifact: input.artifact,
      scan: {
        status: "succeeded",
        findings: input.findings,
      },
    };
    this.submissions.set(key, submission);
    this.tags.set(input.manifest.name, [...new Set([...(this.tags.get(input.manifest.name) ?? []), ...input.manifest.tags])].sort());
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

  async getUserSubmissionDetail(input: { userId: string; submissionId: string }): Promise<UserSubmissionDetail | null> {
    const submission = this.findSubmission(input.submissionId);
    if (!submission || submission.ownerUserId !== input.userId) return null;
    return {
      ...userSubmissionSummary(submission),
      ...this.submissionFeedback(submission),
      correction: {
        requiresNewVersion: true,
        canSubmitNewVersion: true,
      },
    };
  }

  async getReviewSubmissionDetail(submissionId: string): Promise<ReviewSubmissionDetail | null> {
    const submission = this.findSubmission(submissionId);
    if (!submission) return null;
    return {
      ...reviewSubmissionSummary(submission, this.skillLifecycle.get(submission.skillSlug)),
      ...this.submissionFeedback(submission),
    };
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
    return skillManagementSummary(submissions, this.skillLifecycle.get(input.slug), this.tags.get(input.slug));
  }

  async listManagedSkills(input: ManagedSkillFilters): Promise<SkillManagementSummary[]> {
    const query = input.query?.trim().toLowerCase() ?? "";
    const slugs = [...new Set([...this.submissions.values()]
      .filter((submission) => canManageSkill(submission, input.actor))
      .map((submission) => submission.skillSlug))].sort();
    return slugs
      .filter((slug) => !input.afterSlug || slug > input.afterSlug)
      .map((slug) => skillManagementSummary(this.findSubmissionsBySlug(slug), this.skillLifecycle.get(slug), this.tags.get(slug)))
      .filter((skill) => !query || [skill.slug, skill.title, skill.summary].some((value) => value.toLowerCase().includes(query)))
      .slice(0, input.limit ?? 50);
  }

  async updateSkillMetadata(input: { slug: string; actor: SubmissionActor; update: SkillMetadataUpdate; reason?: string }): Promise<SkillManagementSummary> {
    assertNoVisibilityMetadataUpdate(input.update);
    const submissions = this.findSubmissionsBySlug(input.slug);
    const first = submissions[0];
    if (!first) {
      throw new AppError("Skill not found.", "SKILL_NOT_FOUND", 404);
    }
    assertCanManageSkill(first, input.actor);
    if (input.update.tags !== undefined) this.tags.set(input.slug, [...new Set(input.update.tags)].sort());
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
    return skillManagementSummary(submissions, this.skillLifecycle.get(input.slug), this.tags.get(input.slug));
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
      ...skillManagementSummary(submissions, lifecycleStatus, this.tags.get(input.slug)),
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
      .filter((submission) => canManage || this.isVisibleReleaseForActor(submission, input.actor?.id ?? null, skillLifecycle))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((submission) => ({
        ...releaseSummary(submission, input.actor ?? null),
        ...(canManage ? {} : { allowedActions: [] }),
      }));
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
    const submission = this.findVisibleSubmission(input.slug, input.version, input.actorId ?? null);
    return submission ? publicRelease(submission) : null;
  }

  async getPublicBundle(input: { slug: string; version: string; platform?: string; actorId?: string | null }): Promise<PublicBundle | null> {
    const submission = this.findVisibleSubmission(input.slug, input.version, input.actorId ?? null);
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

  private findVisibleSubmission(slug: string, version: string, actorId: string | null): StoredSubmission | null {
    const skillLifecycle = this.skillLifecycle.get(slug) ?? restoredSkillLifecycle(this.findSubmissionsBySlug(slug));
    return [...this.submissions.values()].find((submission) => (
      submission.skillSlug === slug &&
      submission.version === version &&
      this.isVisibleReleaseForActor(submission, actorId, skillLifecycle)
    )) ?? null;
  }

  private isVisibleReleaseForActor(
    submission: StoredSubmission,
    actorId: string | null,
    skillLifecycle: SkillLifecycleStatus,
  ): boolean {
    if (!isReleasedSubmission(submission, skillLifecycle)) {
      return false;
    }
    if (actorId && submission.ownerUserId === actorId) {
      return true;
    }
    if (submission.visibility === "public") {
      return this.sharingSettings.publicVisibilityEnabled;
    }
    if (!actorId) {
      return false;
    }
    if (submission.visibility === "authenticated") {
      return this.sharingSettings.authenticatedVisibilityEnabled;
    }
    if (submission.visibility === "team" && this.sharingSettings.teamsEnabled && this.sharingSettings.teamVisibilityEnabled) {
      return [...this.teamMemberships].some((membership) => (
        membership.startsWith(`${actorId}\u0000`) &&
        this.isEffectiveTeamMembership(
          actorId,
          membership.slice(actorId.length + 1),
        ) &&
        this.teamGrants.has(`${submission.skillSlug}\u0000${membership.slice(actorId.length + 1)}`)
      ));
    }
    if (submission.visibility === "explicit-users" && this.sharingSettings.userVisibilityEnabled) {
      return this.userGrants.has(`${submission.skillSlug}\u0000${actorId}`);
    }
    if (submission.visibility === "organization") {
      return this.isVisibleOrganizationRelease(submission.skillSlug, actorId);
    }
    return false;
  }

  private isVisibleOrganizationRelease(slug: string, actorId: string): boolean {
    if (!this.sharingSettings.organizationVisibilityEnabled) {
      return false;
    }
    const grants = this.organizationGrants.get(slug);
    if (!grants) {
      return false;
    }
    for (const membership of this.organizationMemberships.values()) {
      if (membership.userId !== actorId || membership.removedAt !== null) {
        continue;
      }
      const organization = this.organizations.get(membership.organizationId);
      const grant = grants.get(membership.organizationId);
      if (!organization || !grant || !organization.currentPolicyRevisionId) {
        continue;
      }
      if (grant.policyRevisionId !== organization.currentPolicyRevisionId) {
        continue;
      }
      if (organization.status !== "active") {
        continue;
      }
      const decision = evaluateOrganizationRead({
        organizationId: organization.id,
        organizationStatus: organization.status,
        policy: organization.policy,
        actor: {
          userId: actorId,
          memberships: [{
            organizationId: organization.id,
            userId: actorId,
            role: membership.role,
          }],
        },
        resource: "skill",
      });
      if (decision.allowed) {
        return true;
      }
    }
    return false;
  }

  private isEffectiveTeamMembership(actorId: string, teamId: string): boolean {
    const organizationId = this.teamOrganizations.get(teamId) ?? null;
    if (organizationId === null) return true;
    const organization = this.organizations.get(organizationId);
    const membership = this.organizationMemberships.get(`${actorId}\u0000${organizationId}`);
    return isEffectiveTeamMembership({
      organizationId,
      organizationStatus: organization?.status,
      currentPolicyRevisionId: organization?.currentPolicyRevisionId,
      hasCurrentPolicy: Boolean(organization && organization.currentPolicyRevisionId && organization.policy),
      hasActiveOrganizationMembership: Boolean(membership && membership.removedAt === null),
      requireOrganizationMembershipForTeamMembers: organization?.policy.teams.requireOrganizationMembershipForTeamMembers,
    });
  }

  private recordAudit(action: string, decision: "allow" | "deny", actorId: string | null | undefined, details: Record<string, unknown>): void {
    this.audit.push({ action, decision, actorId, details: sanitizeAuditDetails(details), createdAt: new Date().toISOString() });
  }

  private submissionFeedback(submission: StoredSubmission): SubmissionFeedback {
    const reviewHistory = submissionReviewHistory(this.audit.filter((event) => (
      event.decision === "allow" && event.details.submissionId === submission.id
    )));
    return {
      changeRequestReason: submission.reviewStatus === "changes-requested"
        ? [...reviewHistory].reverse().find((event) => event.action === "request-changes")?.reason ?? null
        : null,
      reviewHistory,
      scanRuns: [{
        id: `${submission.id}:scan`,
        status: submission.scan.status,
        createdAt: submission.createdAt,
        startedAt: submission.createdAt,
        completedAt: submission.createdAt,
        findings: submission.scan.findings.map((finding) => ({ ...finding })),
      }],
    };
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

function skillManagementSummary(submissions: StoredSubmission[], lifecycleStatus?: SkillLifecycleStatus, tags: string[] = []): SkillManagementSummary {
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
    tags: [...tags],
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
    releaseNotes: submission.release.releaseNotes,
    changeKind: submission.release.changeKind,
    requiresUserAction: submission.release.requiresUserAction,
    compatibility: submission.release.compatibility,
    artifact: {
      sha256: submission.artifact.sha256,
      byteSize: submission.artifact.byteSize,
      contentType: submission.artifact.contentType,
    },
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
  return isReleasedSubmission(submission, skillLifecycle) &&
    submission.visibility === "public";
}

function isReleasedSubmission(submission: StoredSubmission, skillLifecycle: SkillLifecycleStatus): boolean {
  return (skillLifecycle === "approved" || skillLifecycle === "deprecated") &&
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
    releaseNotes: submission.release.releaseNotes,
    changeKind: submission.release.changeKind,
    requiresUserAction: submission.release.requiresUserAction,
    compatibility: submission.release.compatibility,
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

function normalizeSharingSettings(input: Partial<SharingSettings> | undefined): RequiredSharingSettings {
  const record = input ?? {};
  return {
    publicVisibilityEnabled: record.publicVisibilityEnabled ?? DEFAULT_SHARING_SETTINGS.publicVisibilityEnabled,
    authenticatedVisibilityEnabled: record.authenticatedVisibilityEnabled ?? DEFAULT_SHARING_SETTINGS.authenticatedVisibilityEnabled,
    teamsEnabled: record.teamsEnabled ?? DEFAULT_SHARING_SETTINGS.teamsEnabled,
    teamVisibilityEnabled: record.teamVisibilityEnabled ?? DEFAULT_SHARING_SETTINGS.teamVisibilityEnabled,
    userVisibilityEnabled: record.userVisibilityEnabled ?? DEFAULT_SHARING_SETTINGS.userVisibilityEnabled,
    organizationVisibilityEnabled: record.organizationVisibilityEnabled ?? DEFAULT_SHARING_SETTINGS.organizationVisibilityEnabled,
  };
}
