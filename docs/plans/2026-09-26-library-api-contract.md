# Libraries: API contract handoff (first release 1A–1C)

Status: backend contract for the parent web/CLI/E2E work. Written before implementation on 2026-09-26 by the delegated backend (Opus 5.5). Shapes here are the commitment; if an implementation detail must change, it will be additive and listed in the final handoff.

Revision 2026-09-26 (backend review remediation, additive): per-entry repository identity with `tracking.identityChange`; `LibraryCandidate.orderStatus` measured against the lineage's imported commit; new 409 codes `IDENTITY_ACKNOWLEDGEMENT_NOT_APPLICABLE` and `ORDER_ACKNOWLEDGEMENT_NOT_APPLICABLE`; per-user limit on provider-backed source requests (`429 LIBRARY_SOURCE_RATE_LIMITED`); check error code `lease-lost`; snapshot reuse; `inventory-incomplete` for a file without a reported size; the 200-character native-name bound now also applies to directory-derived names.

Revision 2026-09-26 (lease fencing, no shape change): every check-owned write validates the lease inside its own transaction, and each tracked candidate commits with its inbox item (§4.3). The `lease-lost` wording in §6 now says which rows can remain.

Revision 2026-09-26 (beta.8 runtime-name normalization, owner-approved, additive shapes): the runtime `SKILL.md` name is the registry slug and the exact upstream `SKILL.md` is held at `myskills-source-skill.txt` (§4.4 package layout). New transform kind `normalize-runtime-name` with optional `LibraryTransform` fields `originalPath`, `originalSha256`, `transformedSha256`, `originalName`, `runtimeName`; new finding code `native-frontmatter-unsupported`; new core constant `LIBRARY_ORIGINAL_SKILL_PATH`. The importer version is `myskills-library-importer/2`, so earlier active candidates are not reused.

Scope: personal libraries, public GitHub source references and imports (1A); manual/daily/weekly tracking and in-app inbox (1B); team libraries that curate already-authorized releases (1C); admin-controlled private self-review. Not in scope: private GitHub credentials, org-owned imports, email or external notifications, unattended target application, native plugin execution.

## 1. Conventions

- All routes are under `/v1`. JSON bodies. Errors use the existing envelope: `{ "error": { "code": "UPPER_SNAKE", "message": "...", "details"?: {...} } }`.
- Unauthorized private resources return a generic `404` (`LIBRARY_NOT_FOUND`, `LIBRARY_ENTRY_NOT_FOUND`, `LIBRARY_CANDIDATE_NOT_FOUND`). Detailed conflict codes appear only after the caller is authorized for the resource.
- Lists: `?limit=` (1–100, default 50) and `?cursor=` (opaque). Responses carry `nextCursor: string | null`. No list returns hidden-item counts.
- Mutations that create records accept an optional `clientMutationId` (1–128 chars `[A-Za-z0-9._:-]`). A replay with identical input returns the original record with `200` and `"replayed": true`. Reusing the ID with different input returns `409 CLIENT_MUTATION_ID_CONFLICT`.
- Optimistic concurrency: `expectedRevision` (integer) on library/entry updates. Mismatch returns `409 LIBRARY_REVISION_CONFLICT` with `details.currentRevision`.
- Timestamps are ISO-8601 UTC strings. Digests are lowercase SHA-256 hex unless named `gitBlobSha`/`commit` (40-hex SHA-1).
- CORS: the API now also allows `PATCH` in `access-control-allow-methods`.
- Finding codes inside `findings[]` use the spec's lowercase-kebab vocabulary. HTTP error codes use the existing UPPER_SNAKE vocabulary.

## 2. Authentication and scopes

New API-token scopes (added to `apiTokenScopes`; the web `ApiTokenScope` union needs the same two values):

| Scope | Allows |
|---|---|
| `libraries:read` | Read libraries, entries, candidates, adoptions, bindings, inbox, subscriptions, and `GET /v1/library-entries/:id/resolution` |
| `libraries:write` | Create/update/delete libraries and entries, discover, preview, check sources, tracking settings, adopt, subscribe, mark inbox read, ignore candidates |

Existing scopes are unchanged and not broadened. Additional requirements:

| Route family | Auth |
|---|---|
| Library reads | Session, or token with `libraries:read` |
| Library writes (personal) | Session, or token with `libraries:write` |
| Library writes (team library) | As above **and** `mfaVerified` (session MFA or MFA-bound token) |
| Candidate import | Session, or token with `libraries:write` **and** `skills:submit`; existing author-role rule applies (`SUBMISSION_ROLE_REQUIRED`); privileged roles need MFA as in `POST /v1/submissions` |
| Candidate self-review | Session or token with `libraries:write` + `skills:submit`; **always** `mfaVerified`; setting must be enabled |
| Target bindings | Session only, `mfaVerified` (mirrors target update policy; checked after entry authorization so outsiders still get a generic 404) |
| Admin library settings | Session only, role `owner` or `admin`, `mfaVerified` |
| Self-reviewed release elevation | Same as existing review actions: `review:read`/`review:write`, reviewer role (`owner`/`admin`/`maintainer`), MFA for privileged roles |

Provider budget: every provider request spends the instance's shared, unauthenticated GitHub budget (about 60 REST requests per hour per egress IP). Provider-backed source requests are therefore limited per user: `POST /v1/libraries/:id/entries` with `kind: "source"` and a supported URL, `POST .../discoveries`, `POST .../previews` and `POST .../checks`. Default `LIBRARY_LIMITS.maxSourceOperationsPerHour` (10) per user per hour; production uses the Postgres-backed limiter so the bound holds across processes. Over the limit → `429 LIBRARY_SOURCE_RATE_LIMITED` with a `retry-after` header and `details.retryAfterSeconds`, and no provider request is made. Unsupported URLs are still refused with `400 SOURCE_URL_UNSUPPORTED` and do not count. Scheduled checks are not counted against the user.

## 3. Access model

