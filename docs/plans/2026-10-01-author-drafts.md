# Private author drafts (AUTHOR-1)

Date: 2026-10-01
Base: `c74ecd33ce987d24ef5ddf40a0fef98f1a50fc9b`
Status: implementation in progress; release and deployment are separate gates.

Authors need to edit multi-file packages, see intake findings, and correct review feedback without rebuilding an archive for each edit. This slice adds private API-owned workspaces while preserving the existing immutable submission, review, ownership and visibility boundaries.

## Scope and defaults

- Persist personal draft heads and immutable saved text snapshots. Use explicit saves and positive revision preconditions. Return conflicts without overwriting saved content.
- Use the existing package parser, path checks, UTF-8 and text/archive limits. Save incomplete manifests so authors can correct them. Validation and scanning report findings; submission applies the existing hard gates.
- Seed drafts from a new Codex template, held folder/ZIP bytes, an exact permitted release, or the author's own submission. Preserve license, attribution, supporting files and source identity. Public GitHub imports and tracking remain the existing Library workflow.
- Provide file editing, safe preview, manifest assistance, history comparison and restoration as a new saved revision. Recover unsaved edits from actor-and-draft-scoped browser session storage, with explicit recovery and stale-revision handling.
- Keep every saved snapshot. Refuse new work at 100 drafts per author or 100 snapshots per draft with a clear limit error; never silently prune history.
- Bind a saved revision to its immutable submission inside the existing PostgreSQL submission transaction. Retry a completed revision by reading its recorded result. Corrections and subsequent releases require new versions.
- Add thin CLI and MCP draft operations through existing credentials, scopes and API permission checks. A transport fixture does not establish persisted or real-provider acceptance.

This slice does not add draft sharing, team-owned draft workspaces, binary files, private GitHub access, AI drafting, package-manager changes, billing, publication, deployment or provider acceptance claims.

## Ownership and trust boundaries

The API derives the private owner from the authenticated actor. Draft reads use `submissions:read`; writes use `skills:submit`, author permissions and the existing privileged MFA policy. Release/submission seeds require their existing read authority. Reading a release does not grant its slug ownership.

Saved package content is untrusted data. It is never executed. Browser preview renders text safely. File and ZIP intake reuse canonical structural checks. The application registry remains the authority for ownership, visibility, lifecycle, scans, review and immutable artifacts.

The additive `0037_author_drafts.sql` migration and new `drafts` module own workspace state. Submission linking keeps the established sharing → slug/skill → draft lock order. The quality workstream owns background scan changes; authoring reuses its submission service contract.

## Acceptance and verification

Write the failure inventory and strongest-boundary regression scenarios before production code. Verify a representative multi-actor journey through actual PostgreSQL and browser routes: create a multi-file draft, save/reload, correct invalid metadata, inspect scan findings, submit, receive maintainer feedback, and submit a corrected new version. Capture repeatable screenshots and sanitized receipts.

Verify foreign-user isolation, scope/role/MFA enforcement, stale save/validate/submit, concurrent edits/submits, duplicate versions, transaction rollback, source-byte preservation and immutable submitted artifacts. Verify malformed UTF-8, NUL, traversal, filename collisions, ZIP symlinks and resource limits. CLI/MCP transport checks independently cover strict schemas, verbs/paths, revision and release metadata, response/request bounds, and safe errors.

Run supported Node 22/24 repository, parity, PostgreSQL, browser and image checks through the maintained local-CI controller and Windows worker on the exact candidate. Perform focused Node 24 build/type/lint checks first. Request independent source/security review before the draft PR is declared ready. Keep source, fixture, real database, browser, CI, release and deployed evidence distinct.

## Rollback and stop conditions

The migration is additive and leaves released artifact storage unchanged. Reverting route/UI/adapter code disables new authoring access while retaining draft tables for recovery. Do not remove stored workspaces as part of code rollback. Existing archive/CLI submission and review workflows remain available.

Stop and coordinate if a change needs shared ownership, new authentication/scopes, visibility widening, binary intake, a dependency, or altered submission/review semantics. Stop implementation when the AUTHOR-1 acceptance and required checks pass. Merge, publication and deployment retain their explicit approval gates.
