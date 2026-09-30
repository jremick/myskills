import { AppError } from "@myskills-app/core";
import {
  hasBlockingFindings, loadSkillManifestFromPackageFiles, PackageManifestFileError,
  scanPackageFiles, validatePackageFiles,
  type PackageInputFile,
} from "@myskills-app/skill-package";
import { canonicalArtifactPayload, type SubmissionService } from "../submissions/service.js";
import { assertArtifactBodyMatchesMetadata } from "../artifacts/package-payload.js";
import { artifactPayloadSha256 } from "../submissions/artifact-hash.js";
import type { SubmissionActor, StoredSubmission, UserSubmissionDetail } from "../submissions/types.js";
import { revisionConflict, sourceUnavailable } from "./postgres-store.js";
import type {
  Draft, DraftCreateInput, DraftPreview, DraftSaveInput, DraftSource, DraftStore, DraftSubmitInput, DraftValidation,
} from "./types.js";

export class DraftService {
  constructor(private readonly store: DraftStore, private readonly submissions: SubmissionService) {}

  list(actor: SubmissionActor) { return this.store.list(actor.id); }

  async get(actor: SubmissionActor, draftId: string, revision?: number): Promise<Draft> {
    const draft = await this.store.get(actor.id, draftId, revision);
    if (!draft) throw new AppError("Draft not found.", "DRAFT_NOT_FOUND", 404);
    return draft;
  }

  async history(actor: SubmissionActor, draftId: string) {
    const revisions = await this.store.history(actor.id, draftId);
    if (!revisions) throw new AppError("Draft not found.", "DRAFT_NOT_FOUND", 404);
    return revisions;
  }

  async create(actor: SubmissionActor, input: DraftCreateInput): Promise<Draft> {
    requireAuthor(actor);
    let title: string;
    let files: PackageInputFile[];
    let source: DraftSource | null = null;
    if (input.source) {
      if (input.source.kind === "release") {
        const bundle = await this.submissions.getPublicBundle({ ...input.source, actorId: actor.id });
        if (!bundle) throw sourceUnavailable();
        assertArtifactBodyMatchesMetadata(JSON.stringify(bundle.payload), bundle.artifact);
        files = bundle.payload.files;
        title = input.title ?? bundle.title;
        source = { ...input.source, artifactSha256: bundle.artifact.sha256 };
      } else {
        const bundle = await this.submissions.getUserSubmissionBundle({ actor, submissionId: input.source.submissionId });
        // A team-owned correction stays in the Library import workflow.
        if (!bundle || (bundle.owner && bundle.owner.type !== "user")) throw sourceUnavailable();
        assertArtifactBodyMatchesMetadata(JSON.stringify(bundle.payload), bundle.artifact);
        files = bundle.payload.files;
        title = input.title ?? bundle.title;
        source = { ...input.source, slug: bundle.slug, version: bundle.version, artifactSha256: bundle.artifact.sha256 };
      }
    } else {
      files = input.files;
      title = input.title;
    }
    assertTitle(title);
    assertFiles(files);
    const heldSource = source;
    return this.store.create({
      actor, ownerId: actor.id, title, files, source,
      ...(heldSource ? { authorizeSource: (tx) => this.store.authorizeSource(tx, actor.id, heldSource) } : {}),
    });
  }

  async save(actor: SubmissionActor, draftId: string, input: DraftSaveInput) {
    requireAuthor(actor);
    assertRevision(input.expectedRevision);
    assertTitle(input.title);
    assertFiles(input.files);
    return this.store.save({ ...input, actor, ownerId: actor.id, draftId });
  }

  preview(actor: SubmissionActor, files: PackageInputFile[]): DraftPreview {
    requireAuthor(actor);
    const counts = assertFiles(files);
    return { files, validation: validate(files), fileCount: counts.filesScanned, textBytes: counts.bytesScanned };
  }

  async validate(actor: SubmissionActor, draftId: string, expectedRevision: number) {
    requireAuthor(actor);
    const draft = await this.current(actor, draftId, expectedRevision);
    return validate(draft.files);
  }