- A library has exactly one owner: `{ "type": "user" }` (the caller) or `{ "type": "team", "id" }`.
- Personal library: owner reads and writes. Nobody else can see it (admins included).
- Team library: effective team **owners** write (curate); current effective team members read. Effective membership uses the same organization-parent rules as team skill sharing. Removal takes effect at the next request.
- Library visibility never overrides artifact grants. Each `skill` entry whose adopted or referenced release is not readable by the caller is **omitted** from lists and returns 404 on direct read. The inbox applies the same filter.
- Team libraries contain only `skill` entries for registry releases already visible to the team (`public`, `authenticated`, or `team` with a grant to that team), and `source` entries as reference-only (no tracking, no import). Imports and tracks are personal.
- Self-reviewed (not instance-elevated) releases can be adopted only in the owner's personal library.

## 4. Routes

### 4.1 Libraries

`GET /v1/libraries` → `200 { "libraries": LibrarySummary[], "nextCursor": null }`

`POST /v1/libraries`
```json
{ "name": "My skills", "description": "optional", "owner": { "type": "user" }, "clientMutationId": "lib-1" }
```
Team: `"owner": { "type": "team", "id": "<teamId>" }` (caller must be an effective team owner, MFA).
→ `201 { "library": LibrarySummary }`. Limits: name 1–120, description ≤ 2000, 100 active libraries per owner scope (`LIBRARY_LIMIT_EXCEEDED`).

`GET /v1/libraries/:libraryId` → `200 { "library": LibrarySummary }`

`PATCH /v1/libraries/:libraryId`
```json
{ "expectedRevision": 1, "name": "Renamed", "description": "..." }
```
→ `200 { "library": LibrarySummary }`

`DELETE /v1/libraries/:libraryId?expectedRevision=2`
→ `200 { "library": { "id": "...", "status": "deleted" }, "effects": { "entriesRemoved": 3, "bindingsMarkedCurationUnavailable": 1, "subscriptionsEnded": 2, "candidatesCancelled": 1 } }`
Soft delete. Registry skills, releases, installs, and provenance stay intact. Bindings keep their last adopted pin (`curation-unavailable`). No restore route in this release.

```ts
LibrarySummary = {
  id: string; name: string; description: string;
  owner: { type: "user"; id: string } | { type: "team"; id: string; name: string };
  status: "active";
  revision: number;
  access: { role: "owner" | "curator" | "member"; canWrite: boolean; canTrackSources: boolean; canImport: boolean };
  subscription: { events: LibraryEventKind[]; createdAt: string } | null;
  createdAt: string; updatedAt: string;
}
```
`canTrackSources`/`canImport` are true only for personal libraries.

### 4.2 Entries

`GET /v1/libraries/:libraryId/entries?kind=source|skill` → `200 { "entries": LibraryEntry[], "nextCursor": null }`

`POST /v1/libraries/:libraryId/entries` — save a reference. No import, no install, no schedule.

Source reference (resolves repository identity once through the fixed GitHub adapter):
```json
{ "kind": "source", "url": "https://github.com/acme/agent-skills/tree/main/skills", "ref": { "kind": "default-branch" }, "clientMutationId": "src-1" }
```
- Accepted URL forms: `https://github.com/{owner}/{repo}`, `.../tree/{ref}/{path}`, `.../blob/{ref}/{path}/SKILL.md`, optional `.git` suffix. `http:`, credentials, ports, other hosts, query strings with credentials, and `..` segments return `400 SOURCE_URL_UNSUPPORTED`.
- A `tree`/`blob` ref in the URL becomes `{ "kind": "branch", "value": ref }` unless `ref` is supplied. A `blob/.../SKILL.md` URL selects its directory as `path`.
- `ref.kind`: `default-branch` | `branch` | `tag` | `commit` (40-hex) | `latest-release` | `tag-prefix` (value = prefix; highest SemVer suffix, optional leading `v`).
- The entry title is `fullName` or `fullName/path`, cut to 200 characters; `source.path` keeps the full path (≤ 1024).
- Optional `"path": "skills"` narrows discovery. Default excluded directories (tests, fixtures, examples, testdata, node_modules, dist, build, .github, vendor) are left out of default discovery but can be selected explicitly.

Registry reference:
```json
{ "kind": "skill", "slug": "release-notes-helper" }
```
The skill must be readable by the caller and, for a team library, visible to the team.
→ `201 { "entry": LibraryEntry }` (duplicate active source+path+ref or duplicate slug in the same library → `409 LIBRARY_ENTRY_DUPLICATE`; 500 entries per library → `LIBRARY_LIMIT_EXCEEDED`).

`GET /v1/library-entries/:entryId` → `200 { "entry": LibraryEntry }`

`DELETE /v1/library-entries/:entryId`
→ `200 { "entry": { "id": "...", "status": "removed" }, "effects": { "bindingsMarkedCurationUnavailable": 1, "candidatesCancelled": 2, "trackingStopped": true } }`
Removing a `source` entry stops its track and cancels its `ready-for-review`/`blocked` candidates. Imported `skill` entries and registry releases remain.

```ts
LibraryEntry = {
  id: string; libraryId: string; kind: "source" | "skill"; status: "active"; revision: number;
  title: string;
  source?: {
    provider: "github"; repositoryId: string; fullName: string; url: string;
    path: string; ref: { kind: LibrarySourceRefKind; value?: string };
    defaultBranch: string | null; license: string | null; archived: boolean;
  };
  tracking?: {
    mode: "off" | "manual" | "daily" | "weekly";
    health: LibrarySourceHealth;           // see §5
    nextCheckAt: string | null; lastAttemptAt: string | null; lastSuccessfulCheckAt: string | null;
    lastErrorCode: string | null; attemptCount: number;
    lastGoodSnapshot: { id: string; commit: string; upstreamLabel: string | null; observedAt: string } | null;
    workerAvailable: boolean;              // false when no source worker runs on this instance
    identityChange: {                      // rename/transfer detected for THIS entry, not yet acknowledged
      acknowledgedFullName: string;        // name the owner accepted (also source.fullName)
      observedFullName: string;            // name the provider now reports for the same repository id
      observedUrl: string;
    } | null;
  };
  skill?: {
    slug: string; nativeName: string | null;
    sourceEntryId: string | null; sourcePath: string | null; lineageId: string | null;
    ownership: { type: "user"; isCaller: boolean };   // personal ownership dependency, shown in team libraries
  };
  adoption: LibraryAdoption | null;
  createdAt: string; updatedAt: string;
}
```

### 4.3 Tracking and checks (personal `source` entries)

