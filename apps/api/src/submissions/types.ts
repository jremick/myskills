import type { Role } from "@myskills-app/auth";
import type { SkillManifest, PackageInputFile, ScanFinding } from "@myskills-app/skill-package";
import type {
  ReviewStatus,
  SecurityStatus,
  SkillLifecycleStatus,
  SkillPlatformVariant,
  VisibilityScope,
} from "@myskills-app/core";

export interface ArtifactPayload {
  files: PackageInputFile[];
}

export interface SubmissionActor {
  id: string;
  roles: Role[];
}

export interface CreateSubmissionInput {
  actor: SubmissionActor;
  manifest: SkillManifest;
  files: PackageInputFile[];
}

export interface StoredSubmission {
  id: string;
  ownerUserId: string;
  skillSlug: string;
  title: string;
  summary: string;
  version: string;
  visibility: VisibilityScope;
  lifecycleStatus: SkillLifecycleStatus;
  platforms: SkillPlatformVariant[];
  reviewStatus: ReviewStatus;
  securityStatus: SecurityStatus;
  publishedAt: string | null;
  createdAt: string;
  artifact: {
    storageKey: string;
    sha256: string;
    byteSize: number;
    contentType: string;
    payload: ArtifactPayload;
  };
  scan: {
    status: "succeeded";
    findings: ScanFinding[];
  };
}

export type ReviewAction = "approve" | "request-changes" | "reject" | "publish";
export type SubmissionOwnerAction = "withdraw";
export type ReleaseLifecycleAction = "deprecate" | "unpublish" | "revoke" | "restore" | "delete";
export type SkillLifecycleAction = "archive" | "restore" | "delete";

export interface SkillMetadataUpdate {
  title?: string;
  summary?: string;
  visibility?: VisibilityScope;
  tags?: string[];
}

export interface ReviewSubmissionSummary {
  id: string;
  slug: string;
  title: string;
  version: string;
  visibility: VisibilityScope;
  lifecycleStatus: SkillLifecycleStatus;
  reviewStatus: ReviewStatus;
  securityStatus: SecurityStatus;
  platforms: SkillPlatformVariant[];
  findingCount: number;
  createdAt: string;
  allowedActions: ReviewAction[];
}

export interface ReviewActionResult {
  id: string;
  slug: string;
  version: string;
  visibility: VisibilityScope;
  lifecycleStatus: SkillLifecycleStatus;
  reviewStatus: ReviewStatus;
  securityStatus: SecurityStatus;
  publishedAt: string | null;
}

export interface UserSubmissionSummary {
  id: string;
  slug: string;
  title: string;
  summary: string;
  version: string;
  visibility: VisibilityScope;
  lifecycleStatus: SkillLifecycleStatus;
  reviewStatus: ReviewStatus;
  securityStatus: SecurityStatus;
  platforms: SkillPlatformVariant[];
  findingCount: number;
  artifact: {
    sha256: string;
    byteSize: number;
    contentType: string;
  };
  createdAt: string;
  publishedAt: string | null;
  allowedActions: Array<"export" | SubmissionOwnerAction>;
}

export interface PublicReleaseMetadata {
  slug: string;
  title: string;
  summary: string;
  version: string;
  lifecycleStatus: Extract<SkillLifecycleStatus, "approved" | "deprecated">;
  reviewStatus: "approved";
  securityStatus: "passed";
  publishedAt: string;
  platforms: SkillPlatformVariant[];
  artifact: {
    sha256: string;
    byteSize: number;
    contentType: string;
  };
}

export interface SkillManagementSummary {
  slug: string;
  title: string;
  summary: string;
  lifecycleStatus: SkillLifecycleStatus;
  visibility: VisibilityScope;
  tags: string[];
  allowedActions: Array<"edit" | SkillLifecycleAction>;
}

export interface SkillReleaseSummary {
  id: string;
  slug: string;
  version: string;
  lifecycleStatus: SkillLifecycleStatus;
  reviewStatus: ReviewStatus;
  securityStatus: SecurityStatus;
  publishedAt: string | null;
  platforms: SkillPlatformVariant[];
  findingCount: number;
  allowedActions: ReleaseLifecycleAction[];
}

export interface PublicBundle extends PublicReleaseMetadata {
  payload: ArtifactPayload;
}

export interface UserSubmissionBundle extends UserSubmissionSummary {
  payload: ArtifactPayload;
}

export interface SubmissionStore {
  createSubmission(input: CreateSubmissionInput & {
    artifact: StoredSubmission["artifact"];
    findings: ScanFinding[];
    securityStatus: SecurityStatus;
  }): Promise<StoredSubmission>;
  listUserSubmissions(userId: string): Promise<UserSubmissionSummary[]>;
  getUserSubmissionBundle(input: { userId: string; submissionId: string; platform?: string }): Promise<UserSubmissionBundle | null>;
  performSubmissionOwnerAction(input: { actorId: string; submissionId: string; action: SubmissionOwnerAction; reason?: string }): Promise<UserSubmissionSummary>;
  listReviewSubmissions(): Promise<ReviewSubmissionSummary[]>;
  approveSubmission(input: { actorId: string; submissionId: string; reason?: string }): Promise<ReviewActionResult>;
  requestChanges(input: { actorId: string; submissionId: string; reason?: string }): Promise<ReviewActionResult>;
  rejectSubmission(input: { actorId: string; submissionId: string; reason?: string }): Promise<ReviewActionResult>;
  publishSubmission(input: { actorId: string; submissionId: string; reason?: string }): Promise<ReviewActionResult>;
  getSkillManagement(input: { slug: string; actor: SubmissionActor }): Promise<SkillManagementSummary | null>;
  updateSkillMetadata(input: { slug: string; actor: SubmissionActor; update: SkillMetadataUpdate; reason?: string }): Promise<SkillManagementSummary>;
  performSkillAction(input: { slug: string; actor: SubmissionActor; action: SkillLifecycleAction; reason?: string }): Promise<SkillManagementSummary>;
  listSkillReleases(input: { slug: string; actor?: SubmissionActor | null }): Promise<SkillReleaseSummary[]>;
  performReleaseAction(input: { slug: string; version: string; actor: SubmissionActor; action: ReleaseLifecycleAction; reason?: string; replacement?: string }): Promise<SkillReleaseSummary>;
  recordReviewDenied(input: {
    actorId: string;
    action: string;
    submissionId?: string;
    reason: string;
  }): Promise<void>;
  getPublicRelease(input: { slug: string; version: string; actorId?: string | null }): Promise<PublicReleaseMetadata | null>;
  getPublicBundle(input: { slug: string; version: string; platform?: string; actorId?: string | null }): Promise<PublicBundle | null>;
  recordArtifactAccess(input: {
    actorId?: string | null;
    slug: string;
    version: string;
    platform?: string;
    decision: "allow" | "deny";
    reason?: string;
  }): Promise<void>;
  recordDenied(input: {
    actorId: string;
    slug: string;
    version: string;
    reason: string;
    findingCount: number;
  }): Promise<void>;
}
