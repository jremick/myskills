# Library Collections and Groups

Status: implemented; local checks passed; final Windows PostgreSQL and full-stack verification pending.

## Outcome and boundaries

Personal and team Libraries own named Collections and Groups. Both inherit the Library's read, curation and MFA rules. Members reference existing skill entries in that Library. Collections show the tracking state and pending changes of their members' existing source lineages. Groups organize related skills and may overlap. Groups are independent of Collections.

This change does not import new roots, expand membership automatically, adopt releases, install packages, create another tracking scheduler, change Library ownership, or add organization ownership. Existing source checks, candidate review, adoption and installation remain explicit operations. There are no dependency or deployment changes.

## Shared contract

- Summary fields: `id`, `libraryId`, `name`, `description`, `status: "active"`, `revision`, `memberCount`, `createdAt`, `updatedAt`. Collection summaries additionally have `tracking`.
- Export `LibraryCollectionSummary`, `LibraryGroupSummary`, `LibrarySelectionMember` and `LibrarySelectionTrackingSummary` from core. Members have `{ entry: LibraryEntry, position: number }`.
- Tracking has `sourceEntryIds: string[]`, `health: LibrarySourceHealth | "mixed"`, `pendingCandidateCount: number`, `lastSuccessfulCheckAt: string | null`, and `nextCheckAt: string | null`. Derive it from currently readable active source entries and authorized candidates. Candidates remain curator-only. No readable source means `not-tracked`.
- Use `/v1/libraries/:libraryId/collections` and `/groups` for list/create. Use `/v1/library-collections/:collectionId` and `/v1/library-groups/:groupId` for get/update/delete, with `/members` for member lists.
- List responses use `{ collections, nextCursor }` or `{ groups, nextCursor }`. Get/update use `{ collection }` or `{ group }`. Create adds `replayed`. Member lists use `{ members, nextCursor }`. Delete returns `{ collection: { id, status: "deleted" } }` or the corresponding `group`.
- List/member pagination follows existing opaque Library cursors and limits. Summary counts include readable members only; unreadable entries and identifying metadata are omitted. Returned member positions must not disclose hidden member counts.
- Create input: `name` (1–120), optional `description` (up to 2000), `memberEntryIds: string[]`, optional `clientMutationId`. Identical create retries replay; changed payload with the same key conflicts.
- Update input: `expectedRevision`, optional `name`, `description`, `memberEntryIds`. Member replacement is an ordered set, not a partial patch. Delete requires `expectedRevision` in the query string.
- Up to 100 active Collections and 100 active Groups per Library; up to 200 members in each. Membership requires active, currently readable skill entries in the same Library. Reject duplicate, inaccessible, removed, source, bundle and foreign-Library IDs generically. Reject fractional, missing, zero, or unsafe revisions.
- Read requires `libraries:read`; write requires `libraries:write` plus existing Library curation and team MFA. Use existing named delegated-action policy across API, CLI and MCP. Authorization and revision checks must hold inside mutation transactions, including create replay and deletion.
- Errors follow existing envelopes: generic entity-specific `*_NOT_FOUND` for unauthorized reads, `LIBRARY_WRITE_FORBIDDEN`, `MFA_VERIFICATION_REQUIRED`, `INVALID_REQUEST_BODY`, entity-specific `*_REVISION_CONFLICT`, `LIBRARY_SELECTION_MEMBER_INVALID`, `LIBRARY_SELECTION_LIMIT_EXCEEDED`, and `CLIENT_MUTATION_ID_CONFLICT`.
- Invalid membership returns a generic `400 LIBRARY_SELECTION_MEMBER_INVALID` without identifying the rejected entry. Per-Library set limits return `422 LIBRARY_SELECTION_LIMIT_EXCEEDED`. Member cursors include the selection revision; an edit invalidates older member cursors and requires a fresh read.
- Deletion removes only the organizational entity and membership. Library entries, source lineage, candidates, adoptions and installs remain unchanged.

## Failure cases before implementation

1. An outsider guesses an ID, or a former member keeps an old link or token.
2. A team reader submits a write, a curator lacks MFA, or a delegated credential lacks the exact action or scope.
3. Membership includes another Library's entry, an unreadable release, a removed entry, a source, a bundle, a duplicate, or too many entries.
4. A list, count, member position, tracking source ID or candidate summary discloses hidden entries after permission revocation.
5. Two editors overwrite membership or deletion with a stale revision; malformed and unsafe revisions pass validation.
6. Concurrent creates bypass limits or idempotency; a retry with different input mutates the first request.
7. A source changes while two Groups overlap and another Library pins a different version; organization operations change adoption, membership, or installs unexpectedly.
8. A source or member is removed; tracking and counts retain stale private metadata, or selection deletion damages underlying state.
9. A large Library hides selectable entries after the first page, or stale browser selection crosses Library boundaries.
10. Keyboard use, loading, empty states, denied writes, network errors or stale-edit recovery leave the UI unusable.
11. CLI/MCP expose a different mutation or omit expected revision, membership replacement, idempotency, pagination or server errors.

## Ownership and validation

Backend owns core contracts, Library service/store/routes, migration and API/Postgres journeys. Frontend owns web client, Library UI and browser journeys. Adapter work owns CLI/MCP, named delegated-action registration and parity inventory. Parent integrates the result, reviews permissions and persistence, coordinates the existing Windows verification controller, and owns publication.

Write meaningful journey coverage before implementation. Prove the multi-source/overlapping-group workflow, independent Library pins, permission loss, stale writes, retries and no unintended adoption with real Postgres. Prove rendered create/edit/delete, Collection tracking, group overlap and error recovery with browser tests. Run the repository gate and capability gate under the declared runtime. Obtain canonical Postgres, browser and CodeQL evidence for the final candidate through the existing Windows controller; keep sanitized repeatable artifacts. Static inventory coverage does not establish real ChatGPT or Claude acceptance.

Stop when the approved workflows and required checks pass. Escalate only a material scope change or missing authority. Hosted deployment and physical authenticator acceptance remain outside this feature change.

## Rollback and operational readiness

The migration adds selection and membership tables. Existing Library entries, lineages and adoptions remain authoritative. An application rollback can stop exposing the new routes and UI while retaining these tables and their records for recovery. Do not drop populated selection tables as part of an application rollback. Normal database backups must include the added tables. Deployment remains with the release owner after the final candidate's required gates pass.