`PATCH /v1/library-entries/:entryId/tracking`
```json
{ "expectedRevision": 2, "mode": "daily", "acknowledgeIdentityChange": false }
```
→ `200 { "entry": LibraryEntry }`. `daily`/`weekly` set `nextCheckAt` from the current time. `off`/`manual` clear it. Team libraries → `409 LIBRARY_TRACKING_UNSUPPORTED`.

Repository identity is kept per entry. `source.fullName`/`source.url` are the name this entry's owner accepted; another user saving or checking the same repository never changes them. When a check, discovery or preview finds a different name for the same repository id, the entry gets `tracking.identityChange`, `health: "identity-change-review"` and a new `revision`. Checks also emit one `source-health-changed` inbox item; discovery and preview report the pending review directly without an inbox item. Until the owner acknowledges it:
- discovery and preview return `409 SOURCE_IDENTITY_CHANGED`, checks return `outcome: "failed"`, `errorCode: "source-identity-changed"`, and the worker skips the entry;
- `mode: "off"` or `"manual"` is accepted and the review stays (health remains `identity-change-review`);
- `mode: "daily"`/`"weekly"` without acknowledgement → `409 SOURCE_IDENTITY_CHANGED`.

Acknowledge with `{ "expectedRevision": <current>, "mode": "...", "acknowledgeIdentityChange": true }`. It sets `source.fullName` to `identityChange.observedFullName` for this entry only, clears `identityChange` and is audited with the old and new names. An acknowledgement built from an older view fails with `409 LIBRARY_REVISION_CONFLICT`, because detection bumps the revision. `acknowledgeIdentityChange: true` with nothing pending → `409 IDENTITY_ACKNOWLEDGEMENT_NOT_APPLICABLE`. If a later check finds the acknowledged name again, the pending review clears.

`POST /v1/library-entries/:entryId/checks` → `200 { "check": SourceCheckResult }`
Runs one bounded check now (60 s deadline) under the same lease as the worker. A check reads remote state and never changes adoption. Concurrent check → `409 SOURCE_CHECK_IN_PROGRESS`.

```ts
SourceCheckResult = {
  outcome: "unchanged" | "changed" | "failed";
  health: LibrarySourceHealth;
  snapshot: SourceSnapshotSummary | null;      // null when unchanged or failed
  candidateIds: string[];                      // new candidates only (one per affected imported skill)
  eventKinds: LibraryEventKind[];              // new, deduplicated events
  errorCode: string | null;                    // e.g. "rate-limited", "inventory-incomplete"
  retryAfterSeconds: number | null;
  nextCheckAt: string | null;
}
```
Unchanged commits are coalesced (no snapshot, no event). A new commit that changes no selected skill file creates a snapshot but no candidate. A changed support file creates a candidate for every lineage that includes it. Tracking proposes the same bytes for a lineage once: bytes that already have a pending, accepted or **ignored** candidate create nothing on later checks (explicit previews are not affected). Removal, rename and new-root events are keyed by the upstream transition, so a retried check does not repeat them.

Scheduled checks claim one entry at a time under a 120 s lease and renew it before each write phase. Renewal alone does not fence. Every check-owned write checks the lease id under the entry row lock, inside the write's own transaction:
- the snapshot;
- the root-change events (one transaction);
- each tracked candidate together with its `candidate-*` inbox item;
- the identity-change pending name together with its alert;
- the result (health, schedule, last good snapshot) together with its health alert.

A takeover that commits before one of these writes makes it roll back. A takeover that starts during it waits until it commits. No transaction spans provider I/O. The check uses the lease id as the fencing token: a lease that expired but was not claimed still belongs to its check, and the next renewal, which does check expiry, stops that check.

A check that finds its lease taken stops, writes nothing further and returns `outcome: "failed"`, `errorCode: "lease-lost"`. Health, schedule and last good snapshot change only if the check still holds the lease when it finishes. Snapshots, events and candidates it committed while it held the lease stay, and a retry or the winning check reuses them: a snapshot of the same commit is reused, root-change events are recomputed from the unchanged last good snapshot and deduplicated by key, and a candidate written by tracking always has its inbox item, so skipping already-proposed bytes never hides a tracked proposal.

Lock order in these transactions: the library row (`FOR KEY SHARE`), the entry (`FOR NO KEY UPDATE`), the lineage advisory lock, then candidate rows. Library deletion (library, entries, candidates) and entry removal (entry, candidates) lock in the same direction. Imports never lock the source entry; their foreign-key checks take `KEY SHARE`, which `NO KEY UPDATE` does not block. Previews and discovery take no lease; discovery's snapshot write uses the same entry lock without the lease check.

Not fenced: the shared `library_sources` row that a check upserts after it reads the repository. Every save, discovery and check of that repository writes this row without a lease, so it is last-writer-wins metadata. A stale check can overwrite the default branch, license, archived flag and canonical name and URL with the values it observed during its run, and can append that URL to the URL history. The next save, discovery or check of the repository by anyone refreshes the row. The stale write cannot change entry identity (acknowledged and pending names live on the entry), snapshots, candidates, events, schedule or release provenance. Previews use the live repository's license identifier or an explicit reviewed mapping; an unknown live identifier never falls back to cached metadata.

### 4.4 Discovery, preview and import (personal `source` entries)

`POST /v1/library-entries/:entryId/discoveries` → `200 { "discovery": SourceDiscovery }`
```ts
SourceDiscovery = {
  snapshot: SourceSnapshotSummary;
  complete: boolean;                           // false when tree truncated or > 10,000 paths
  skills: DiscoveredSkillRoot[];               // default-selected roots
  excluded: DiscoveredSkillRoot[];             // roots under default-excluded directories
  limits: { maxInventoryPaths: 10000; maxPackageFiles: 500; maxPackageTextBytes: 1048576 };
}
DiscoveredSkillRoot = {
  path: string;                 // e.g. "skills/ce-plan"; "" for repository root
  directoryName: string;
  fileCount: number; byteCount: number;
  blockers: LibraryFinding[];   // tree-level (symlink, submodule, limits, nested root, plugin packaging)
  lineage: { id: string; slug: string; latestVersion: string | null } | null;   // existing import by caller
  excludedReason?: "default-excluded";
}
SourceSnapshotSummary = {
  id: string; sequence: number; commit: string; treeSha: string;
  ref: { kind: LibrarySourceRefKind; value?: string }; upstreamLabel: string | null;
  orderStatus: "initial" | "ahead" | "identical" | "unverified"; complete: boolean; observedAt: string;
}
```
A snapshot is immutable. When the entry's newest snapshot is complete and has the same commit, tree, ref, upstream label and release, it is reused (repeated discovery, retried checks) and no tree request is made. An upstream that returns to an older commit gets a new snapshot. `SourceSnapshotSummary.orderStatus` compares with the entry's last good snapshot and is informational; imports use `LibraryCandidate.orderStatus` (§4.4 import).
A tree file without a reported size blocks its skill root with a blocking `inventory-incomplete` finding (path = the file) before any bytes are fetched.

