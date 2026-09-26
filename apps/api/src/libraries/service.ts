import { createHash, randomBytes, randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { Role } from "@myskills-app/auth";
import {
  AppError,
  allocateImportedSkillSlug,
  compareSemanticVersions,
  importRevisionVersion,
  isDefaultExcludedSourcePath,
  LIBRARY_LIMITS,
  libraryEventKinds,
  libraryImportReleaseMetadata,
  parseGithubSourceUrl,
  parseSemanticVersion,
  type LibraryAdoption,
  type LibraryBinding,
  type LibraryCandidate,
  type LibraryEntry,
  type LibraryEntryResolution,
  type LibraryEventKind,
  type LibraryInboxItem,
  type LibrarySourceHealth,
  type LibrarySourceRef,
  type LibrarySourceRefKind,
  type LibrarySummary,
  type LibraryTrackingMode,
  type LibraryUpdateItemLibraryState,
  type SkillRepository,
  type SourceCheckResult,
  type SourceDiscovery,
  type SourceSnapshotSummary,
} from "@myskills-app/core";
import { MAX_PACKAGE_FILES, MAX_PACKAGE_TEXT_BYTES, parseSkillManifest } from "@myskills-app/skill-package";
import type { SubmissionService } from "../submissions/service.js";
import type { ArchitectureTargetService } from "../targets/service.js";
import type { GithubRepositoryInfo, ResolvedSourceRef, SourceRequestContext, UpstreamSourceProvider } from "./github-source.js";
import {
  buildCandidatePackage,
  computeChanges,
  computeSourceDigest,
  discoverSkillRoots,
  importProfileDigest,
  inventoryDigest,
  listSkillRootPaths,
  packageDigestFor,
  rootFileSignature,
  suggestedImportRelease,
  type MappingOverrides,
} from "./packaging.js";
import {
  CHECK_LEASE_LOST,
  candidateEvent,
  leaseLostError,
  type AdoptionRecord,
  type BindingRecord,
  type CandidateNotification,
  type CandidateRecord,
  type EntryRecord,
  type LibraryEventInput,
  type LibraryRecord,
  type LineageRecord,
  type PageCursor,
  type PostgresLibraryStore,
  type SnapshotRecord,
  type SourceRecord,
} from "./postgres-store.js";

export interface LibraryActor {
  id: string;
  roles: Role[];
  mfaVerified: boolean;
}

export interface LibraryServiceOptions {
  store: PostgresLibraryStore;
  submissions: SubmissionService;
  skillRepository: SkillRepository;
  sourceProvider: UpstreamSourceProvider;
  targets?: ArchitectureTargetService;
  now?: () => Date;
  /** Test hook for repeatable slugs. Must return 10 lowercase alphanumeric characters. */
  slugSuffix?: (seed: string) => string;
}

/** Exact-version constraint a library binding adds to connected-target Updates. */
export interface LibraryTargetConstraint extends LibraryUpdateItemLibraryState {
  pins: string[];
}

export interface LibraryAdoptionConstraintSource {
  resolveTargetConstraints(input: { actorId: string; targetId: string; slug: string; installedVersion?: string }): Promise<LibraryTargetConstraint | null>;
}

interface LibraryAccess {
  role: "owner" | "curator" | "member";
  canWrite: boolean;
  personal: boolean;
}

/**
 * A running check's lease. `renew` extends it before each write phase so provider I/O cannot outlive it
 * unnoticed. Renewal alone does not fence: each check-owned write also passes `leaseId`, which the store
 * validates under the entry row lock in the write's own transaction.
 */
interface CheckLease {
  leaseId: string;
  renew: () => Promise<void>;
}

/** Covers one check (provider deadline 60 s) plus its writes; each check renews it before writing. */
const CHECK_LEASE_MS = 120_000;
const PREVIEW_TTL_MS = LIBRARY_LIMITS.previewTtlHours * 3_600_000;
const TRACKING_TTL_MS = LIBRARY_LIMITS.trackingCandidateTtlDays * 86_400_000;
const INBOX_WINDOW = 200;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

export class LibraryService implements LibraryAdoptionConstraintSource {
  private readonly store: PostgresLibraryStore;
  private readonly submissions: SubmissionService;
  private readonly skills: SkillRepository;
  private readonly provider: UpstreamSourceProvider;
  private readonly targets?: ArchitectureTargetService;
  private readonly clock: () => Date;
  private readonly slugSuffix: (seed: string) => string;
  private workerRunning = false;

  constructor(options: LibraryServiceOptions) {
    this.store = options.store;
    this.submissions = options.submissions;
    this.skills = options.skillRepository;
    this.provider = options.sourceProvider;
    this.targets = options.targets;
    this.clock = options.now ?? (() => new Date());
    this.slugSuffix = options.slugSuffix ?? (() => [...randomBytes(10)].map((byte) => BASE32[byte & 31]).join(""));
  }

  setWorkerRunning(running: boolean): void {
    this.workerRunning = running;
  }

  isWorkerRunning(): boolean {
    return this.workerRunning;
  }

  // ---- Admin settings -----------------------------------------------------

  async getAdminSettings(actor: LibraryActor) {
    requireAdmin(actor);
    return {
      settings: await this.store.getSettings(),
      worker: { configured: this.workerRunning, ...await this.store.workerStats(this.clock()) },
    };
  }

  async updateAdminSettings(actor: LibraryActor, input: { privateSelfReviewEnabled: boolean; reason?: string }) {
    requireAdmin(actor);
    requireMfa(actor);
    return { settings: await this.store.updateSettings({ actorId: actor.id, ...input }) };
  }

  // ---- Libraries ----------------------------------------------------------

  async listLibraries(actor: LibraryActor, page: { limit: number; cursor: PageCursor | null }) {
    const rows = await this.store.listLibrariesForActor(actor.id, page);
    const items = rows.slice(0, page.limit);
    const libraries: LibrarySummary[] = [];
    for (const row of items) {
      const access: LibraryAccess = row.ownerUserId
        ? { role: "owner", canWrite: true, personal: true }
        : row.role === "owner" ? { role: "curator", canWrite: true, personal: false } : { role: "member", canWrite: false, personal: false };
      libraries.push(await this.toSummary(row, access, actor));
    }
    const last = items.at(-1);
    return { libraries, nextCursor: rows.length > page.limit && last ? encodeCursor({ at: last.cursorAt, id: last.id }) : null };
  }

  async createLibrary(actor: LibraryActor, input: { name: string; description: string; owner: { type: "user" } | { type: "team"; id: string }; clientMutationId: string | null }) {
    if (input.owner.type === "team") {
      const role = await this.store.teamRole(input.owner.id, actor.id);
      if (role !== "owner") throw new AppError("Team owner access is required.", "TEAM_OWNER_REQUIRED", 403);
      requireMfa(actor);
    }
    const result = await this.store.createLibrary({
      ownerUserId: input.owner.type === "user" ? actor.id : null,
      ownerTeamId: input.owner.type === "team" ? input.owner.id : null,
      name: input.name,
      description: input.description,
      actorId: actor.id,
      clientMutationId: input.clientMutationId,
      clientMutationDigest: mutationDigest({ name: input.name, description: input.description, owner: input.owner }),
      maxPerOwner: LIBRARY_LIMITS.maxLibrariesPerOwner,
    });
    const { library, access } = await this.readableLibrary(result.id, actor);
    return { library: await this.toSummary(library, access, actor), replayed: result.replayed };
  }

  async getLibrary(actor: LibraryActor, libraryId: string) {
    const { library, access } = await this.readableLibrary(libraryId, actor);
    return { library: await this.toSummary(library, access, actor) };
  }

  async updateLibrary(actor: LibraryActor, libraryId: string, input: { expectedRevision: number; name?: string; description?: string }) {
    const { access } = await this.writableLibrary(libraryId, actor);
    const library = await this.store.updateLibrary({ id: libraryId, actorId: actor.id, ...input });
    return { library: await this.toSummary(library, access, actor) };
  }

  async deleteLibrary(actor: LibraryActor, libraryId: string, expectedRevision: number) {
    await this.writableLibrary(libraryId, actor);
    const effects = await this.store.deleteLibrary({ id: libraryId, expectedRevision, actorId: actor.id });
    return { library: { id: libraryId, status: "deleted" as const }, effects };
  }

  // ---- Entries ------------------------------------------------------------

  async listEntries(actor: LibraryActor, libraryId: string, query: { kind?: "source" | "skill"; limit: number; cursor: PageCursor | null }) {
    const { access } = await this.readableLibrary(libraryId, actor);
    const rows = await this.store.listEntries(libraryId, query);
    const page = rows.slice(0, query.limit);
    const entries: LibraryEntry[] = [];
    // Unreadable entries are omitted entirely: no placeholder, no count.
    for (const row of page) {
      if (row.kind === "skill" && !await this.canReadSkillEntry(row, access, actor)) continue;
      entries.push(await this.toEntry(row, actor));
    }
    const last = page.at(-1);
    return { entries, nextCursor: rows.length > query.limit && last ? encodeCursor({ at: last.cursorAt, id: last.id }) : null };
  }

  async createEntry(actor: LibraryActor, libraryId: string, input:
    | { kind: "source"; url: string; ref?: LibrarySourceRef; path?: string; clientMutationId: string | null }
    | { kind: "skill"; slug: string; clientMutationId: string | null }) {
    // Validate the pasted URL before any provider request.
    const parsedUrl = input.kind === "source" ? parseGithubSourceUrl(input.url) : null;
    if (parsedUrl && !parsedUrl.ok) throw new AppError(parsedUrl.reason, "SOURCE_URL_UNSUPPORTED", 400);
    const { library } = await this.writableLibrary(libraryId, actor);
    if (input.kind === "source" && parsedUrl?.ok) {
      const urlRef: LibrarySourceRef = parsedUrl.value.ref ? { kind: "branch", value: parsedUrl.value.ref } : { kind: "default-branch" };
      const ref = normalizeRef(input.ref ?? urlRef);
      const path = normalizeSourcePath(input.path ?? parsedUrl.value.path);
      const repository = await this.provider.getRepositoryByName(parsedUrl.value.owner, parsedUrl.value.repo, this.requestContext());
      const source = await this.store.upsertSource(repository);
      const created = await this.store.createEntry({
        libraryId,
        kind: "source",
        title: (path ? `${repository.fullName}/${path}` : repository.fullName).slice(0, 200),
        sourceId: source.id,
        sourcePath: path,
        refKind: ref.kind,
        refValue: ref.value ?? "",
        acknowledgedFullName: repository.fullName,
        actorId: actor.id,
        clientMutationId: input.clientMutationId,
        clientMutationDigest: mutationDigest({ kind: "source", repositoryId: repository.id, ref, path }),
        maxPerLibrary: LIBRARY_LIMITS.maxEntriesPerLibrary,
      });
      return { entry: await this.toEntry(await this.requireEntryRecord(created.id), actor), replayed: created.replayed };
    }
    if (input.kind !== "skill") throw new AppError("Unsupported entry kind.", "INVALID_REQUEST_BODY", 400);
    const skill = await this.readableSkill(input.slug, actor);
    if (library.ownerTeamId && !await this.teamCanRead(input.slug, null, library.ownerTeamId)) {
      throw new AppError("The team cannot read this skill release. Share it with the team first.", "LIBRARY_RELEASE_NOT_AUTHORIZED", 422);
    }
    const created = await this.store.createEntry({
      libraryId,
      kind: "skill",
      title: skill.title.slice(0, 200) || input.slug,
      skillSlug: input.slug,
      actorId: actor.id,
      clientMutationId: input.clientMutationId,
      clientMutationDigest: mutationDigest({ kind: "skill", slug: input.slug }),
      maxPerLibrary: LIBRARY_LIMITS.maxEntriesPerLibrary,
    });
    return { entry: await this.toEntry(await this.requireEntryRecord(created.id), actor), replayed: created.replayed };
  }

  async getEntry(actor: LibraryActor, entryId: string) {
    const { entry } = await this.readableEntry(entryId, actor);
    return { entry: await this.toEntry(entry, actor) };
  }

  async removeEntry(actor: LibraryActor, entryId: string) {
    await this.writableEntry(entryId, actor);
    const effects = await this.store.removeEntry(entryId, actor.id);
    return {
      entry: { id: entryId, status: "removed" as const },
      effects: {
        bindingsMarkedCurationUnavailable: effects.bindingsMarkedCurationUnavailable,
        candidatesCancelled: effects.candidatesCancelled,
        trackingStopped: effects.trackingStopped,
      },
    };
  }

  async updateTracking(actor: LibraryActor, entryId: string, input: { expectedRevision: number; mode: LibraryTrackingMode; acknowledgeIdentityChange: boolean }) {
    const { entry } = await this.personalSourceEntry(entryId, actor);
    const now = this.clock();
    await this.store.updateTracking({
      entryId: entry.id,
      expectedRevision: input.expectedRevision,
      mode: input.mode,
      nextCheckAt: scheduledAfter(input.mode, now),
      acknowledgeIdentityChange: input.acknowledgeIdentityChange,
      actorId: actor.id,
    });
    return { entry: await this.toEntry(await this.requireEntryRecord(entry.id), actor) };
  }

  // ---- Discovery, preview, import ----------------------------------------

  async discover(actor: LibraryActor, entryId: string): Promise<{ discovery: SourceDiscovery }> {
    const { entry } = await this.personalSourceEntry(entryId, actor);
    const context = this.requestContext();
    const source = await this.requireSource(entry);
    const repository = await this.currentRepository(entry, source, context);
    const resolved = await this.provider.resolveRef(repository, entryRef(entry), context);
    const lastGood = await this.store.getSnapshot(entry.lastGoodSnapshotId);
    const snapshot = lastGood && lastGood.complete && lastGood.commitSha === resolved.commitSha
      ? lastGood
      : await this.captureSnapshot(entry, source, repository, resolved, lastGood, context, { setLastGood: lastGood === null });
    const discovered = discoverSkillRoots(snapshot.inventory, entry.sourcePath);
    const describe = async (root: ReturnType<typeof discoverSkillRoots>["skills"][number], excluded: boolean) => {
      const lineage = await this.store.findLineage({ ownerUserId: actor.id, sourceId: source.id, sourcePath: root.path, refKind: entryRef(entry).kind, refValue: entry.refValue });
      return {
        path: root.path,
        directoryName: root.directoryName,
        fileCount: root.fileCount,
        byteCount: root.byteCount,
        blockers: root.blockers,
        lineage: lineage ? { id: lineage.id, slug: lineage.slug, latestVersion: lineage.revisionCounter > 0 ? importRevisionVersion(lineage.revisionCounter) : null } : null,
        ...(excluded ? { excludedReason: "default-excluded" as const } : {}),
      };
    };
    return {
      discovery: {
        snapshot: snapshotSummary(snapshot),
        complete: snapshot.complete && discovered.complete,
        skills: await Promise.all(discovered.skills.map((root) => describe(root, false))),
        excluded: await Promise.all(discovered.excluded.map((root) => describe(root, true))),
        limits: { maxInventoryPaths: LIBRARY_LIMITS.maxInventoryPaths, maxPackageFiles: MAX_PACKAGE_FILES, maxPackageTextBytes: MAX_PACKAGE_TEXT_BYTES },
      },
    };
  }

  async preview(actor: LibraryActor, entryId: string, input: { snapshotId: string; paths: string[]; mappings: Record<string, MappingOverrides> }) {
    const { entry } = await this.personalSourceEntry(entryId, actor);
    const snapshot = await this.store.getSnapshot(input.snapshotId);
    if (!snapshot || snapshot.entryId !== entry.id) throw new AppError("Snapshot not found.", "SNAPSHOT_NOT_FOUND", 404);
    if (!snapshot.complete) throw new AppError("The snapshot inventory is incomplete; nothing can be imported from it.", "INVENTORY_INCOMPLETE", 422);
    const paths = [...new Set(input.paths.map(normalizeSourcePath))];
    if (paths.length === 0 || paths.length > LIBRARY_LIMITS.maxPreviewPaths || paths.length !== input.paths.length) {
      throw new AppError(`Select from 1 to ${LIBRARY_LIMITS.maxPreviewPaths} distinct skill paths.`, "LIBRARY_PREVIEW_SELECTION_INVALID", 400);
    }
    const unknownMapping = Object.keys(input.mappings).find((path) => !paths.includes(normalizeSourcePath(path)));
    if (unknownMapping !== undefined) throw new AppError("Mappings must name selected paths.", "LIBRARY_PREVIEW_SELECTION_INVALID", 400);
    const source = await this.requireSource(entry);
    const context = this.requestContext();
    const repository = await this.currentRepository(entry, source, context);
    const previewId = randomUUID();
    const candidates: LibraryCandidate[] = [];
    const orderCache = new Map<string, SnapshotRecord["orderStatus"]>();
    for (const path of paths) {
      const lineage = await this.reserveLineage(actor.id, entry, source, path);
      const requested = input.mappings[path] ?? {};
      const overrides: MappingOverrides = Object.keys(requested).length > 0 ? requested : lineage.mappingOverrides;
      const { candidate } = await this.buildCandidate({ origin: "preview", previewId, lineage, entry, source, repository, snapshot, overrides, context, ttlMs: PREVIEW_TTL_MS, orderCache });
      candidates.push(await this.toCandidate(candidate, source, false));
    }
    return {
      preview: {
        id: previewId,
        snapshot: snapshotSummary(snapshot),
        expiresAt: new Date(this.clock().getTime() + PREVIEW_TTL_MS).toISOString(),
        candidates,
      },
    };
  }

  async listCandidates(actor: LibraryActor, entryId: string, query: { state?: LibraryCandidate["state"]; limit: number; cursor: PageCursor | null }) {
    const { entry } = await this.personalSourceEntry(entryId, actor);
    const source = await this.requireSource(entry);
    const rows = await this.store.listCandidates(entry.id, query);
    const page = rows.slice(0, query.limit);
    const candidates = await Promise.all(page.map((row) => this.toCandidate(row, source, false)));
    const last = page.at(-1);
    return { candidates, nextCursor: rows.length > query.limit && last ? encodeCursor({ at: last.cursorAt, id: last.id }) : null };
  }

  async getCandidate(actor: LibraryActor, candidateId: string, includeContent: boolean) {
    const { candidate, source } = await this.ownedCandidate(candidateId, actor);
    return { candidate: await this.toCandidate(candidate, source, includeContent) };
  }

  async ignoreCandidate(actor: LibraryActor, candidateId: string) {
    const { candidate, source } = await this.ownedCandidate(candidateId, actor);
    if (!await this.store.transitionCandidate({ id: candidate.id, from: ["ready-for-review", "blocked"], to: "ignored", actorId: actor.id, purgeFiles: true })) {
      throw new AppError("Only a pending candidate can be ignored.", "CANDIDATE_NOT_IMPORTABLE", 409);
    }
    return { candidate: await this.toCandidate(await this.requireCandidate(candidate.id), source, false) };
  }

  async importCandidate(actor: LibraryActor, candidateId: string, input: {
    expectedPackageDigest: string;
    release: unknown;
    acknowledgeUnverifiedOrder: { reason: string } | null;
    clientMutationId: string | null;
  }) {
    const { candidate, library, source } = await this.ownedCandidate(candidateId, actor);
    const snapshot = await this.requireSnapshot(candidate.snapshotId);
    if (input.release === undefined || input.release === null) {
      throw new AppError("Import release metadata is required. Use { classification: \"unclassified\" } or a reviewed classification.", "IMPORT_RELEASE_METADATA_REQUIRED", 400);
    }
    const release = libraryImportReleaseMetadata(input.release, {
      repository: source.fullName,
      commit: snapshot.commitSha,
      path: candidate.sourcePath,
      upstreamLabel: snapshot.upstreamLabel,
    });
    if (!release.ok) throw new AppError(release.reason, "INVALID_RELEASE_METADATA", 400);
    if (candidate.state === "accepted") {
      if (candidate.packageDigest === input.expectedPackageDigest && candidate.submissionId) {
        return this.importResponse(actor, candidate, source, null, true);
      }
      throw new AppError("The candidate was already imported.", "CANDIDATE_NOT_IMPORTABLE", 409);
    }
    if (candidate.state === "superseded") throw new AppError("A newer candidate supersedes this one.", "CANDIDATE_SUPERSEDED", 409);
    if (candidate.state === "expired" || !candidate.files || Date.parse(candidate.expiresAt) <= this.clock().getTime()) {
      await this.store.transitionCandidate({ id: candidate.id, from: ["ready-for-review", "blocked"], to: "expired", actorId: null, purgeFiles: true });
      throw new AppError("The held preview expired. Preview again.", "PREVIEW_EXPIRED", 409);
    }
    if (candidate.state !== "ready-for-review" || !candidate.packageDigest) {
      throw new AppError("The candidate is blocked or was ignored.", "CANDIDATE_NOT_IMPORTABLE", 409);
    }
    if (candidate.packageDigest !== input.expectedPackageDigest || packageDigestFor(candidate.files) !== candidate.packageDigest) {
      throw new AppError("The package digest does not match the held preview.", "PREVIEW_DIGEST_MISMATCH", 409);
    }
    // Order is judged against the lineage's imported commit, which importBinding pins via the revision counter.
    if (candidate.orderStatus === "unverified" && !input.acknowledgeUnverifiedOrder) {
      throw new AppError("Source order could not be verified. Acknowledge an intentional revert or track change to import.", "CANDIDATE_ORDER_UNVERIFIED", 409);
    }
    if (candidate.orderStatus !== "unverified" && input.acknowledgeUnverifiedOrder) {
      throw new AppError("Source order is verified for this candidate; an order acknowledgement does not apply.", "ORDER_ACKNOWLEDGEMENT_NOT_APPLICABLE", 409);
    }
    const manifestFile = candidate.files.find((file) => file.path === "skill.json");
    if (!manifestFile) throw new AppError("The held preview has no generated manifest.", "PREVIEW_DIGEST_MISMATCH", 409);
    const manifest = parseSkillManifest(JSON.parse(manifestFile.content));
    const { classification, ...metadata } = release.value;
    let skillEntryId: string | null = null;
    const submission = await this.submissions.createSubmission({
      actor: { id: actor.id, roles: actor.roles },
      manifest,
      files: candidate.files.map((file) => ({ path: file.path, content: file.content })),
      release: metadata,
      importBinding: this.store.importBinding({
        candidate,
        snapshot,
        source,
        libraryId: library.id,
        actorId: actor.id,
        classification,
        orderAcknowledgement: input.acknowledgeUnverifiedOrder?.reason.slice(0, 500) ?? null,
        clientMutationId: input.clientMutationId,
        now: this.clock(),
        onAccepted: (result) => { skillEntryId = result.skillEntryId; },
      }),
    });
    const accepted = await this.requireCandidate(candidate.id);
    return this.importResponse(actor, accepted, source, {
      status: submission.scan.status,
      findingCount: submission.scan.findings.length,
      findings: submission.scan.findings,
    }, false, accepted.skillEntryId ?? skillEntryId);
  }

  async selfReview(actor: LibraryActor, candidateId: string, input: { artifactSha256: string; reason?: string }) {
    const { candidate, source } = await this.ownedCandidate(candidateId, actor);
    requireMfa(actor);
    if (candidate.state !== "accepted" || !candidate.submissionId) {
      throw new AppError("Import the candidate before reviewing it.", "SUBMISSION_NOT_REVIEWABLE", 409);
    }
    if (!(await this.store.getSettings()).privateSelfReviewEnabled) {
      throw new AppError("Private self-review is disabled for this instance.", "PRIVATE_SELF_REVIEW_DISABLED", 403);
    }
    const release = await this.submissions.selfReviewPrivateImport({
      actor: { id: actor.id, roles: actor.roles },
      submissionId: candidate.submissionId,
      artifactSha256: input.artifactSha256,
      ...(input.reason ? { reason: input.reason } : {}),
    });
    return {
      candidate: await this.toCandidate(await this.requireCandidate(candidate.id), source, false),
      release: {
        slug: release.slug,
        version: release.version,
        artifactSha256: release.artifactSha256,
        publishedAt: release.publishedAt,
        attestation: release.attestation,
      },
    };
  }

  async requestInstanceReview(actor: LibraryActor, candidateId: string) {
    const { candidate } = await this.ownedCandidate(candidateId, actor);
    if (candidate.state !== "accepted" || !candidate.submissionId) {
      throw new AppError("Only an imported, self-reviewed release can request instance review.", "SELF_REVIEW_ELEVATION_NOT_APPLICABLE", 409);
    }
    return { request: await this.submissions.requestSelfReviewElevation({ actor: { id: actor.id, roles: actor.roles }, submissionId: candidate.submissionId }) };
  }

  // ---- Adoption and resolution -------------------------------------------

  async adopt(actor: LibraryActor, entryId: string, input: { version: string; artifactSha256: string; expectedCurrentAdoptionId: string | null; reason: string }) {
    const { entry, library } = await this.writableEntry(entryId, actor);
    if (entry.kind !== "skill" || !entry.skillSlug) throw new AppError("Only skill entries can adopt a release.", "INVALID_REQUEST_BODY", 400);
    const slug = entry.skillSlug;
    const release = await this.submissions.getPublicRelease({ slug, version: input.version, actorId: actor.id });
    const facts = release ? await this.store.releaseFacts(slug, input.version) : null;
    if (!release || !facts || release.artifact.sha256 !== input.artifactSha256 || facts.artifactSha256 !== input.artifactSha256) {
      throw new AppError("Only an approved, published release with this exact artifact can be adopted.", "LIBRARY_RELEASE_NOT_ADOPTABLE", 422);
    }
    if (entry.lineageId && facts.lineageId !== entry.lineageId) {
      throw new AppError("The release has no provenance for this imported lineage.", "LIBRARY_RELEASE_NOT_ADOPTABLE", 422);
    }
    const attestation = facts.selfReviewed && !facts.elevated ? "private-self-reviewed" as const : "instance-reviewed" as const;
    if (library.ownerTeamId) {
      if (attestation === "private-self-reviewed" || !await this.teamCanRead(slug, input.version, library.ownerTeamId)) {
        throw new AppError("The team cannot read this release.", "LIBRARY_RELEASE_NOT_AUTHORIZED", 422);
      }
    } else if (attestation === "private-self-reviewed" && (facts.ownerUserId !== library.ownerUserId || facts.visibility !== "private")) {
      throw new AppError("A self-reviewed release can only be adopted by its owner in a personal library.", "LIBRARY_RELEASE_NOT_AUTHORIZED", 422);
    }
    const adoption = await this.store.adopt({
      entryId: entry.id,
      libraryId: library.id,
      slug,
      version: input.version,
      artifactSha256: input.artifactSha256,
      skillVersionId: facts.skillVersionId,
      attestation,
      expectedCurrentAdoptionId: input.expectedCurrentAdoptionId,
      actorId: actor.id,
      reason: input.reason,
    });
    return { adoption: toAdoption(adoption), entry: await this.toEntry(await this.requireEntryRecord(entry.id), actor) };
  }

  async listAdoptions(actor: LibraryActor, entryId: string) {
    const { entry } = await this.readableEntry(entryId, actor);
    return { adoptions: (await this.store.listAdoptions(entry.id)).map(toAdoption) };
  }

  async resolveEntry(actor: LibraryActor, entryId: string): Promise<{ resolution: LibraryEntryResolution }> {
    const { entry } = await this.readableEntry(entryId, actor);
    if (entry.kind !== "skill" || !entry.skillSlug) throw new AppError("Only skill entries resolve to a release.", "INVALID_REQUEST_BODY", 400);
    const base = { entryId: entry.id, libraryId: entry.libraryId, slug: entry.skillSlug };
    const adoption = await this.store.getAdoption(entry.currentAdoptionId);
    if (!adoption) return { resolution: { state: "no-adoption", ...base } };
    const release = await this.submissions.getPublicRelease({ slug: entry.skillSlug, version: adoption.version, actorId: actor.id });
    if (!release || release.artifact.sha256 !== adoption.artifactSha256) {
      return { resolution: { state: "adoption-unavailable", ...base, version: adoption.version } };
    }
    return {
      resolution: {
        state: "adopted",
        ...base,
        version: adoption.version,
        artifactSha256: adoption.artifactSha256,
        adoptionId: adoption.id,
        adoptedAt: adoption.createdAt,
      },
    };
  }

  // ---- Target bindings and the Updates constraint -------------------------

  async createBinding(actor: LibraryActor, entryId: string, input: { targetId: string; replaceConflicting: boolean }) {
    const { entry } = await this.readableEntry(entryId, actor);
    if (entry.kind !== "skill" || !entry.skillSlug) throw new AppError("Only skill entries can bind to a target.", "INVALID_REQUEST_BODY", 400);
    requireMfa(actor);
    const targets = this.requireTargets();
    await targets.authorizeUpgradePolicy(actor.id, input.targetId);
    const desired = (await this.store.getAdoption(entry.currentAdoptionId))?.version ?? null;
    const others = (await this.store.bindingsForTargetSlug(input.targetId, entry.skillSlug)).filter((row) => row.binding.entryId !== entry.id);
    const conflicting: string[] = [];
    for (const row of others) {
      const version = await this.effectiveBindingVersion(row, actor.id, entry.skillSlug) ?? row.binding.pinnedVersion;
      if (version !== desired) conflicting.push(row.binding.id);
    }
    if (conflicting.length > 0 && !input.replaceConflicting) {
      throw new AppError("Another library binding selects a different version for this skill on the target.", "BINDING_VERSION_CONFLICT", 409, { conflictingBindingCount: conflicting.length });
    }
    const result = await this.store.createBinding({
      entryId: entry.id,
      libraryId: entry.libraryId,
      targetId: input.targetId,
      slug: entry.skillSlug,
      actorId: actor.id,
      detachBindingIds: input.replaceConflicting ? conflicting : [],
    });
    return { binding: toBinding(result.binding), created: result.created };
  }

  async listBindings(actor: LibraryActor, entryId: string) {
    const { entry } = await this.readableEntry(entryId, actor);
    const targets = this.requireTargets();
    const bindings: LibraryBinding[] = [];
    for (const binding of await this.store.listBindingsForEntry(entry.id)) {
      // Only bindings on targets the caller can read; other members' devices stay private.
      if (await targets.getTarget(actor.id, binding.targetId)) bindings.push(toBinding(binding));
    }
    return { bindings };
  }

  async detachBinding(actor: LibraryActor, bindingId: string) {
    const binding = await this.store.getBinding(bindingId);
    if (!binding || binding.status === "detached") throw new AppError("Library binding not found.", "LIBRARY_BINDING_NOT_FOUND", 404);
    const targets = this.requireTargets();
    try {
      await targets.authorizeUpgradePolicy(actor.id, binding.targetId);
    } catch {
      throw new AppError("Library binding not found.", "LIBRARY_BINDING_NOT_FOUND", 404);
    }
    requireMfa(actor);
    const detached = await this.store.detachBinding(binding.id, actor.id);
    if (!detached) throw new AppError("Library binding not found.", "LIBRARY_BINDING_NOT_FOUND", 404);
    return { binding: toBinding(detached) };
  }

  /**
   * Dynamic `library-adoption` constraint for Updates, scheduling and claims.
   * Lost curation keeps the last adopted pin; it never falls back to latest.
   */
  async resolveTargetConstraints(input: { actorId: string; targetId: string; slug: string; installedVersion?: string }): Promise<LibraryTargetConstraint | null> {
    const rows = await this.store.bindingsForTargetSlug(input.targetId, input.slug);
    if (rows.length === 0) return null;
    const pins = new Set<string>();
    const entryIds = new Set<string>();
    let unavailable = false;
    for (const row of rows) {
      entryIds.add(row.binding.entryId);
      let version = row.binding.status === "active" ? await this.effectiveBindingVersion(row, input.actorId, input.slug) : null;
      if (!version) {
        unavailable = true;
        version = row.binding.pinnedVersion ?? input.installedVersion ?? null;
      }
      if (version) pins.add(version);
    }
    const versions = [...pins].sort((left, right) => parseSemanticVersion(left) && parseSemanticVersion(right) ? compareSemanticVersions(left, right) : left.localeCompare(right));
    return {
      state: versions.length > 1 ? "binding-version-conflict" : unavailable ? "curation-unavailable" : "adopted",
      entryIds: [...entryIds].sort(),
      adoptedVersions: versions,
      pins: versions,
    };
  }

  // ---- Subscriptions and inbox -------------------------------------------

  async subscribe(actor: LibraryActor, libraryId: string, input: { events: LibraryEventKind[] | null }) {
    await this.readableLibrary(libraryId, actor);
    const events = input.events ?? [...libraryEventKinds];
    return { subscription: await this.store.upsertSubscription(libraryId, actor.id, events) };
  }

  async unsubscribe(actor: LibraryActor, libraryId: string) {
    await this.readableLibrary(libraryId, actor);
    await this.store.deleteSubscription(libraryId, actor.id);
    return { subscription: null };
  }

  async listInbox(actor: LibraryActor, query: { unread: boolean; limit: number; cursor: PageCursor | null }) {
    const rows = await this.store.inboxWindow(actor.id, INBOX_WINDOW);
    const libraries = new Map<string, LibraryAccess | null>();
    const entries = new Map<string, { title: string } | null>();
    const visible: Array<LibraryInboxItem & { cursorAt: string }> = [];
    for (const row of rows) {
      if (!row.subscribedKinds.includes(row.kind)) continue;
      if (!libraries.has(row.libraryId)) {
        const library = await this.store.getLibrary(row.libraryId);
        libraries.set(row.libraryId, library ? await this.libraryAccess(library, actor) : null);
      }
      const access = libraries.get(row.libraryId);
      if (!access) continue;
      if (row.audience === "curators" && !access.canWrite) continue;
      let entryTitle: string | null = null;
      if (row.entryId) {
        if (!entries.has(row.entryId)) {
          const entry = await this.store.getEntry(row.entryId);
          const readable = entry && entry.libraryId === row.libraryId && (entry.kind !== "skill" || await this.canReadSkillEntry(entry, access, actor));
          entries.set(row.entryId, readable && entry ? { title: entry.title } : null);
        }
        const entry = entries.get(row.entryId);
        if (!entry) continue;
        entryTitle = entry.title;
      }
      visible.push({
        id: row.id,
        kind: row.kind,
        libraryId: row.libraryId,
        libraryName: row.libraryName,
        entryId: row.entryId,
        entryTitle,
        candidateId: row.candidateId,
        version: row.version,
        path: row.path,
        createdAt: row.createdAt,
        readAt: row.readAt,
        cursorAt: row.cursorAt,
      });
    }
    const unreadCount = visible.filter((item) => item.readAt === null).length;
    let items = query.unread ? visible.filter((item) => item.readAt === null) : visible;
    if (query.cursor) {
      const cursor = query.cursor;
      items = items.filter((item) => item.cursorAt < cursor.at || (item.cursorAt === cursor.at && item.id < cursor.id));
    }
    const page = items.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map(({ cursorAt: _cursorAt, ...item }) => item),
      nextCursor: items.length > query.limit && last ? encodeCursor({ at: last.cursorAt, id: last.id }) : null,
      unreadCount,
    };
  }

  async markInboxRead(actor: LibraryActor, eventIds: string[]) {
    return { updated: await this.store.markRead(actor.id, eventIds) };
  }

  // ---- Tracking -----------------------------------------------------------

  async checkNow(actor: LibraryActor, entryId: string): Promise<{ check: SourceCheckResult }> {
    const { entry } = await this.personalSourceEntry(entryId, actor);
    const leaseId = await this.store.acquireLease({ entryId: entry.id, now: this.clock(), leaseMs: CHECK_LEASE_MS });
    if (!leaseId) throw new AppError("A check for this source is already running.", "SOURCE_CHECK_IN_PROGRESS", 409);
    return { check: await this.runCheck(entry.id, leaseId) };
  }

  /**
   * Claims due tracks with a database lease; safe to call from several processes.
   * One claim per check, so a lease never waits behind other checks in a batch.
   */
  async runDueChecks(limit = 5): Promise<number> {
    let checked = 0;
    while (checked < limit) {
      const [item] = await this.store.claimDueEntries({ now: this.clock(), leaseMs: CHECK_LEASE_MS, limit: 1 });
      if (!item) break;
      await this.runCheck(item.entryId, item.leaseId);
      checked += 1;
    }
    return checked;
  }

  async purgeExpired() {
    return this.store.purgeExpired(this.clock());
  }

  private async runCheck(entryId: string, leaseId: string): Promise<SourceCheckResult> {
    const now = this.clock();
    const entry = await this.store.getEntry(entryId);
    const library = entry ? await this.store.getLibrary(entry.libraryId) : null;
    if (!entry || entry.kind !== "source" || !library?.ownerUserId) {
      if (entry) await this.store.finishCheck({ entryId, leaseId, health: entry.health, lastErrorCode: entry.lastErrorCode, attemptCount: entry.attemptCount, nextCheckAt: null, succeededAt: null, lastGoodSnapshotId: null });
      return failedCheck(entry?.health ?? "unavailable", "tracking-unsupported", null, null);
    }
    const context = this.requestContext();
    const lease: CheckLease = {
      leaseId,
      renew: async () => {
        if (!await this.store.renewLease({ entryId: entry.id, leaseId, now: this.clock(), leaseMs: CHECK_LEASE_MS })) throw leaseLostError();
      },
    };
    try {
      await lease.renew();
      // `source.fullName` is this entry's acknowledged name, not the shared source row.
      const source = await this.requireSource(entry);
      const repository = await this.provider.getRepositoryById(source.repositoryId, context);
      if (repository.fullName.toLowerCase() !== source.fullName.toLowerCase()) {
        // The alert commits with the pending name, under the lease, or not at all.
        const identity = await this.store.markIdentityChange(entry.id, leaseId, repository, {
          libraryId: library.id,
          entryId: entry.id,
          candidateId: null,
          kind: "source-health-changed",
          audience: "curators",
          semanticKey: `source-identity:${entry.id}:${source.fullName}:${repository.fullName}:${entry.lastSuccessfulCheckAt ?? "never"}`,
          version: null,
          path: null,
        });
        if (!identity.marked) return leaseLost(entry);
        return failedCheck("identity-change-review", "source-identity-changed", null, null, identity.alerted ? ["source-health-changed"] : []);
      }
      // Shared repository metadata that every save, discovery and check refreshes; not fenced by this
      // entry's lease (contract §4.3). This check uses only the row its own upsert returns, and entry
      // identity stays on the entry.
      const current = await this.store.upsertSource(repository);
      const resolved = await this.provider.resolveRef(repository, entryRef(entry), context);
      const lastGood = await this.store.getSnapshot(entry.lastGoodSnapshotId);
      const eventKinds: LibraryEventKind[] = [];
      let snapshot = lastGood;
      let changed = false;
      if (!lastGood || !lastGood.complete || lastGood.commitSha !== resolved.commitSha) {
        snapshot = await this.captureSnapshot(entry, current, repository, resolved, lastGood, context, { setLastGood: false, lease });
        changed = true;
        if (!snapshot.complete) {
          const next = scheduledAfter(entry.trackingMode, now);
          const finished = await this.store.finishCheck({
            entryId: entry.id, leaseId, health: "unavailable", lastErrorCode: "inventory-incomplete", attemptCount: 0, nextCheckAt: next, succeededAt: null, lastGoodSnapshotId: null,
            events: [healthEvent(library, entry, "unavailable")],
          });
          if (!finished) return leaseLost(entry);
          return { ...failedCheck("unavailable", "inventory-incomplete", null, next, finished.eventKinds), snapshot: snapshotSummary(snapshot) };
        }
        if (lastGood?.complete) eventKinds.push(...await this.rootChangeEvents(library, entry, lastGood, snapshot, leaseId));
      }
      const candidateIds = await this.trackLineages(library, entry, current, repository, snapshot!, context, eventKinds, lease);
      const next = scheduledAfter(entry.trackingMode, now);
      const health: LibrarySourceHealth = repository.archived ? "archived" : "healthy";
      if (!await this.store.finishCheck({ entryId: entry.id, leaseId, health, lastErrorCode: null, attemptCount: 0, nextCheckAt: next, succeededAt: now, lastGoodSnapshotId: snapshot!.id })) {
        return leaseLost(entry);
      }
      return {
        outcome: changed ? "changed" : "unchanged",
        health,
        snapshot: changed ? snapshotSummary(snapshot!) : null,
        candidateIds,
        eventKinds,
        errorCode: null,
        retryAfterSeconds: null,
        nextCheckAt: next?.toISOString() ?? null,
      };
    } catch (error) {
      if (error instanceof AppError && error.code === CHECK_LEASE_LOST) return leaseLost(entry);
      return this.failCheck(library, entry, leaseId, error, now);
    }
  }

  private async failCheck(library: LibraryRecord, entry: EntryRecord, leaseId: string, error: unknown, now: Date): Promise<SourceCheckResult> {
    const code = error instanceof AppError ? error.code : "SOURCE_PROVIDER_UNAVAILABLE";
    const health: LibrarySourceHealth = code === "SOURCE_RATE_LIMITED" ? "rate-limited" : code === "SOURCE_ACCESS_LOST" ? "access-lost" : "unavailable";
    const errorCode = code.replace(/^SOURCE_/, "").toLowerCase().replace(/_/g, "-").slice(0, 64);
    const attemptCount = Math.min(entry.attemptCount + 1, 100);
    const details = error instanceof AppError && error.details && typeof error.details === "object" ? error.details as { retryAfterSeconds?: number; rateLimitResetEpochSeconds?: number } : {};
    let retryAt = now.getTime() + Math.min(5 * 60_000 * 2 ** (Math.min(attemptCount, 10) - 1), 6 * 3_600_000);
    if (typeof details.rateLimitResetEpochSeconds === "number") retryAt = Math.max(retryAt, details.rateLimitResetEpochSeconds * 1000);
    if (typeof details.retryAfterSeconds === "number") retryAt = Math.max(retryAt, now.getTime() + details.retryAfterSeconds * 1000);
    if (attemptCount >= LIBRARY_LIMITS.maxCheckAttempts) {
      // Stop fast retries; resume at the normal cadence.
      retryAt = Math.max(retryAt, scheduledAfter(entry.trackingMode, now)?.getTime() ?? retryAt);
    }
    const next = new Date(retryAt);
    const finished = await this.store.finishCheck({
      entryId: entry.id, leaseId, health, lastErrorCode: errorCode, attemptCount, nextCheckAt: next, succeededAt: null, lastGoodSnapshotId: null,
      events: health !== entry.health ? [healthEvent(library, entry, health)] : [],
    });
    if (!finished) return leaseLost(entry);
    return failedCheck(health, errorCode, Math.max(0, Math.ceil((retryAt - now.getTime()) / 1000)), next, finished.eventKinds);
  }

  private async captureSnapshot(
    entry: EntryRecord,
    source: SourceRecord,
    repository: GithubRepositoryInfo,
    resolved: ResolvedSourceRef,
    lastGood: SnapshotRecord | null,
    context: SourceRequestContext,
    options: { setLastGood: boolean; lease?: CheckLease },
  ): Promise<SnapshotRecord> {
    const identity = {
      entryId: entry.id,
      refKind: entryRef(entry).kind,
      refValue: entry.refValue,
      commitSha: resolved.commitSha,
      treeSha: resolved.treeSha,
      upstreamLabel: resolved.upstreamLabel,
      releaseId: resolved.releaseId,
    };
    // Retries and repeated discovery of the newest upstream state reuse its snapshot and cost no tree request.
    const reusable = await this.store.findReusableSnapshot(identity);
    if (reusable) {
      if (options.setLastGood) await this.store.markLastGoodSnapshot(entry.id, reusable.id);
      return reusable;
    }
    const tree = await this.provider.getTree(repository, resolved.treeSha, context);
    const orderStatus = await this.orderStatus(repository, lastGood, resolved, context);
    await options.lease?.renew();
    return this.store.insertSnapshot({
      ...identity,
      sourceId: source.id,
      resolvedRef: resolved.resolvedRef,
      complete: !tree.truncated,
      orderStatus,
      inventory: tree.entries,
      inventoryDigest: inventoryDigest(tree.entries),
      observedAt: this.clock(),
      setLastGood: options.setLastGood,
      leaseId: options.lease?.leaseId ?? null,
    });
  }

  private async orderStatus(
    repository: GithubRepositoryInfo,
    lastGood: Pick<SnapshotRecord, "commitSha" | "upstreamLabel"> | null,
    resolved: Pick<ResolvedSourceRef, "commitSha" | "upstreamLabel">,
    context: SourceRequestContext,
  ): Promise<SnapshotRecord["orderStatus"]> {
    if (!lastGood) return "initial";
    if (lastGood.commitSha === resolved.commitSha) return "identical";
    const previousLabel = lastGood.upstreamLabel?.replace(/^.*?(\d+\.\d+\.\d+.*)$/, "$1");
    const nextLabel = resolved.upstreamLabel?.replace(/^.*?(\d+\.\d+\.\d+.*)$/, "$1");
    if (previousLabel && nextLabel && parseSemanticVersion(previousLabel) && parseSemanticVersion(nextLabel)
      && compareSemanticVersions(nextLabel, previousLabel) < 0) {
      return "unverified";
    }
    const order = await this.provider.compareCommits(repository, lastGood.commitSha, resolved.commitSha, context);
    return order === "ahead" ? "ahead" : order === "identical" ? "identical" : "unverified";
  }

  /**
   * Order of a candidate's snapshot against the commit its lineage last imported.
   * The entry's last good snapshot is not the reference: a force-push can be ahead
   * of it and still discard the imported commit.
   */
  private async candidateOrder(
    lineage: LineageRecord,
    snapshot: SnapshotRecord,
    repository: GithubRepositoryInfo,
    context: SourceRequestContext,
    cache: Map<string, SnapshotRecord["orderStatus"]> | undefined,
  ): Promise<SnapshotRecord["orderStatus"]> {
    if (lineage.revisionCounter === 0) return "initial";
    const head = await this.store.getSnapshot(lineage.headSnapshotId);
    if (!head) return "unverified";
    const key = `${head.commitSha}:${head.upstreamLabel ?? ""}:${snapshot.commitSha}:${snapshot.upstreamLabel ?? ""}`;
    const known = cache?.get(key);
    if (known) return known;
    const order = await this.orderStatus(repository, head, snapshot, context);
    cache?.set(key, order);
    return order;
  }

  private async rootChangeEvents(library: LibraryRecord, entry: EntryRecord, previous: SnapshotRecord, current: SnapshotRecord, leaseId: string): Promise<LibraryEventKind[]> {
    const relevant = (roots: string[]) => roots.filter((root) => {
      const relative = entry.sourcePath && root.startsWith(`${entry.sourcePath}/`) ? root.slice(entry.sourcePath.length + 1) : root;
      return !relative || !isDefaultExcludedSourcePath(relative);
    });
    const before = new Set(relevant(listSkillRootPaths(previous.inventory, entry.sourcePath)));
    const after = new Set(relevant(listSkillRootPaths(current.inventory, entry.sourcePath)));
    const added = [...after].filter((root) => !before.has(root));
    const removed = [...before].filter((root) => !after.has(root));
    const events: LibraryEventInput[] = [];
    const emit = (kind: LibraryEventKind, key: string, path: string) => {
      events.push({ libraryId: library.id, entryId: entry.id, candidateId: null, kind, audience: "curators", semanticKey: key, version: null, path });
    };
    // Keys name the upstream transition, not the snapshot row, so a retried check emits nothing new.
    const transition = `${previous.commitSha}:${current.commitSha}`;
    for (const root of added.slice(0, 50)) emit("new-skill-discovered", `new-skill:${entry.id}:${root}`, root);
    for (const root of removed.slice(0, 50)) emit("skill-removed", `skill-removed:${entry.id}:${transition}:${root}`, root);
    for (const from of removed.slice(0, 20)) {
      const signature = rootFileSignature(previous.inventory, from);
      const to = added.find((root) => rootFileSignature(current.inventory, root) === signature);
      if (to) emit("skill-renamed-suggested", `skill-renamed:${entry.id}:${transition}:${from}:${to}`, `${from} -> ${to}`);
    }
    // One transaction under the lease. A check that lost it writes none; the winner or a retry
    // recomputes the same transition from the unchanged last good snapshot.
    return [...new Set(await this.store.insertCheckEvents(entry.id, leaseId, events))];
  }

  private async trackLineages(
    library: LibraryRecord,
    entry: EntryRecord,
    source: SourceRecord,
    repository: GithubRepositoryInfo,
    snapshot: SnapshotRecord,
    context: SourceRequestContext,
    eventKinds: LibraryEventKind[],
    lease: CheckLease,
  ): Promise<string[]> {
    const candidateIds: string[] = [];
    const orderCache = new Map<string, SnapshotRecord["orderStatus"]>();
    for (const lineage of await this.store.lineagesForSourceEntry(entry.id)) {
      if (lineage.refKind !== entryRef(entry).kind || lineage.refValue !== entry.refValue) continue;
      const digest = computeSourceDigest(snapshot.inventory, lineage.sourcePath);
      // Unrelated repository changes and already-proposed bytes (including ignored ones) create nothing.
      // The skip is safe because a tracked candidate and its inbox item commit in one transaction.
      if (!digest || digest === lineage.headSourceDigest || await this.store.hasProposedCandidateForSource(lineage.id, digest)) continue;
      const { candidate, notified } = await this.buildCandidate({
        origin: "tracking",
        previewId: null,
        lineage,
        entry,
        source,
        repository,
        snapshot,
        overrides: lineage.mappingOverrides,
        context,
        ttlMs: TRACKING_TTL_MS,
        lease,
        notify: { libraryId: library.id, semanticKey: `candidate-source:${lineage.id}:${digest}`, path: lineage.sourcePath },
        orderCache,
      });
      candidateIds.push(candidate.id);
      if (notified && !eventKinds.includes(notified)) eventKinds.push(notified);
    }
    return candidateIds;
  }

  private async buildCandidate(input: {
    origin: "preview" | "tracking";
    previewId: string | null;
    lineage: LineageRecord;
    entry: EntryRecord;
    source: SourceRecord;
    repository: GithubRepositoryInfo;
    snapshot: SnapshotRecord;
    overrides: MappingOverrides;
    context: SourceRequestContext;
    ttlMs: number;
    /** Tracking only: the candidate and its notification are written under this lease. */
    lease?: CheckLease;
    notify?: CandidateNotification;
    orderCache?: Map<string, SnapshotRecord["orderStatus"]>;
  }): Promise<{ candidate: CandidateRecord; notified: LibraryEventKind | null }> {
    const ownership = await this.store.skillOwnership(input.lineage.slug);
    const visibility = ownership?.visibility ?? "private";
    const profileDigest = importProfileDigest({ overrides: input.overrides, visibility });
    const existing = await this.store.findActiveCandidate(input.lineage.id, input.snapshot.id, profileDigest);
    if (existing) {
      // Tracking reaches this only when an owner preview of the same snapshot raced the check.
      // The check did not write that candidate; only its notification is a check write.
      const notified = input.lease && input.notify
        ? (await this.store.insertCheckEvents(input.entry.id, input.lease.leaseId, [candidateEvent(existing, input.notify)]))[0] ?? null
        : null;
      return { candidate: existing, notified };
    }
    const expectedPriorRevision = input.lineage.revisionCounter;
    const expectedVersion = importRevisionVersion(expectedPriorRevision + 1);
    const orderStatus = await this.candidateOrder(input.lineage, input.snapshot, input.repository, input.context, input.orderCache);
    const result = await buildCandidatePackage({
      entries: input.snapshot.inventory,
      rootPath: input.lineage.sourcePath,
      fetchBlob: (file) => this.provider.readBlob(input.repository, input.snapshot.commitSha, file.sourcePath, file.entry.sha, MAX_PACKAGE_TEXT_BYTES, input.context),
      slug: input.lineage.slug,
      version: expectedVersion,
      visibility,
      licenseSpdx: input.repository.licenseSpdx,
      overrides: input.overrides,
      source: {
        repositoryId: input.source.repositoryId,
        fullName: input.repository.fullName,
        url: input.repository.htmlUrl,
        commit: input.snapshot.commitSha,
        treeSha: input.snapshot.treeSha,
        ref: entryRef(input.entry),
        upstreamLabel: input.snapshot.upstreamLabel,
        releaseId: input.snapshot.releaseId,
      },
    });
    await input.lease?.renew();
    return this.store.insertCandidate({
      sourceEntryId: input.entry.id,
      lineageId: input.lineage.id,
      ownerUserId: input.lineage.ownerUserId,
      snapshotId: input.snapshot.id,
      snapshotSequence: input.snapshot.sequence,
      snapshotObservedAt: input.snapshot.observedAt,
      previewId: input.previewId,
      origin: input.origin,
      state: result.ready ? "ready-for-review" : "blocked",
      sourcePath: input.lineage.sourcePath,
      nativeName: result.nativeName,
      profileDigest,
      expectedPriorRevision,
      expectedVersion,
      orderStatus,
      sourceDigest: result.sourceDigest,
      packageDigest: result.ready ? result.packageDigest : null,
      files: result.ready ? result.files : null,
      fileDigests: result.fileDigests,
      mapping: {
        ...result.mapping,
        overrides: input.overrides,
        provenance: { files: result.provenanceFiles, transforms: result.mapping.transforms, headFiles: result.headFiles },
      },
      findings: result.findings,
      changes: expectedPriorRevision > 0 ? computeChanges(input.lineage.headFiles, result.headFiles) : null,
      expiresAt: new Date(this.clock().getTime() + input.ttlMs),
      supersedeOlder: true,
      leaseId: input.lease?.leaseId ?? null,
      notify: input.notify ?? null,
    });
  }

  // ---- Serialization ------------------------------------------------------

  private async toSummary(library: LibraryRecord, access: LibraryAccess, actor: LibraryActor): Promise<LibrarySummary> {
    return {
      id: library.id,
      name: library.name,
      description: library.description,
      owner: library.ownerUserId
        ? { type: "user", id: library.ownerUserId }
        : { type: "team", id: library.ownerTeamId ?? "", name: library.ownerTeamName ?? "" },
      status: "active",
      revision: library.revision,
      access: { role: access.role, canWrite: access.canWrite, canTrackSources: access.personal, canImport: access.personal },
      subscription: await this.store.getSubscription(library.id, actor.id),
      createdAt: library.createdAt,
      updatedAt: library.updatedAt,
    };
  }

  private async toEntry(entry: EntryRecord, actor: LibraryActor): Promise<LibraryEntry> {
    const base = {
      id: entry.id,
      libraryId: entry.libraryId,
      kind: entry.kind,
      status: "active" as const,
      revision: entry.revision,
      title: entry.title,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
    if (entry.kind === "source") {
      const source = await this.requireSource(entry);
      const lastGood = await this.store.getSnapshot(entry.lastGoodSnapshotId);
      return {
        ...base,
        source: {
          provider: "github",
          repositoryId: source.repositoryId,
          fullName: source.fullName,
          url: source.htmlUrl,
          path: entry.sourcePath,
          ref: entryRef(entry),
          defaultBranch: source.defaultBranch,
          license: source.licenseSpdx,
          archived: source.archived,
        },
        tracking: {
          mode: entry.trackingMode,
          health: entry.health,
          nextCheckAt: entry.nextCheckAt,
          lastAttemptAt: entry.lastAttemptAt,
          lastSuccessfulCheckAt: entry.lastSuccessfulCheckAt,
          lastErrorCode: entry.lastErrorCode,
          attemptCount: entry.attemptCount,
          lastGoodSnapshot: lastGood ? { id: lastGood.id, commit: lastGood.commitSha, upstreamLabel: lastGood.upstreamLabel, observedAt: lastGood.observedAt } : null,
          workerAvailable: this.workerRunning,
          identityChange: entry.pendingFullName && entry.acknowledgedFullName ? {
            acknowledgedFullName: entry.acknowledgedFullName,
            observedFullName: entry.pendingFullName,
            observedUrl: `https://github.com/${entry.pendingFullName}`,
          } : null,
        },
        adoption: null,
      };
    }
    const lineage = await this.store.getLineage(entry.lineageId);
    const ownership = entry.skillSlug ? await this.store.skillOwnership(entry.skillSlug) : null;
    const adoption = await this.store.getAdoption(entry.currentAdoptionId);
    return {
      ...base,
      skill: {
        slug: entry.skillSlug ?? "",
        nativeName: lineage?.nativeName ?? null,
        sourceEntryId: entry.sourceEntryId,
        sourcePath: lineage?.sourcePath ?? null,
        lineageId: entry.lineageId,
        ownership: { type: "user", isCaller: ownership?.ownerUserId === actor.id },
      },
      adoption: adoption ? toAdoption(adoption) : null,
    };
  }

  private async toCandidate(candidate: CandidateRecord, source: SourceRecord, includeContent: boolean): Promise<LibraryCandidate> {
    const snapshot = await this.requireSnapshot(candidate.snapshotId);
    const lineage = await this.store.getLineage(candidate.lineageId);
    const facts = candidate.submissionId ? (await this.store.submissionFacts([candidate.submissionId])).get(candidate.submissionId) : undefined;
    const content = new Map((includeContent ? candidate.files ?? [] : []).map((file) => [file.path, file.content]));
    const { overrides: _overrides, provenance: _provenance, ...mapping } = candidate.mapping;
    return {
      id: candidate.id,
      sourceEntryId: candidate.sourceEntryId,
      skillEntryId: candidate.skillEntryId,
      previewId: candidate.previewId,
      lineage: { id: candidate.lineageId, slug: lineage?.slug ?? mapping.slug, nativeName: candidate.nativeName },
      state: candidate.state,
      origin: candidate.origin,
      sourcePath: candidate.sourcePath,
      snapshot: snapshotSummary(snapshot),
      orderStatus: candidate.orderStatus,
      expectedVersion: candidate.expectedVersion,
      expectedPriorRevision: candidate.expectedPriorRevision,
      sourceDigest: candidate.sourceDigest,
      packageDigest: candidate.packageDigest,
      files: candidate.fileDigests.map((file) => (content.has(file.path) ? { ...file, content: content.get(file.path) } : file)),
      mapping,
      release: {
        suggested: suggestedImportRelease({
          repositoryId: source.repositoryId,
          fullName: source.fullName,
          url: source.htmlUrl,
          commit: snapshot.commitSha,
          treeSha: snapshot.treeSha,
          ref: { kind: snapshot.refKind, ...(snapshot.refValue ? { value: snapshot.refValue } : {}) },
          upstreamLabel: snapshot.upstreamLabel,
          releaseId: snapshot.releaseId,
        }, candidate.sourcePath),
      },
      findings: candidate.findings,
      changes: candidate.changes,
      registry: facts ? {
        submissionId: facts.submissionId,
        slug: facts.slug,
        version: facts.version,
        reviewStatus: facts.reviewStatus,
        securityStatus: facts.securityStatus,
        publishedAt: facts.publishedAt,
        attestation: facts.selfReviewed && !facts.elevated ? "private-self-reviewed" : facts.publishedAt ? "instance-reviewed" : null,
        elevationRequestedAt: facts.elevationRequestedAt,
      } : null,
      expiresAt: candidate.expiresAt,
      createdAt: candidate.createdAt,
      decidedAt: candidate.decidedAt,
    };
  }

  private async importResponse(
    actor: LibraryActor,
    candidate: CandidateRecord,
    source: SourceRecord,
    scan: { status: string; findingCount: number; findings: unknown[] } | null,
    replayed: boolean,
    skillEntryId: string | null = candidate.skillEntryId,
  ) {
    const facts = candidate.submissionId ? (await this.store.submissionFacts([candidate.submissionId])).get(candidate.submissionId) : undefined;
    if (!facts) throw new AppError("Import candidate not found.", "LIBRARY_CANDIDATE_NOT_FOUND", 404);
    const entry = skillEntryId ? await this.store.getEntry(skillEntryId) : null;
    return {
      candidate: await this.toCandidate(candidate, source, false),
      entry: entry ? await this.toEntry(entry, actor) : null,
      submission: { id: facts.submissionId, slug: facts.slug, version: facts.version, reviewStatus: facts.reviewStatus, securityStatus: facts.securityStatus },
      scan,
      replayed,
    };
  }

  // ---- Access helpers -----------------------------------------------------

  private async libraryAccess(library: LibraryRecord, actor: Pick<LibraryActor, "id">): Promise<LibraryAccess | null> {
    if (library.ownerUserId) return library.ownerUserId === actor.id ? { role: "owner", canWrite: true, personal: true } : null;
    if (!library.ownerTeamId) return null;
    const role = await this.store.teamRole(library.ownerTeamId, actor.id);
    if (role === "owner") return { role: "curator", canWrite: true, personal: false };
    if (role === "member") return { role: "member", canWrite: false, personal: false };
    return null;
  }

  private async readableLibrary(libraryId: string, actor: LibraryActor): Promise<{ library: LibraryRecord; access: LibraryAccess }> {
    const library = await this.store.getLibrary(libraryId);
    const access = library ? await this.libraryAccess(library, actor) : null;
    if (!library || !access) throw new AppError("Library not found.", "LIBRARY_NOT_FOUND", 404);
    return { library, access };
  }

  private async writableLibrary(libraryId: string, actor: LibraryActor) {
    const result = await this.readableLibrary(libraryId, actor);
    requireWrite(result.access, actor);
    return result;
  }

  private async readableEntry(entryId: string, actor: LibraryActor): Promise<{ entry: EntryRecord; library: LibraryRecord; access: LibraryAccess }> {
    const entry = await this.store.getEntry(entryId);
    const library = entry ? await this.store.getLibrary(entry.libraryId) : null;
    const access = library ? await this.libraryAccess(library, actor) : null;
    if (!entry || !library || !access || (entry.kind === "skill" && !await this.canReadSkillEntry(entry, access, actor))) {
      throw new AppError("Library entry not found.", "LIBRARY_ENTRY_NOT_FOUND", 404);
    }
    return { entry, library, access };
  }

  private async writableEntry(entryId: string, actor: LibraryActor) {
    const result = await this.readableEntry(entryId, actor);
    requireWrite(result.access, actor);
    return result;
  }

  private async personalSourceEntry(entryId: string, actor: LibraryActor) {
    const result = await this.writableEntry(entryId, actor);
    if (result.entry.kind !== "source") throw new AppError("This action needs a source entry.", "INVALID_REQUEST_BODY", 400);
    if (!result.access.personal) {
      throw new AppError("Tracking, discovery and imports are available in personal libraries in this release.", "LIBRARY_TRACKING_UNSUPPORTED", 409);
    }
    return result;
  }

  private async ownedCandidate(candidateId: string, actor: LibraryActor) {
    const candidate = await this.store.getCandidate(candidateId);
    const entry = candidate ? await this.store.getEntry(candidate.sourceEntryId) : null;
    const library = entry ? await this.store.getLibrary(entry.libraryId) : null;
    if (!candidate || candidate.ownerUserId !== actor.id || !entry || !library || library.ownerUserId !== actor.id) {
      throw new AppError("Import candidate not found.", "LIBRARY_CANDIDATE_NOT_FOUND", 404);
    }
    return { candidate, entry, library, source: await this.requireSource(entry) };
  }

  /**
   * Library membership never grants artifact access. A curator who owns the
   * skill can always see its entry; everyone else needs the release itself.
   */
  private async canReadSkillEntry(entry: EntryRecord, access: LibraryAccess, actor: Pick<LibraryActor, "id">): Promise<boolean> {
    if (!entry.skillSlug) return false;
    if (access.canWrite && (await this.store.skillOwnership(entry.skillSlug))?.ownerUserId === actor.id) return true;
    if (entry.currentAdoptionId) {
      const adoption = await this.store.getAdoption(entry.currentAdoptionId);
      return Boolean(adoption && await this.submissions.getPublicRelease({ slug: entry.skillSlug, version: adoption.version, actorId: actor.id }));
    }
    return Boolean(await this.skills.getVisibleSkillBySlug(entry.skillSlug, actor.id));
  }

  private async readableSkill(slug: string, actor: LibraryActor): Promise<{ title: string }> {
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug) || slug.includes("--") || slug.length > 64) {
      throw new AppError("Valid skill slug is required.", "INVALID_SKILL_SLUG", 400);
    }
    const visible = await this.skills.getVisibleSkillBySlug(slug, actor.id);
    if (visible) return { title: visible.title };
    if ((await this.store.skillOwnership(slug))?.ownerUserId === actor.id) return { title: slug };
    throw new AppError("Skill not found.", "SKILL_NOT_FOUND", 404);
  }

  private async teamCanRead(slug: string, version: string | null, teamId: string): Promise<boolean> {
    const sharing = await this.skills.getSharingSettings();
    return this.store.releaseVisibleToTeam({
      slug,
      version,
      teamId,
      publicEnabled: sharing.publicVisibilityEnabled,
      authenticatedEnabled: sharing.authenticatedVisibilityEnabled,
      teamEnabled: sharing.teamsEnabled && sharing.teamVisibilityEnabled,
    });
  }

  private async effectiveBindingVersion(
    row: Awaited<ReturnType<PostgresLibraryStore["bindingsForTargetSlug"]>>[number],
    actorId: string,
    slug: string,
  ): Promise<string | null> {
    if (row.binding.status !== "active" || !row.entryActive || !row.library || !row.adoption) return null;
    const access = await this.libraryAccess(row.library, { id: actorId });
    if (!access) return null;
    const release = await this.submissions.getPublicRelease({ slug, version: row.adoption.version, actorId });
    return release && release.artifact.sha256 === row.adoption.artifactSha256 ? row.adoption.version : null;
  }

  private async reserveLineage(ownerUserId: string, entry: EntryRecord, source: SourceRecord, path: string): Promise<LineageRecord> {
    const ref = entryRef(entry);
    const directory = path ? posix.basename(path) : source.fullName.split("/")[1] ?? "skill";
    return this.store.reserveLineage({
      ownerUserId,
      sourceId: source.id,
      sourcePath: path,
      refKind: ref.kind,
      refValue: entry.refValue,
      // Informational only; an over-long native name blocks the candidate itself.
      nativeName: directory.slice(0, 200),
      slugForAttempt: (attempt) => allocateImportedSkillSlug(directory, this.slugSuffix(`${ownerUserId}:github:${source.repositoryId}:${path}:${ref.kind}:${entry.refValue}:${attempt}`)),
    });
  }

  private async currentRepository(entry: EntryRecord, source: SourceRecord, context: SourceRequestContext): Promise<GithubRepositoryInfo> {
    const repository = await this.provider.getRepositoryById(source.repositoryId, context);
    if (repository.fullName.toLowerCase() !== source.fullName.toLowerCase()) {
      // Pending on this entry only, so its owner sees the review without waiting for a check.
      await this.store.markIdentityChange(entry.id, null, repository);
      throw new AppError("The source repository was renamed or transferred. Review it before continuing.", "SOURCE_IDENTITY_CHANGED", 409);
    }
    await this.store.upsertSource(repository);
    return repository;
  }

  /**
   * The shared source row is metadata that any user's save or check refreshes.
   * Identity comes from the entry: its acknowledged name replaces the shared one.
   */
  private async requireSource(entry: EntryRecord): Promise<SourceRecord> {
    const source = entry.sourceId ? await this.store.getSource(entry.sourceId) : null;
    if (!source) throw new AppError("Library entry not found.", "LIBRARY_ENTRY_NOT_FOUND", 404);
    return entry.acknowledgedFullName
      ? { ...source, fullName: entry.acknowledgedFullName, htmlUrl: `https://github.com/${entry.acknowledgedFullName}` }
      : source;
  }

  private async requireSnapshot(id: string): Promise<SnapshotRecord> {
    const snapshot = await this.store.getSnapshot(id);
    if (!snapshot) throw new AppError("Snapshot not found.", "SNAPSHOT_NOT_FOUND", 404);
    return snapshot;
  }

  private async requireCandidate(id: string): Promise<CandidateRecord> {
    const candidate = await this.store.getCandidate(id);
    if (!candidate) throw new AppError("Import candidate not found.", "LIBRARY_CANDIDATE_NOT_FOUND", 404);
    return candidate;
  }

  private async requireEntryRecord(id: string): Promise<EntryRecord> {
    const entry = await this.store.getEntry(id);
    if (!entry) throw new AppError("Library entry not found.", "LIBRARY_ENTRY_NOT_FOUND", 404);
    return entry;
  }

  private requireTargets(): ArchitectureTargetService {
    if (!this.targets) throw new AppError("Target bindings are not configured.", "LIBRARY_SERVICE_UNAVAILABLE", 503);
    return this.targets;
  }

  private requestContext(): SourceRequestContext {
    return { deadline: Date.now() + LIBRARY_LIMITS.checkDeadlineMs };
  }
}

