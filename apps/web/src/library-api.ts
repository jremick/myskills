import type { LibrarySummary, LibraryEntry, LibraryCandidate, LibraryAdoption, LibraryBinding, LibraryInboxItem, LibraryAdminSettings, LibraryEventKind, LibraryImportReleaseInput, LibrarySourceRefKind, LibraryTrackingMode, SourceDiscovery, SourceCheckResult } from "@myskills-app/core";
import { requestJson, requestJsonWithHeaders } from "./api.js";

export interface LibraryPage<T> { nextCursor: string | null; items: T[] }
export interface LibraryPreview { id: string; candidates: LibraryCandidate[]; expiresAt: string }
export interface LibrarySettingsResponse { settings: LibraryAdminSettings; worker?: { configured: boolean; overdueTrackCount: number; oldestOverdueCheckAt: string | null } }
export interface SelfReviewedRelease { submissionId: string; slug: string; version: string; artifactSha256: string; selfReviewedAt: string; elevationRequestedAt: string }
const id = encodeURIComponent;

export function createLibraryClient(root: string, fetchImpl: typeof fetch, token?: string) {
  const get = <T>(path: string) => requestJson<T>(fetchImpl, `${root}/v1${path}`, { token });
  const send = <T>(path: string, method: "POST" | "PUT" | "PATCH" | "DELETE", body?: unknown) => requestJson<T>(fetchImpl, `${root}/v1${path}`, { token, method, ...(body === undefined ? {} : { body }) });
  const inspectedBundle = async (path: string, expectedDigest: string, requireHeader: boolean) => {
    const result = await requestJsonWithHeaders<{ files: Array<{ path: string; content: string }> }>(fetchImpl, `${root}/v1${path}`, { token });
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(result.rawText));
    const digest = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const header = result.headers.get("x-myskills-artifact-sha256");
    if (digest !== expectedDigest || ((requireHeader || header !== null) && header !== expectedDigest)) throw new Error("Artifact identity does not match this review request.");
    if (!Array.isArray(result.body.files) || result.body.files.length === 0 || result.body.files.length > 500 || result.body.files.some((file) => typeof file.path !== "string" || file.path.length > 1_024 || typeof file.content !== "string")) throw new Error("Artifact cannot be inspected.");
    return result.body;
  };
  return {
    list: (cursor?: string) => get<{ libraries: LibrarySummary[]; nextCursor: string | null }>(`/libraries?limit=50${cursor ? `&cursor=${id(cursor)}` : ""}`),
    get: (libraryId: string) => get<{ library: LibrarySummary }>(`/libraries/${id(libraryId)}`),
    create: (input: { name: string; description?: string; owner: { type: "user" } | { type: "team"; id: string }; clientMutationId: string }) => send<{ library: LibrarySummary }>("/libraries", "POST", input),
    update: (libraryId: string, input: { name: string; description: string; expectedRevision: number }) => send<{ library: LibrarySummary }>(`/libraries/${id(libraryId)}`, "PATCH", input),
    remove: (libraryId: string, revision: number) => send(`/libraries/${id(libraryId)}?expectedRevision=${revision}`, "DELETE"),
    entries: (libraryId: string, cursor?: string) => get<{ entries: LibraryEntry[]; nextCursor: string | null }>(`/libraries/${id(libraryId)}/entries?limit=50${cursor ? `&cursor=${id(cursor)}` : ""}`),
    entry: (entryId: string) => get<{ entry: LibraryEntry }>(`/library-entries/${id(entryId)}`),
    addSource: (libraryId: string, input: { url: string; path?: string; ref?: { kind: LibrarySourceRefKind; value?: string }; clientMutationId: string }) => send<{ entry: LibraryEntry }>(`/libraries/${id(libraryId)}/entries`, "POST", { kind: "source", ...input }),
    addSkill: (libraryId: string, slug: string, clientMutationId: string) => send<{ entry: LibraryEntry }>(`/libraries/${id(libraryId)}/entries`, "POST", { kind: "skill", slug, clientMutationId }),
    removeEntry: (entryId: string) => send(`/library-entries/${id(entryId)}`, "DELETE"),
    discover: (entryId: string) => send<{ discovery: SourceDiscovery }>(`/library-entries/${id(entryId)}/discoveries`, "POST"),
    preview: (entryId: string, input: { snapshotId: string; paths: string[]; mappings?: Record<string, { summary?: string; title?: string; license?: string }> }) => send<{ preview: LibraryPreview }>(`/library-entries/${id(entryId)}/previews`, "POST", input),
    candidates: (entryId: string, cursor?: string) => get<{ candidates: LibraryCandidate[]; nextCursor: string | null }>(`/library-entries/${id(entryId)}/candidates?limit=50${cursor ? `&cursor=${id(cursor)}` : ""}`),
    candidate: (candidateId: string) => get<{ candidate: LibraryCandidate }>(`/library-candidates/${id(candidateId)}?includeContent=true`),
    import: (candidateId: string, input: { expectedPackageDigest: string; release: LibraryImportReleaseInput; clientMutationId: string; acknowledgeUnverifiedOrder?: { reason: string } }) => send<{ candidate: LibraryCandidate; entry: LibraryEntry }>(`/library-candidates/${id(candidateId)}/import`, "POST", input),
    selfReview: (candidateId: string, artifactSha256: string) => send<{ candidate: LibraryCandidate }>(`/library-candidates/${id(candidateId)}/self-review`, "POST", { artifactSha256 }),
    requestReview: (candidateId: string) => send(`/library-candidates/${id(candidateId)}/instance-review-requests`, "POST"),
    ignore: (candidateId: string) => send<{ candidate: LibraryCandidate }>(`/library-candidates/${id(candidateId)}/ignore`, "POST"),
    adopt: (entryId: string, input: { version: string; artifactSha256: string; expectedCurrentAdoptionId: string | null; reason?: string }) => send<{ adoption: LibraryAdoption; entry: LibraryEntry }>(`/library-entries/${id(entryId)}/adoptions`, "POST", input),
    adoptions: (entryId: string) => get<{ adoptions: LibraryAdoption[] }>(`/library-entries/${id(entryId)}/adoptions`),
    tracking: (entryId: string, input: { expectedRevision: number; mode: LibraryTrackingMode; acknowledgeIdentityChange?: boolean }) => send<{ entry: LibraryEntry }>(`/library-entries/${id(entryId)}/tracking`, "PATCH", input),
    check: (entryId: string) => send<{ check: SourceCheckResult }>(`/library-entries/${id(entryId)}/checks`, "POST"),
    subscribe: (libraryId: string, events?: LibraryEventKind[]) => send(`/libraries/${id(libraryId)}/subscription`, "PUT", events ? { events } : {}),
    unsubscribe: (libraryId: string) => send(`/libraries/${id(libraryId)}/subscription`, "DELETE"),
    inbox: (cursor?: string) => get<{ items: LibraryInboxItem[]; unreadCount: number; nextCursor: string | null }>(`/library-inbox?limit=50${cursor ? `&cursor=${id(cursor)}` : ""}`),
    markRead: (eventIds: string[]) => send("/library-inbox/read", "POST", { eventIds }),
    bindings: (entryId: string) => get<{ bindings: LibraryBinding[] }>(`/library-entries/${id(entryId)}/bindings`),
    bind: (entryId: string, targetId: string, replaceConflicting = false) => send(`/library-entries/${id(entryId)}/bindings`, "POST", { targetId, replaceConflicting }),
    detach: (bindingId: string) => send(`/library-bindings/${id(bindingId)}`, "DELETE"),
    settings: () => get<LibrarySettingsResponse>("/admin/library-settings"),
    setSettings: (privateSelfReviewEnabled: boolean) => send<LibrarySettingsResponse>("/admin/library-settings", "PUT", { privateSelfReviewEnabled }),
    reviewRequests: () => get<{ releases: SelfReviewedRelease[] }>("/review/self-reviewed-releases"),
    submittedBundle: (submissionId: string, expectedDigest: string) => inspectedBundle(`/submissions/${id(submissionId)}/bundle`, expectedDigest, false),
    reviewBundle: (submissionId: string, expectedDigest: string) => inspectedBundle(`/review/self-reviewed-releases/${id(submissionId)}/bundle`, expectedDigest, true),
    elevate: (submissionId: string, artifactSha256: string) => send(`/review/self-reviewed-releases/${id(submissionId)}/elevate`, "POST", { artifactSha256 }),
  };
}
export type LibraryClient = ReturnType<typeof createLibraryClient>;