`POST /v1/library-entries/:entryId/previews`
```json
{
  "snapshotId": "<from discovery>",
  "paths": ["skills/ce-plan", "skills/long-description"],
  "mappings": { "skills/long-description": { "summary": "Reviewed short summary", "title": "Optional", "license": "Optional SPDX" } }
}
```
→ `200 { "preview": { "id": "<previewId>", "snapshot": SourceSnapshotSummary, "expiresAt": "...+24h", "candidates": LibraryCandidate[] } }`
- One candidate per selected path. Up to 20 paths per preview.
- Fetches only selected files and repository-root notices at the frozen commit; verifies each blob against its Git SHA; holds exact bytes until `expiresAt`.
- Blocked candidates have `state: "blocked"`, `packageDigest: null` and no held bytes. Saving the entry still succeeds.
- A repeated preview with identical snapshot/path/mapping returns the same active candidate.

`GET /v1/library-entries/:entryId/candidates?state=ready-for-review` → `200 { "candidates": LibraryCandidate[], "nextCursor": null }`

`GET /v1/library-candidates/:candidateId?includeContent=true` → `200 { "candidate": LibraryCandidate }` (with `files[].content` while held).

`POST /v1/library-candidates/:candidateId/import`
```json
{
  "expectedPackageDigest": "<candidate.packageDigest>",
  "release": { "classification": "unclassified" },
  "acknowledgeUnverifiedOrder": { "reason": "Upstream force-pushed; intentional revert" },
  "clientMutationId": "imp-1"
}
```
`release` is required (`400 IMPORT_RELEASE_METADATA_REQUIRED`). Either `{ "classification": "unclassified" }` (maps to `changeKind: "breaking"`, `requiresUserAction: true`, conservative notes) or an explicit reviewed classification:
```json
{ "release": { "changeKind": "fix", "requiresUserAction": false, "releaseNotes": "Reviewed: typo fixes in guide.md" } }
```
`acknowledgeUnverifiedOrder` is required and accepted only when `candidate.orderStatus` is `"unverified"`, and is recorded in provenance. `candidate.orderStatus` compares the candidate's commit with the commit the lineage last imported (`"initial"` before the first import), so a force-push that discards the imported commit is `"unverified"` even when it is ahead of the entry's first snapshot. Missing acknowledgement → `409 CANDIDATE_ORDER_UNVERIFIED`; acknowledgement on any other order status → `409 ORDER_ACKNOWLEDGEMENT_NOT_APPLICABLE`.
→ `202 { "candidate": LibraryCandidate, "entry": LibraryEntry, "submission": { "id", "slug", "version", "reviewStatus", "securityStatus" }, "scan": { "status", "findingCount", "findings" } }`
Replay of an accepted candidate with the same digest → `200` with `"replayed": true`.
Submission goes through normal validation, scans and the review queue. The created registry skill is `private`; later revisions keep the lineage skill's current visibility. Provenance is written in the same transaction as the submission.

`POST /v1/library-candidates/:candidateId/ignore` → `200 { "candidate": LibraryCandidate }`

```ts
LibraryCandidate = {
  id: string; sourceEntryId: string; skillEntryId: string | null; previewId: string | null;
  lineage: { id: string; slug: string; nativeName: string | null };
  state: "ready-for-review" | "blocked" | "accepted" | "ignored" | "superseded" | "expired";
  origin: "preview" | "tracking";
  sourcePath: string;
  snapshot: SourceSnapshotSummary;
  orderStatus: "initial" | "ahead" | "identical" | "unverified";   // vs the lineage's last imported commit
  expectedVersion: string;                     // importer revision, e.g. "0.0.2"
  expectedPriorRevision: number;
  sourceDigest: string;                        // selected upstream files + notices
  packageDigest: string | null;                // == submitted artifact sha256
  files: Array<{ path: string; sha256: string; bytes: number; origin: "upstream" | "repository-notice" | "generated";
                 sourcePath: string | null; gitBlobSha: string | null; content?: string }>;
  mapping: { slug: string; title: string; summary: string; license: string; visibility: VisibilityScope;
             platforms: Array<{ name: string; installTarget: string; status: "supported" }>;
             nativeName: string | null; transforms: LibraryTransform[] };
  release: { suggested: { classification: "unclassified"; changeKind: "breaking"; requiresUserAction: true; releaseNotes: string } };
  findings: LibraryFinding[];
  changes: { added: string[]; changed: string[]; removed: string[] } | null;   // vs lineage head
  registry: { submissionId: string; slug: string; version: string; reviewStatus: ReviewStatus; securityStatus: SecurityStatus;
              publishedAt: string | null; attestation: "private-self-reviewed" | "instance-reviewed" | null;
              elevationRequestedAt: string | null } | null;
  expiresAt: string; createdAt: string; decidedAt: string | null;
}
LibraryFinding = { code: LibraryFindingCode; severity: "blocking" | "warning" | "info"; message: string; path?: string }
LibraryTransform = { kind: "generated-manifest" | "generated-import-manifest" | "include-repository-notice" | "reviewed-metadata-mapping" | "platform-mapping" | "normalize-runtime-name";
                     path?: string; detail?: string;
                     // normalize-runtime-name only:
                     originalPath?: string; originalSha256?: string; transformedSha256?: string; originalName?: string | null; runtimeName?: string }
```
Package layout (importer `myskills-library-importer/2`):
- Support files at their paths relative to the skill root, byte-identical.
- Runtime `SKILL.md`: the upstream file with only its top-level `name` value set to the registry slug. Comments, other frontmatter, body and line endings are unchanged; a quoted name keeps its quote style. Without a `name`, one `name: <slug>` line is inserted after the opening `---`, using that line's line ending. A name that already equals the slug is not rewritten. `files[]` lists it with `origin: "generated"`, `sourcePath` = the upstream `SKILL.md` path and `gitBlobSha: null`: it never claims the upstream blob.
- `myskills-source-skill.txt`: the exact upstream `SKILL.md` bytes (`origin: "upstream"`, upstream `gitBlobSha`). It is a `.txt` file at the package root, so it is inspectable and never a second skill.
- Repository-root `LICENSE*`/`NOTICE*`/`COPYING*` at the package root (or under `upstream-notices/` on a name clash), generated `skill.json` (strict MySkills manifest) and generated `myskills-import.json` (provenance).