function requireAdmin(actor: LibraryActor): void {
  if (!actor.roles.some((role) => role === "owner" || role === "admin")) {
    throw new AppError("Admin access is required.", "ADMIN_ROLE_REQUIRED", 403);
  }
}

function requireMfa(actor: LibraryActor): void {
  if (!actor.mfaVerified) throw new AppError("MFA verification is required.", "MFA_VERIFICATION_REQUIRED", 403);
}

function requireWrite(access: LibraryAccess, actor: LibraryActor): void {
  if (!access.canWrite) throw new AppError("Library curator access is required.", "LIBRARY_WRITE_FORBIDDEN", 403);
  if (!access.personal) requireMfa(actor);
}

function entryRef(entry: EntryRecord): LibrarySourceRef {
  const kind: LibrarySourceRefKind = entry.refKind ?? "default-branch";
  return entry.refValue ? { kind, value: entry.refValue } : { kind };
}

function normalizeRef(ref: LibrarySourceRef): LibrarySourceRef {
  const needsValue = ref.kind === "branch" || ref.kind === "tag" || ref.kind === "commit" || ref.kind === "tag-prefix";
  if (needsValue && (!ref.value || ref.value.length > 255)) throw new AppError("This ref kind needs a value.", "SOURCE_REF_INVALID", 400);
  if (!needsValue && ref.value) throw new AppError("This ref kind takes no value.", "SOURCE_REF_INVALID", 400);
  if (ref.kind === "commit" && !/^[0-9a-f]{40}$/.test(ref.value ?? "")) throw new AppError("Commit refs must be 40-character lowercase SHAs.", "SOURCE_REF_INVALID", 400);
  if (ref.value && (!/^[A-Za-z0-9._/-]{1,255}$/.test(ref.value) || ref.value.includes("..") || ref.value.startsWith("/") || ref.value.startsWith("-"))) {
    throw new AppError("The ref value is invalid.", "SOURCE_REF_INVALID", 400);
  }
  return needsValue ? { kind: ref.kind, value: ref.value } : { kind: ref.kind };
}

