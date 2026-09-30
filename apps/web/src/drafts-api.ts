import { requestJson, type SubmissionScanFinding } from "./api.js";

export interface DraftFile { path: string; content: string }
export type DraftSourceInput = { kind: "release"; slug: string; version: string; platform?: string } | { kind: "submission"; submissionId: string };
export type DraftSource = (DraftSourceInput & { slug: string; version: string; artifactSha256: string }) | null;
export interface DraftReceipt { id: string; slug: string; version: string; artifactSha256: string }
export interface AuthorDraft {
  id: string; title: string; revision: number; files: DraftFile[]; source: DraftSource;
  createdAt: string; updatedAt: string; submission: DraftReceipt | null;
}
export interface DraftSummary extends Omit<AuthorDraft, "files"> { fileCount: number; textBytes: number }
export interface DraftValidation {
  valid: boolean; manifest: Record<string, unknown> | null;
  issues: Array<{ code: string; message: string; path?: string }>;
  findings: SubmissionScanFinding[];
}
export interface DraftPreview { files: DraftFile[]; validation: DraftValidation; fileCount: number; textBytes: number }
export interface DraftSubmission extends DraftReceipt {
  reviewStatus: string; securityStatus: string;
  scan: { status: string; findings: SubmissionScanFinding[]; findingCount: number };
}
export interface DraftReleaseInput {
  releaseNotes?: string; changeKind?: "fix" | "feature" | "breaking" | "security" | "maintenance"; requiresUserAction?: boolean;
}

export function createDraftClient(root: string, fetchImpl: typeof fetch, token?: string) {
  const get = <T>(path: string) => requestJson<T>(fetchImpl, `${root}/v1/drafts${path}`, { token });
  const send = <T>(path: string, method: "POST" | "PUT", body: unknown) => requestJson<T>(fetchImpl, `${root}/v1/drafts${path}`, { method, body, token });
  const id = encodeURIComponent;
  return {
    registryIdentity: new URL(root, window.location.origin).href.replace(/\/$/, ""),
    list: () => get<{ drafts: DraftSummary[] }>(""),
    create: (input: { title: string; files: DraftFile[] } | { title?: string; source: DraftSourceInput }) => send<{ draft: AuthorDraft }>("", "POST", input),
    get: (draftId: string) => get<{ draft: AuthorDraft }>(`/${id(draftId)}`),
    update: (draftId: string, input: { expectedRevision: number; title: string; files: DraftFile[] }) => send<{ draft: AuthorDraft }>(`/${id(draftId)}`, "PUT", input),
    history: (draftId: string) => get<{ revisions: DraftSummary[] }>(`/${id(draftId)}/history`),
    revision: (draftId: string, revision: number) => get<{ draft: AuthorDraft }>(`/${id(draftId)}/revisions/${revision}`),
    validate: (draftId: string, expectedRevision: number) => send<{ validation: DraftValidation }>(`/${id(draftId)}/validate`, "POST", { expectedRevision }),
    preview: (input: { files: DraftFile[] } | { archive: { filename?: string; contentBase64: string } }) => send<{ preview: DraftPreview }>("/preview", "POST", input),
    submit: (draftId: string, expectedRevision: number, release?: DraftReleaseInput) => send<{ draft: AuthorDraft; submission: DraftSubmission }>(`/${id(draftId)}/submit`, "POST", { expectedRevision, ...(release ? { release } : {}) }),
  };
}
export type DraftClient = Omit<ReturnType<typeof createDraftClient>, "registryIdentity"> & { registryIdentity?: string };