Every ready candidate carries one `normalize-runtime-name` transform: `path: "SKILL.md"`, `detail: "name-replaced" | "name-inserted" | "name-unchanged"`, `originalPath: "myskills-source-skill.txt"`, `originalSha256` (upstream bytes), `transformedSha256` (runtime bytes; equal to `originalSha256` for `name-unchanged`), `originalName` (frontmatter name or `null`) and `runtimeName` (the slug). The transform is in `mapping.transforms`, in `myskills-import.json` and in the immutable provenance `transforms`. In `myskills-import.json` and provenance `files`, the upstream `SKILL.md` blob is listed at `path: "myskills-source-skill.txt"` with its `sourcePath`; no entry has `path: "SKILL.md"`. `sourceDigest`, `headFiles` and `changes` stay upstream-derived; `files[].sha256`/`bytes` and `packageDigest` describe the packaged bytes.

Blocking: an upstream `skill.json`/`skill-manifest.json`/`ai-skill.json`/`myskills-import.json` at the root, or `myskills-source-skill.txt` as a file or directory in any letter case, blocks the root at discovery (`manifest-path-collision`). The preserved copy counts toward limits: the file limit adds 3 package files (two generated plus the preserved original) and the byte limit adds the `SKILL.md` size again, before any blob is fetched. The scanner checks the runtime `SKILL.md`, the preserved original and every other file.

Native frontmatter check (so every ready package passes the Codex install check in `apps/cli/src/codex-workspace.ts`). MySkills does not interpret YAML beyond a small checked subset and fails closed otherwise:
- `invalid-native-name`: `name` declared twice, or not a single-line plain, single-quoted or double-quoted text value (block scalar, multi-line, flow, anchor, alias, tag, empty, or a plain value the YAML core schema reads as null, boolean or number), or the slug cannot be written.
- `native-frontmatter-unsupported`: a UTF-8 byte order mark (Codex needs `---` first); no frontmatter or no closing `---` line; frontmatter longer than 32,768 characters after the edit; a missing, empty, non-text or over-1,024-character `description` (a reviewed summary mapping does not fix this; descriptions are never rewritten); a tab-indented, control-character or stray carriage-return line; a top-level line that is not a plain `key: value` entry or a column-0 comment; a duplicate key; a plain value containing `: ` or starting with a YAML indicator; nesting deeper than one level of `key: value` or `- value`.

Registry slug: `<readable-prefix>-<10-char opaque suffix>` (≤ 64 chars), allocated per lineage (owner + source + path + ref line). The source identity is kept in `mapping.nativeName` and `lineage.nativeName`: the frontmatter `name`, or the directory name when there is none; if it is longer than 200 characters or not a single printable line, the candidate is blocked with `invalid-native-name`. `mapping.slug` is the runtime name. Descriptions and invocation text are never rewritten.

### 4.5 Private self-review (admin-controlled)

`POST /v1/library-candidates/:candidateId/self-review`
```json
{ "artifactSha256": "<registry artifact sha256 == packageDigest>", "reason": "optional" }
```
→ `200 { "candidate": LibraryCandidate, "release": { "slug", "version", "artifactSha256", "publishedAt", "attestation": "private-self-reviewed" } }`
Rechecked in one transaction: setting enabled; caller is the import owner; registry skill owned by caller and `private` with no team/user/organization grants; submission `unreviewed`; scans passed with zero findings; exact artifact hash. Result: release is approved and published **only** for the owner; a distinct `private-self-review` attestation records the real actor and hash. No maintainer approval is recorded.
Errors: `403 PRIVATE_SELF_REVIEW_DISABLED`, `409 PRIVATE_SELF_REVIEW_SCOPE_INVALID` (not private / grants / not owner-owned skill), `409 PRIVATE_SELF_REVIEW_SCAN_NOT_CLEAN`, `409 SUBMISSION_NOT_REVIEWABLE`, `409 ARTIFACT_HASH_MISMATCH`, `403 MFA_VERIFICATION_REQUIRED`.

`POST /v1/library-candidates/:candidateId/instance-review-requests` → `200 { "request": { "submissionId", "requestedAt" } }` (owner asks reviewers to elevate a self-reviewed release).

Widening guard (canonical, not only library routes): `PUT /v1/skills/:slug/sharing` and the deprecated visibility path in `PUT /v1/skills/:slug` return `409 SELF_REVIEWED_RELEASE_REQUIRES_INSTANCE_REVIEW` when the new visibility is not `private` and any non-deleted version of the skill has a self-review attestation without instance elevation. This applies to admins too. Architectures, organization grants, team targets and MCP already exclude `private` releases.

Instance elevation (reviewers):
- `GET /v1/review/self-reviewed-releases` → `{ "releases": [{ "submissionId", "slug", "version", "artifactSha256", "selfReviewedAt", "elevationRequestedAt" }] }` (only releases whose owner requested elevation)
- `GET /v1/review/self-reviewed-releases/:submissionId/bundle` → package JSON with header `x-myskills-artifact-sha256`
- `POST /v1/review/self-reviewed-releases/:submissionId/elevate` `{ "artifactSha256": "...", "reason": "optional" }` → `{ "release": { "slug", "version", "artifactSha256", "attestation": "instance-reviewed" } }`

### 4.6 Admin library settings

`GET /v1/admin/library-settings` → `200 { "settings": { "privateSelfReviewEnabled": false, "updatedAt": null }, "worker": { "configured": true, "overdueTrackCount": 0, "oldestOverdueCheckAt": null } }`