export function normalizeSourcePath(input: string): string {
  let start = 0;
  let end = input.length;
  while (start < end && input[start] === "/") start += 1;
  while (end > start && input[end - 1] === "/") end -= 1;
  const trimmed = input.slice(start, end);
  if (!trimmed) return "";
  const segments = trimmed.split("/");
  if (trimmed.length > 1024 || segments.some((segment) => !segment || segment === "." || segment === ".." || /[\u0000-\u001f\u007f\\]/.test(segment))) {
    throw new AppError("The source path is invalid.", "LIBRARY_PREVIEW_SELECTION_INVALID", 400);
  }
  return segments.join("/");
}

function scheduledAfter(mode: LibraryTrackingMode, now: Date): Date | null {
  if (mode === "daily") return new Date(now.getTime() + 86_400_000);
  if (mode === "weekly") return new Date(now.getTime() + 7 * 86_400_000);
  return null;
}

function snapshotSummary(snapshot: SnapshotRecord): SourceSnapshotSummary {
  return {
    id: snapshot.id,
    sequence: snapshot.sequence,
    commit: snapshot.commitSha,
    treeSha: snapshot.treeSha,
    ref: snapshot.refValue ? { kind: snapshot.refKind, value: snapshot.refValue } : { kind: snapshot.refKind },
    upstreamLabel: snapshot.upstreamLabel,
    orderStatus: snapshot.orderStatus,
    complete: snapshot.complete,
    observedAt: snapshot.observedAt,
  };
}

