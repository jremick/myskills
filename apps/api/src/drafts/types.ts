import type { SkillReleaseMetadata } from "@myskills-app/core";
import type { PackageInputFile, ScanFinding, SkillManifest } from "@myskills-app/skill-package";
import type { SubmissionImportBinding } from "../submissions/types.js";
import type { DatabaseTransaction } from "../db/client.js";

export interface DraftSubmissionReceipt {
  id: string;
  slug: string;
  version: string;
  artifactSha256: string;
}
export type DraftSourceRequest = { kind: "release"; slug: string; version: string; platform?: string }
  | { kind: "submission"; submissionId: string };
export type DraftSource = ({ kind: "release"; slug: string; version: string; platform?: string }
  | { kind: "submission"; submissionId: string; slug: string; version: string }) & { artifactSha256: string };
export interface Draft {
  id: string;
  title: string;
  revision: number;
  files: PackageInputFile[];
  source: DraftSource | null;
  createdAt: string;
  updatedAt: string;
  submission: DraftSubmissionReceipt | null;
}
export type DraftSummary = Omit<Draft, "files"> & { fileCount: number; textBytes: number };
export interface DraftValidation {
  valid: boolean;
  manifest: SkillManifest | null;
  issues: Array<{ code: string; message: string; path?: string }>;
  findings: ScanFinding[];
}
export interface DraftPreview {
  files: PackageInputFile[];
  validation: DraftValidation;
  fileCount: number;
  textBytes: number;
}
export type DraftCreateInput = { title: string; files: PackageInputFile[]; source?: never }
  | { title?: string; source: DraftSourceRequest; files?: never };
export interface DraftSaveInput { expectedRevision: number; title: string; files: PackageInputFile[] }
export interface DraftSubmitInput { expectedRevision: number; release?: SkillReleaseMetadata }
export interface DraftStore {
  list(ownerId: string): Promise<DraftSummary[]>;
  get(ownerId: string, draftId: string, revision?: number): Promise<Draft | null>;
  history(ownerId: string, draftId: string): Promise<DraftSummary[] | null>;
  create(input: { ownerId: string; title: string; files: PackageInputFile[]; source: DraftSource | null; authorizeSource?: (tx: DatabaseTransaction) => Promise<void> }): Promise<Draft>;
  save(input: DraftSaveInput & { ownerId: string; draftId: string }): Promise<Draft>;
  submissionBinding(input: { ownerId: string; draftId: string; expectedRevision: number; digest: string; slug: string; version: string }): SubmissionImportBinding;
  authorizeSource(tx: DatabaseTransaction, ownerId: string, source: DraftSource): Promise<void>;
}