`PUT /v1/admin/library-settings` `{ "privateSelfReviewEnabled": true, "reason": "Pilot" }` → `200 { "settings": {...} }`. Audited as `admin.library_settings.update`. Default after migration: disabled. Disabling blocks new self-reviews; existing self-reviewed private releases stay readable by their owner.

### 4.7 Adoption

`POST /v1/library-entries/:entryId/adoptions` (`skill` entries only)
```json
{ "version": "0.0.1", "artifactSha256": "<release artifact sha256>", "expectedCurrentAdoptionId": null, "reason": "optional" }
```
→ `201 { "adoption": LibraryAdoption, "entry": LibraryEntry }`
Requires an approved, published, scan-passed, readable release with the exact hash; for team libraries the release must be visible to the team; for imported entries the release must carry provenance for the entry's lineage; self-reviewed releases only in the owner's personal library. Errors: `422 LIBRARY_RELEASE_NOT_ADOPTABLE` (pending/unpublished/wrong hash/no provenance), `422 LIBRARY_RELEASE_NOT_AUTHORIZED` (scope cannot read it), `409 LIBRARY_ADOPTION_CONFLICT` (`expectedCurrentAdoptionId` stale, `details.currentAdoptionId`).

`GET /v1/library-entries/:entryId/adoptions` → `200 { "adoptions": LibraryAdoption[] }` (append-only history, newest first)

```ts
LibraryAdoption = { id: string; entryId: string; slug: string; version: string; artifactSha256: string;
  predecessorAdoptionId: string | null; attestation: "private-self-reviewed" | "instance-reviewed";
  adoptedBy: { id: string }; reason: string; adoptedAt: string }
```

### 4.8 Resolution for standalone CLI pins

`GET /v1/library-entries/:entryId/resolution` (`libraries:read` + normal release read)
```json
{ "resolution": { "state": "adopted", "entryId": "...", "libraryId": "...", "slug": "ce-plan-k3x9m2p7qd", "version": "0.0.2",
                  "artifactSha256": "...", "adoptionId": "...", "adoptedAt": "..." } }
```
Other states: `{ "state": "no-adoption", entryId, libraryId, slug }` and `{ "state": "adoption-unavailable", entryId, libraryId, slug, version }` (adopted release no longer readable).
`404 LIBRARY_ENTRY_NOT_FOUND` when the entry or library is deleted or the caller lost access. **CLI contract:** on 404 or `adoption-unavailable`, keep the installed pin and report `curation-unavailable`; never fall back to registry latest. Install/update only the exact `version` + `artifactSha256` returned.

### 4.9 Connected-target bindings and Updates