function failedCheck(health: LibrarySourceHealth, errorCode: string, retryAfterSeconds: number | null, next: Date | null, eventKinds: LibraryEventKind[] = []): SourceCheckResult {
  return { outcome: "failed", health, snapshot: null, candidateIds: [], eventKinds, errorCode, retryAfterSeconds, nextCheckAt: next?.toISOString() ?? null };
}

/** Another worker may own the entry now; this check reports and writes nothing further. */
function leaseLost(entry: EntryRecord): SourceCheckResult {
  return failedCheck(entry.health, "lease-lost", null, entry.nextCheckAt ? new Date(entry.nextCheckAt) : null);
}

function healthEvent(library: LibraryRecord, entry: EntryRecord, health: LibrarySourceHealth): LibraryEventInput {
  return {
    libraryId: library.id,
    entryId: entry.id,
    candidateId: null,
    kind: "source-health-changed",
    audience: "curators",
    semanticKey: `source-health:${entry.id}:${health}:${entry.lastSuccessfulCheckAt ?? "never"}`,
    version: null,
    path: null,
  };
}

function toAdoption(record: AdoptionRecord): LibraryAdoption {
  return {
    id: record.id,
    entryId: record.entryId,
    slug: record.slug,
    version: record.version,
    artifactSha256: record.artifactSha256,
    predecessorAdoptionId: record.predecessorAdoptionId,
    attestation: record.attestation,
    adoptedBy: { id: record.actorUserId },
    reason: record.reason,
    adoptedAt: record.createdAt,
  };
}

function toBinding(record: BindingRecord): LibraryBinding {
  return {
    id: record.id,
    entryId: record.entryId,
    libraryId: record.libraryId,
    targetId: record.targetId,
    slug: record.slug,
    status: record.status,
    pinnedVersion: record.pinnedVersion,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function mutationDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function encodeCursor(cursor: PageCursor): string {
  return Buffer.from(JSON.stringify([cursor.at, cursor.id])).toString("base64url");
}

export function decodeCursor(input: unknown): PageCursor | null {
  if (input === undefined || input === null || input === "") return null;
  try {
    if (typeof input !== "string" || input.length > 200) throw new Error("invalid");
    const value: unknown = JSON.parse(Buffer.from(input, "base64url").toString("utf8"));
    if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "string" || typeof value[1] !== "string"
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value[0]) || !/^[0-9a-f-]{36}$/i.test(value[1])) {
      throw new Error("invalid");
    }
    return { at: value[0], id: value[1] };
  } catch {
    throw new AppError("Invalid cursor for this list.", "INVALID_PAGE_CURSOR", 400);
  }
}