  async submit(actor: SubmissionActor, draftId: string, input: DraftSubmitInput) {
    requireAuthor(actor);
    const draft = await this.current(actor, draftId, input.expectedRevision);
    if (draft.submission) return this.replay(actor, draft);
    let manifest;
    try { manifest = loadSkillManifestFromPackageFiles(draft.files); }
    catch (error) { throw manifestError(error); }
    try {
      const submission = await this.submissions.createSubmission({
        actor, files: draft.files, manifest, release: input.release,
        importBinding: this.store.submissionBinding({
          actor, ownerId: actor.id, draftId, expectedRevision: input.expectedRevision,
          digest: artifactPayloadSha256(canonicalArtifactPayload(draft.files)), slug: manifest.name, version: manifest.version,
        }),
      });
      const saved = await this.get(actor, draftId, input.expectedRevision);
      return { draft: saved, submission: submissionDto(submission), replayed: false };
    } catch (error) {
      // The slug lock serializes concurrent submissions. The second callback
      // sees the committed receipt and rolls back its transaction before replay.
      if (error instanceof AppError && error.code === "DRAFT_ALREADY_SUBMITTED") {
        const completed = await this.get(actor, draftId, input.expectedRevision);
        if (completed.submission) return this.replay(actor, completed);
      }
      throw error;
    }
  }

  private async current(actor: SubmissionActor, draftId: string, expectedRevision: number) {
    assertRevision(expectedRevision);
    const draft = await this.get(actor, draftId);
    if (draft.revision !== expectedRevision) throw revisionConflict();
    return draft;
  }

  private async replay(actor: SubmissionActor, draft: Draft) {
    const receipt = draft.submission!;
    const submission = await this.submissions.getUserSubmissionDetail({ actor, submissionId: receipt.id });
    if (!submission || submission.artifact.sha256 !== receipt.artifactSha256) {
      throw new AppError("The submitted revision receipt is unavailable.", "DRAFT_SUBMISSION_UNAVAILABLE", 503);
    }
    return { draft, submission: submissionDto(submission), replayed: true };
  }
}

function validate(files: PackageInputFile[]): DraftValidation {
  const issues: DraftValidation["issues"] = [];
  let manifest: DraftValidation["manifest"] = null;
  try { manifest = loadSkillManifestFromPackageFiles(files); }
  catch (error) {
    const invalid = manifestError(error);
    issues.push({ code: invalid.code, message: invalid.message });
  }
  let findings: DraftValidation["findings"] = [];
  try { findings = scanPackageFiles(files).findings; }
  catch { issues.push({ code: "INVALID_PACKAGE_PAYLOAD", message: "The package could not be scanned." }); }
  return { valid: issues.length === 0 && !hasBlockingFindings(findings), manifest, issues, findings };
}
function submissionDto(submission: StoredSubmission | UserSubmissionDetail) {
  const scan = "scan" in submission ? submission.scan : [...submission.scanRuns].filter(run => !run.artifactSha256 || run.artifactSha256 === submission.artifact.sha256).sort((a, b) => (b.attempt ?? 0) - (a.attempt ?? 0) || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
  const findings = scan?.findings ?? [];
  return {
    id: submission.id, slug: "skillSlug" in submission ? submission.skillSlug : submission.slug,
    version: submission.version, artifactSha256: submission.artifact.sha256,
    lifecycleStatus: submission.lifecycleStatus, reviewStatus: submission.reviewStatus, securityStatus: submission.securityStatus,
    scan: { status: scan?.status ?? "queued", findings, findingCount: findings.length },
  };
}
function manifestError(error: unknown) {
  return error instanceof PackageManifestFileError
    ? new AppError(error.message, error.code, 400)
    : new AppError("The package manifest is invalid.", "INVALID_PACKAGE_MANIFEST", 400);
}
export function assertFiles(files: PackageInputFile[]) {
  try {
    const counts = validatePackageFiles(files);
    if (files.some((file) => Buffer.from(file.path, "utf8").toString("utf8") !== file.path)) throw new Error("Package paths must be valid UTF-8 text.");
    return counts;
  }
  catch (error) {
    throw new AppError(error instanceof Error ? error.message : "Invalid package files.", "INVALID_PACKAGE_PAYLOAD", 400);
  }
}
export function assertTitle(title: string) {
  if (typeof title !== "string" || title.length > 240 || title.trim().length === 0 || [...title].length > 120 || title.includes("\0")
    || Buffer.from(title, "utf8").toString("utf8") !== title) {
    throw new AppError("Draft title must contain 1 to 120 characters.", "INVALID_DRAFT_INPUT", 400);
  }
}
export function assertRevision(revision: number) {
  if (!Number.isSafeInteger(revision) || revision <= 0) throw new AppError("Expected revision must be a positive safe integer.", "INVALID_DRAFT_INPUT", 400);
}
function requireAuthor(actor: SubmissionActor) {
  if (!actor.roles.some((role) => role === "author" || role === "maintainer" || role === "admin" || role === "owner")) {
    throw new AppError("Submission requires author permissions.", "SUBMISSION_ROLE_REQUIRED", 403);
  }
  if (actor.roles.some((role) => role === "maintainer" || role === "admin" || role === "owner") && !actor.mfaVerified) {
    throw new AppError("MFA verification is required.", "MFA_VERIFICATION_REQUIRED", 403);
  }
}