`POST /v1/library-entries/:entryId/bindings` (session + MFA; caller must be allowed to change the target's update policy)
```json
{ "targetId": "<architecture target id>", "replaceConflicting": false }
```
→ `201 { "binding": LibraryBinding }`. The install key is `(targetId, entry skill slug)`. A second active binding for the same key with a different adopted version → `409 BINDING_VERSION_CONFLICT` unless `replaceConflicting: true` (detaches the others, recorded). Identical adopted versions share the key.

`GET /v1/library-entries/:entryId/bindings` → `{ "bindings": LibraryBinding[] }`
`DELETE /v1/library-bindings/:bindingId` (session + MFA) → `{ "binding": LibraryBinding }` (explicit detach; restores ordinary registry evaluation for that key).

```ts
LibraryBinding = { id: string; entryId: string; libraryId: string; targetId: string; slug: string;
  status: "active" | "curation-unavailable" | "detached"; pinnedVersion: string | null; createdAt: string; updatedAt: string }
```

Existing routes change additively:
- `GET /v1/architecture-targets/:id/updates` items gain `library?: { state: "adopted" | "curation-unavailable" | "binding-version-conflict"; entryIds: string[]; adoptedVersions: string[] }`. The adoption is applied as an exact-version pin constraint (`pinnedVersion`) together with all existing target/organization constraints. Approved-but-unadopted releases are therefore not offered. `curation-unavailable` pins the last adopted version (or installed version); conflicting adoptions yield the existing `policy-pin-conflict` blocker.
- `POST /v1/architecture-targets/:id/operations` and `/v1/target-operations/batch`: install/update to a version other than the current adoption → `409 TARGET_OPERATION_LIBRARY_ADOPTION_MISMATCH`; unavailable curation → `409 TARGET_OPERATION_LIBRARY_CURATION_UNAVAILABLE`; conflict → `409 BINDING_VERSION_CONFLICT`. Rollback remains an explicit local recovery action. Claim, advance and receipt recheck the binding and skip or fail with `TARGET_OPERATION_POLICY_CHANGED`.

### 4.10 Subscriptions and inbox (in-app only)

`PUT /v1/libraries/:libraryId/subscription` `{ "events": ["candidate-ready", "adoption-changed"] }` (omit `events` for all kinds) → `200 { "subscription": { "events": [...], "createdAt": "..." } }`
`DELETE /v1/libraries/:libraryId/subscription` → `200 { "subscription": null }`
Subscribing requires current read access. Membership alone is never consent.

`GET /v1/library-inbox?unread=true&limit=50&cursor=` → `200 { "items": LibraryInboxItem[], "nextCursor": null, "unreadCount": 3 }`
`POST /v1/library-inbox/read` `{ "eventIds": ["..."] }` → `200 { "updated": 1 }`

```ts
LibraryInboxItem = { id: string; kind: LibraryEventKind; libraryId: string; libraryName: string;
  entryId: string | null; entryTitle: string | null; candidateId: string | null; version: string | null; path: string | null;
  createdAt: string; readAt: string | null }
```
Delivery rules: only current subscribers who can read the library now; curator-audience events (`candidate-*`, `new-skill-discovered`, `skill-removed`, `skill-renamed-suggested`, `source-health-changed`) only to current curators; entry events only if the caller can read the entry's release. Events are deduplicated by semantic key (one item per retry). `unreadCount` counts only authorized items in the newest 200 events. No email or external channel.

## 5. Enumerations (exported from `@myskills-app/core`)

- `librarySourceRefKinds = ["default-branch", "branch", "tag", "commit", "latest-release", "tag-prefix"]`
- `libraryTrackingModes = ["off", "manual", "daily", "weekly"]`
- `librarySourceHealthStates = ["not-tracked", "healthy", "checking", "rate-limited", "access-lost", "unavailable", "archived", "identity-change-review", "paused"]`
- `libraryCandidateStates = ["ready-for-review", "blocked", "accepted", "ignored", "superseded", "expired"]`
- `libraryEventKinds = ["candidate-ready", "candidate-blocked", "new-skill-discovered", "skill-removed", "skill-renamed-suggested", "source-health-changed", "adoption-changed"]`
- `libraryFindingCodes = ["unsupported-symlink", "unsupported-submodule", "unsupported-lfs-pointer", "unsupported-binary", "limit-exceeded", "unresolved-dependency", "cross-root-dependency", "license-review-required", "metadata-mapping-required", "manifest-path-collision", "nested-skill-root", "plugin-package-unsupported", "invalid-native-name", "external-reference", "host-capability-review", "inventory-incomplete", "skill-root-missing", "package-scan-blocking", "package-scan-warning", "unsupported-path", "native-frontmatter-unsupported"]` (`package-scan-blocking`/`package-scan-warning` carry the existing package scanner results in the preview; blocking scan results make the candidate `blocked`, warnings keep it importable but rule out self-review; `native-frontmatter-unsupported` is described in §4.4)
- `libraryTransformKinds = ["generated-manifest", "generated-import-manifest", "include-repository-notice", "reviewed-metadata-mapping", "platform-mapping", "normalize-runtime-name"]`
- `LIBRARY_ORIGINAL_SKILL_PATH = "myskills-source-skill.txt"`
- `LIBRARY_LIMITS = { maxLibrariesPerOwner: 100, maxEntriesPerLibrary: 500, maxInventoryPaths: 10000, maxPreviewPaths: 20, maxDiscoveredRoots: 200, previewTtlHours: 24, trackingCandidateTtlDays: 7, checkDeadlineMs: 60000, maxCheckAttempts: 5, maxSourceOperationsPerHour: 10 }`

Core types: `LibraryOwnerReference`, `LibrarySummary`, `LibraryEntry`, `LibraryEntrySource`, `LibraryEntryTracking`, `LibraryEntrySkill`, `LibraryAdoption`, `LibraryBinding`, `LibraryCandidate`, `LibraryCandidateFile`, `LibraryFinding`, `LibraryTransform`, `SourceSnapshotSummary`, `SourceDiscovery`, `DiscoveredSkillRoot`, `SourceCheckResult`, `LibraryEntryResolution`, `LibraryInboxItem`, `LibrarySubscription`, `LibraryAdminSettings`, `LibraryImportReleaseInput`, `LibraryUpdateItemLibraryState`. Helpers: `parseGithubSourceUrl(url)`, `libraryImportReleaseMetadata(input, context)`, `isDefaultExcludedSourcePath(path)`.

## 6. Error codes

| Status | Code |
|---|---|
| 400 | `INVALID_REQUEST_BODY` (also wrong entry kind for an action), `INVALID_PAGE_CURSOR`, `INVALID_SKILL_SLUG`, `SOURCE_URL_UNSUPPORTED`, `SOURCE_REF_INVALID`, `IMPORT_RELEASE_METADATA_REQUIRED`, `INVALID_RELEASE_METADATA`, `LIBRARY_PREVIEW_SELECTION_INVALID` |
| 401 | `AUTHENTICATION_REQUIRED` |
| 403 | `API_TOKEN_SCOPE_REQUIRED`, `SESSION_AUTH_REQUIRED`, `MFA_VERIFICATION_REQUIRED`, `ADMIN_ROLE_REQUIRED`, `TEAM_OWNER_REQUIRED` (team library create), `LIBRARY_WRITE_FORBIDDEN` (reader of a readable library), `SUBMISSION_ROLE_REQUIRED`, `REVIEW_ROLE_REQUIRED`, `PRIVATE_SELF_REVIEW_DISABLED`, `SOURCE_ACCESS_LOST` (repository not publicly readable) |
| 404 | `LIBRARY_NOT_FOUND`, `LIBRARY_ENTRY_NOT_FOUND`, `LIBRARY_CANDIDATE_NOT_FOUND`, `LIBRARY_BINDING_NOT_FOUND`, `SKILL_NOT_FOUND`, `SUBMISSION_NOT_FOUND`, `SOURCE_UNAVAILABLE`, `SOURCE_REF_NOT_FOUND`, `SNAPSHOT_NOT_FOUND` |
| 409 | `LIBRARY_REVISION_CONFLICT`, `CLIENT_MUTATION_ID_CONFLICT`, `LIBRARY_ENTRY_DUPLICATE`, `LIBRARY_TRACKING_UNSUPPORTED`, `SOURCE_CHECK_IN_PROGRESS`, `SOURCE_IDENTITY_CHANGED`, `IDENTITY_ACKNOWLEDGEMENT_NOT_APPLICABLE`, `ORDER_ACKNOWLEDGEMENT_NOT_APPLICABLE`, `SOURCE_REDIRECT_REJECTED`, `PREVIEW_EXPIRED`, `PREVIEW_DIGEST_MISMATCH`, `CANDIDATE_NOT_IMPORTABLE`, `CANDIDATE_SUPERSEDED`, `CANDIDATE_ORDER_UNVERIFIED`, `SLUG_CONFLICT`, `PACKAGE_SLUG_UNAVAILABLE`, `PACKAGE_VISIBILITY_MISMATCH`, `PACKAGE_VERSION_EXISTS`, `PRIVATE_SELF_REVIEW_SCOPE_INVALID`, `PRIVATE_SELF_REVIEW_SCAN_NOT_CLEAN`, `SELF_REVIEW_ELEVATION_NOT_APPLICABLE`, `SUBMISSION_NOT_REVIEWABLE`, `ARTIFACT_HASH_MISMATCH`, `SELF_REVIEWED_RELEASE_REQUIRES_INSTANCE_REVIEW`, `LIBRARY_ADOPTION_CONFLICT`, `BINDING_VERSION_CONFLICT`, `TARGET_OPERATION_LIBRARY_ADOPTION_MISMATCH`, `TARGET_OPERATION_LIBRARY_CURATION_UNAVAILABLE`, `TARGET_OPERATION_POLICY_CHANGED` |
| 413/422 | `LIBRARY_LIMIT_EXCEEDED` (422), `LIBRARY_RELEASE_NOT_ADOPTABLE`, `LIBRARY_RELEASE_NOT_AUTHORIZED`, `INVENTORY_INCOMPLETE`, `PACKAGE_SCAN_BLOCKED`, `PACKAGE_MANIFEST_MISMATCH`, `SOURCE_RESPONSE_TOO_LARGE` |
| 429/503 | `LIBRARY_SOURCE_RATE_LIMITED` (429, per-user source request limit, `retry-after` header and `details.retryAfterSeconds`), `SOURCE_RATE_LIMITED` (429, `details.retryAfterSeconds` or `details.rateLimitResetEpochSeconds`), `SOURCE_TIMEOUT` (503), `SOURCE_PROVIDER_UNAVAILABLE` (503), `SOURCE_INTEGRITY_MISMATCH` (503, fetched bytes did not match the Git blob SHA), `PRIVATE_SELF_REVIEW_UNAVAILABLE` (503, non-Postgres store), `LIBRARY_SERVICE_UNAVAILABLE` (503) |

A manual check that reaches the provider but fails returns `200` with `check.outcome: "failed"`, `check.health` and `check.errorCode` (for example `rate-limited`, `unavailable`, `access-lost`, `inventory-incomplete`, `source-identity-changed`); tracking health and `nextCheckAt` are persisted the same way as scheduled checks. `errorCode: "lease-lost"` means another worker took over the check. Nothing was written after the lease was lost, and the check did not change health, schedule or last good snapshot. Snapshots, events and candidates committed while the check still held the lease remain (§4.3).

`POST /v1/submissions` now rejects client-supplied `provenance`, `sourceImport`, `lineageId`, `attestation`, `selfReview` fields (`400 UNSUPPORTED_SUBMISSION_FIELD`). Existing ordinary submissions to a skill whose owner is `null` (orphaned) now return `409 PACKAGE_SLUG_UNAVAILABLE` instead of assigning ownership.

## 7. Capabilities

`GET /v1/capabilities` adds `capabilities.libraries` (library service configured) and `capabilities.librarySourceTracking` (a source worker runs in this process). Both keys are present only when the library service is configured; treat an absent key as `false`.

## 8. Booting real services with a deterministic source fixture

Production (`apps/api/src/server.ts`) always uses the real HTTPS transport; no environment variable can replace it. `LIBRARY_SOURCE_WORKER=disabled` turns the worker off (default on). Tests and E2E harnesses construct services directly:

```ts
import { buildApp } from "../src/app.js";
import {
  FixtureGithubSource, LibraryService, LibrarySourceWorker, PostgresLibraryStore, PublicGithubSourceProvider,
} from "../src/libraries/index.js";

const github = new FixtureGithubSource();                      // in-memory api.github.com + raw.githubusercontent.com
github.createRepository({ id: 424242, owner: "acme", name: "agent-skills", license: "MIT", defaultBranch: "main",
  files: { "skills/ce-plan/SKILL.md": "---\nname: ce-plan\ndescription: Plan work.\n---\n# Plan\n", "LICENSE": "MIT ..." } });
const libraryService = new LibraryService({
  store: new PostgresLibraryStore(db),
  submissions: submissionService,          // existing SubmissionService(PostgresSubmissionStore)
  skillRepository,                          // existing PostgresSkillRepository
  targets: architectureTargetService,       // optional; enables bindings
  sourceProvider: new PublicGithubSourceProvider({ transport: github.transport() }),
  now: () => clock.now(), slugSuffix: (seed) => deterministicSuffix(seed),   // optional, tests only
});
const worker = new LibrarySourceWorker(libraryService, { pollMs: 1000 });  // call worker.runOnce() in tests
const targetOps = new TargetSkillOperationService(opStore, architectureTargetService, submissionService,
  { upgradePolicies, libraryAdoptions: libraryService });
const app = buildApp({ ...existingOptions, libraryService, targetSkillOperationService: targetOps,
  librarySourceLimiter: new MemoryAuthRateLimiter({ maxAttempts: 1000, windowMs: 3_600_000 }) });  // optional; default 10/user/hour
```
Harnesses that make more than 10 provider-backed source requests per user within an hour must pass a larger `librarySourceLimiter` (from `apps/api/src/auth/rate-limit.ts`).
`apps/api/test/library-native-install.pgtest.ts` also listens on loopback (`registryInstanceId` set) and drives the real CLI (`runCli` from `apps/cli/src/cli.ts`) through `codex enroll`, `install --library-entry --workspace`, `codex observe --upload`, `update` and `rollback` against the imported artifact. Its receipt (`LIBRARY_NATIVE_INSTALL_EVIDENCE_PATH`) records filesystem verification only, not host Codex activation.
Fixture mutations (all deterministic; blob SHAs are real Git blob SHAs):
- `github.commit("acme/agent-skills", { branch?: "main", files?: { "path": "text" | null }, binaryFiles?, symlinks? })` returns the new commit SHA (`null` deletes a file).
- `github.tag(fullName, name, { commit?, annotated? })`, `github.release(fullName, { tagName, name?, id? })` (latest release is the last one added).
- `github.rename(fullName, newOwner, newName)` makes the old name answer `301` (the adapter rejects it). A different owner models a transfer.
- `github.commit(fullName, { parent: "<commit sha>", files })` builds on an older commit and moves the branch to it (a force-push when the parent is not the head).
- `github.hideTreeSizes(fullName, ["path"])` omits `size` for those tree entries.
- `github.interceptNext(urlSubstringOrRegExp, async () => { ... })` runs a hook before the next matching request, which then answers normally (used to take a lease over mid-check).
- `github.failNext(urlSubstringOrRegExp, { status, headers?, body? }, times = 1)`, for example `github.failNext(/repositories\/424242$/, { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "<epoch seconds>" } })`.
- `github.requests` lists every URL and header set the adapter sent (useful to prove no `authorization` header and fixed hosts).
The fixture throws for any host other than `api.github.com` and `raw.githubusercontent.com`. The journey test `apps/api/test/library-journey.pgtest.ts` shows a complete boot, including MFA sessions, a team, a companion target and a deterministic clock (`now`) plus `slugSuffix` for repeatable slugs and digests.

Migration: `apps/api/migrations/0032_libraries.sql` (additive). Seed: none required; the journey test creates users, teams, MFA sessions and fixtures itself.
