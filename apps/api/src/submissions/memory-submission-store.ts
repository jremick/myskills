import { AppError } from "@ai-skills-share/core";
import type { CreateSubmissionInput, StoredSubmission, SubmissionStore } from "./types.js";

export class MemorySubmissionStore implements SubmissionStore {
  private submissions = new Map<string, StoredSubmission>();
  private denied = 0;

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
      version: input.manifest.version,
      reviewStatus: "unreviewed",
      securityStatus: input.securityStatus,
      artifact: input.artifact,
      scan: {
        status: "succeeded",
        findings: input.findings,
      },
    };
    this.submissions.set(key, submission);
    return submission;
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
}