export function libraryError(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  const messages: Record<string, string> = {
    PRIVATE_SELF_REVIEW_DISABLED: "Private self-review is disabled. Ask an instance reviewer to review this import.",
    PRIVATE_SELF_REVIEW_SCOPE_INVALID: "Private self-review requires your own private import with no sharing grants.",
    PRIVATE_SELF_REVIEW_SCAN_NOT_CLEAN: "This import needs an instance reviewer because its scan is not clean.",
    RELEASE_DECLARATION_NOT_APPROVED: "The latest optimisation declaration needs reviewer approval for this exact artifact before private self-review.",
    SELF_REVIEWED_RELEASE_REQUIRES_INSTANCE_REVIEW: "Request instance review before sharing this privately reviewed release.",
    MFA_VERIFICATION_REQUIRED: "Verify MFA in your account before continuing.",
    SUBMISSION_ROLE_REQUIRED: "An author role is required to submit this import.",
    LIBRARY_REVISION_CONFLICT: "This library changed. Refresh before retrying.",
    LIBRARY_ADOPTION_CONFLICT: "The adopted version changed. Refresh and review it before retrying.",
    PREVIEW_EXPIRED: "This preview expired. Discover the source and preview it again.",
    CANDIDATE_SUPERSEDED: "A newer source preview replaced this candidate. Refresh the source.",
    CANDIDATE_ORDER_UNVERIFIED: "Source order needs review. Provide a reason before accepting this revision.",
    SOURCE_URL_UNSUPPORTED: "Use a public github.com repository, directory, or SKILL.md URL.",
    SOURCE_RATE_LIMITED: "GitHub rate limited this check. The saved source will be retried later.",
    SOURCE_CHECK_IN_PROGRESS: "A check is already running for this source.",
    SOURCE_IDENTITY_CHANGED: "The repository identity changed. Review the source before resuming tracking.",
    SOURCE_UNAVAILABLE: "The public GitHub source is unavailable.",
    SOURCE_PROVIDER_UNAVAILABLE: "GitHub is unavailable. Your saved library is unchanged.",
    LIBRARY_ENTRY_DUPLICATE: "This source or skill is already saved in the library.",
    CLIENT_MUTATION_ID_CONFLICT: "This retry differs from the original request. Restore the original values or start a new action.",
    LIBRARY_RELEASE_NOT_ADOPTABLE: "Choose a published, approved release with the matching artifact.",
    LIBRARY_RELEASE_NOT_AUTHORIZED: "This release is not authorized for this library.",
    BINDING_VERSION_CONFLICT: "This target already follows a different library version. Resolve the existing binding first.",
    LIBRARY_NOT_FOUND: "This library is unavailable or you no longer have access.",
    LIBRARY_ENTRY_NOT_FOUND: "This entry is unavailable or you no longer have access.",
    LIBRARY_SERVICE_UNAVAILABLE: "Libraries are not available on this server.",
    LIBRARY_WRITE_FORBIDDEN: "Only the library owner or a team curator can change this library.",
    API_TOKEN_SCOPE_REQUIRED: "This token needs the appropriate library and skill scopes.",
    SESSION_AUTH_REQUIRED: "Sign in with an MFA-verified session to manage target bindings or administrator settings.",
    LIBRARY_PREVIEW_SELECTION_INVALID: "Choose valid skill roots and review their metadata mapping before previewing.",
    SOURCE_REF_INVALID: "The selected source ref is invalid or unavailable. Check its name and type.",
    INVALID_PAGE_CURSOR: "This page is no longer available. Refresh the list.",
    SUBMISSION_NOT_REVIEWABLE: "This submission is no longer awaiting review. Refresh its current state.",
    ARTIFACT_HASH_MISMATCH: "The artifact changed. Inspect its current files before trying again.",
    CANDIDATE_NOT_IMPORTABLE: "This candidate cannot be imported. Check its findings or create a new preview.",
    LIBRARY_LIMIT_EXCEEDED: "This library reached an instance limit. Remove unused entries or select fewer skills.",
  };
  return messages[code] ?? "The library action could not be completed. Refresh and try again.";
}
