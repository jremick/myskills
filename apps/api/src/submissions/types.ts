import type { Role } from "@ai-skills-share/auth";
import type { SkillManifest, PackageInputFile, ScanFinding } from "@ai-skills-share/skill-package";
import type {
  ReviewStatus,
  SecurityStatus,
  SkillLifecycleStatus,
  SkillPlatformVariant,
  VisibilityScope,
} from "@ai-skills-share/core";

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
  skillSlug: string;
  title: string;
  summary: string;
  version: string;
  visibility: VisibilityScope;
  platforms: SkillPlatformVariant[];
  reviewStatus: ReviewStatus;
  securityStatus: SecurityStatus;
  publishedAt: string | null;
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

export type ReviewAction = "approve" | "publish";

export interface ReviewSubmissionSummary {
  id: string;
  slug: string;
  title: string;
  version: string;
  visibility: VisibilityScope;
  reviewStatus: ReviewStatus;
  securityStatus: SecurityStatus;
  platforms: SkillPlatformVariant[];
  findingCount: number;
  createdAt: string;
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

export interface PublicReleaseMetadata {
  slug: string;
  title: string;
  summary: string;
  version: string;
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

export interface PublicBundle extends PublicReleaseMetadata {
  payload: ArtifactPayload;
}

export interface SubmissionStore {
  createSubmission(input: CreateSubmissionInput & {
    artifact: StoredSubmission["artifact"];
    findings: ScanFinding[];
    securityStatus: SecurityStatus;
  }): Promise<StoredSubmission>;
  listReviewSubmissions(): Promise<ReviewSubmissionSummary[]>;
  approveSubmission(input: { actorId: string; submissionId: string; reason?: string }): Promise<ReviewActionResult>;
  publishSubmission(input: { actorId: string; submissionId: string; reason?: string }): Promise<ReviewActionResult>;
  recordReviewDenied(input: {
    actorId: string;
    action: string;
    submissionId?: string;
    reason: string;
  }): Promise<void>;
  getPublicRelease(input: { slug: string; version: string }): Promise<PublicReleaseMetadata | null>;
  getPublicBundle(input: { slug: string; version: string; platform?: string }): Promise<PublicBundle | null>;
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
