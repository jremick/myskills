import type { Role } from "@ai-skills-share/auth";
import type { SkillManifest, PackageInputFile, ScanFinding } from "@ai-skills-share/skill-package";
import type { ReviewStatus, SecurityStatus } from "@ai-skills-share/core";

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
  version: string;
  reviewStatus: ReviewStatus;
  securityStatus: SecurityStatus;
  artifact: {
    storageKey: string;
    sha256: string;
    byteSize: number;
    contentType: string;
  };
  scan: {
    status: "succeeded";
    findings: ScanFinding[];
  };
}

export interface SubmissionStore {
  createSubmission(input: CreateSubmissionInput & {
    artifact: StoredSubmission["artifact"];
    findings: ScanFinding[];
    securityStatus: SecurityStatus;
  }): Promise<StoredSubmission>;
  recordDenied(input: {
    actorId: string;
    slug: string;
    version: string;
    reason: string;
    findingCount: number;
  }): Promise<void>;
}
