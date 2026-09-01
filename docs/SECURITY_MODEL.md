# Security Model

Version: 0.2.0-draft
Last updated: 2026-09-01

This security model describes the current public beta controls plus the
partially implemented Phase 2 architecture controls. The companion threat
model in [THREAT_MODEL.md](THREAT_MODEL.md) records attacker goals, trust
boundaries, residual prerelease risks, audit findings, and business-safe
release gates.
Phase 2 controls are source-release evidence; they do not establish a hosted
deployment or a live provider credential path. Source presence is not a
passing production-deployment gate result.

## Main Risks

- Unauthorized users discovering restricted skills.
- Uploaded packages containing secrets, unsafe instructions, harmful scripts, or private data.
- CLI or MCP clients bypassing server-side authorization.
- Provider claims granting roles too broadly.
- Object storage exposing artifacts directly.
- Audit logs leaking tokens, package contents, or private data.
- Organization or child-team membership checks crossing a tenant boundary.
- Architecture graphs leaking restricted release metadata or exposing an
  unauthorized runtime placement.
- Target consent, capability, generation, or adapter identity being stale or
  used to infer a live write.
- Pattern migration losing exposure intent or silently rebinding grants or
  targets.
- A malformed or very large nested graph consuming excessive validator,
  compiler, or renderer resources.
- A target snapshot or diagram being mistaken for canonical desired state and
  causing an unsafe overwrite.

## Required Controls

### Authentication

- Password hashes are never stored on the user record.
- Session tokens are opaque and stored only as hashes.
- API tokens are opaque, scoped, stored only as hashes, and returned in plaintext only once.
- Email verification, password reset, registration invitation, and email-change tokens are opaque, short-lived, single-use, stored only as hashes, and never returned from HTTP responses.
- Production auth action delivery requires Resend or SMTP configuration and an HTTPS `APP_BASE_URL`. SMTP mode additionally requires TLS certificate validation. Local console delivery is rejected in production.
- API token management requires a session; API tokens cannot create, list, or revoke other tokens.
- CLI login tokens are stored by normalized API URL in the platform credential store when available, with a user-only file fallback for unsupported environments or explicit file-token configuration. CLI auth diagnostics report token source and account metadata without printing token values.
- Login uses normalized email lookup and generic invalid-credential denial.
- Existing sessions are denied when the user is no longer active or email verified.
- Login, registration, email verification, password reset, MFA, and action-token confirmation paths are throttled before repeated expensive auth work where applicable. Production uses shared database-backed counters so limits survive API restarts and single-region scale-out; ingress throttles and abuse alerts remain business-safe production hardening.
- Email verification before normal account use.
- Password reset uses generic request responses, including notification delivery failures, and revokes active sessions and API tokens after a successful credential change.
- Rate limits on auth endpoints.
- TOTP MFA uses encrypted authenticator secrets, short-lived challenge tokens, session-bound verification timestamps, and hashed single-use recovery codes.
- Review and publish actions require MFA for owner, admin, and maintainer identities; review-scoped API tokens must be issued from an MFA-verified session.
- User and registration administration requires an MFA-verified owner/admin session; API tokens cannot call admin routes.
- Provider config and claim-to-role mapping administration requires an MFA-verified owner/admin session; API tokens cannot call provider admin routes.
- Provider secrets are not accepted through admin APIs and must stay in deployment secret stores.
- Provider claim mappings cannot grant `owner` or `admin`; those roles remain local/manual.
- User disable/delete revokes the target user's sessions and API tokens and blocks self-lockout.
- Session revocation and all-session logout.
- Admin bootstrap flow that cannot be repeated after setup.

### Authorization

- Server-side authorization for every registry result and artifact delivery.
- API-token access requires both local user roles and explicit token scopes.
- Role checks for submission review, package publication, lifecycle changes, audit, and user management.
- Generic denial responses where existence should not be revealed.
- Tests for allow and deny paths across API, web, CLI, and MCP.

### Visibility migration and compatibility boundary

- Canonical visibility mutations use the authenticated
  `/v1/skills/:slug/sharing` route for visibility and grants. The deprecated
  beta.2 metadata `visibility` field remains accepted only as a compatibility
  shim; it is session-only, requires an MFA-verified session, delegates to the
  sharing boundary, and preserves the complete existing grant set.
- `myskills skills edit --visibility` remains a deprecated compatibility alias
  with the same session/MFA boundary. API tokens cannot widen a skill through
  either deprecated alias. New clients must use `myskills sharing set`.
- Organization visibility now has an explicit organization membership and
  policy boundary. A `personal`, `work`, or `team` label remains a profile
  context, not a tenant or authorization claim.

### Skill Architecture Control Plane

- Architecture ownership is checked by the API/store for every read, revision,
  consolidated preview, and dry-run plan request. Read projections require the
  explicit `architectures:read` scope. Create and revision append are
  session-only, with MFA for privileged/team-owner actions. A profile name such
  as `work` is not an authorization claim.
- The server validates the complete bounded graph before persistence or
  rendering. Duplicate IDs, missing nodes, illegal edges, cycles, orphans, and
  excessive depth/size fail closed.
- Architecture revisions carry exact skill slug/version/SHA-256 references.
  Before an effective desired state is returned, the API binds each reference
  to one server-authorized release and re-runs visibility, lifecycle, review,
  security, publication, and artifact-integrity predicates. It never trusts
  client visibility or falls back to `latest`.
- User/team ownership is separate from organization grants. Team memberships
  are store-resolved. A team attached to an organization is effective only
  while the parent organization is active, has a current policy, and the actor
  has an active membership in that same organization. Organization
  architecture grants are read-only to the receiving organization and are
  managed through an owner/admin-only GET/PUT route. Replacement is bound to
  the expected current architecture revision, policy revision, active
  membership, instance sharing switch, exact grant, release visibility, and
  grant limit. The Postgres adapter rechecks these gates while holding the
  architecture/current-revision lock and writes sanitized audit details;
  organization-safe revision projections exclude private, team-scoped, and
  explicit-user release references.
- Package discovery visibility, architecture ownership, and runtime exposure
  remain separate. A profile defaults to deny and an explicit deny overrides an
  allow at any router or leaf level.
- The consolidated preview derives the profile-filtered graph, diagram, and
  outline from one compilation. Projections include only authorized nodes and
  the metadata needed for the view. The raw response is
  `{ revision?, compiled, graph, outline, diagram, plan? }`, and `graph` and
  `diagram` include escaped Mermaid. Organization-only previews require an
  explicit authorized organization context and omit the raw `revision` object.
  The API does not return SVG; the browser derives SVG from the same graph and
  offers derived JSON/Mermaid downloads.
  SVG labels/attributes and Mermaid labels are escaped; package payloads,
  credentials, local paths, and private inventories are excluded.
- Pattern migration is derive-shell only. Core validation preserves exact
  release references and leaf exposure bindings, rejects invalid mappings, and
  returns a blocked result rather than guessing. The owner/team-owner preview
  and MFA-protected create routes authorize the server-derived candidate, create
  a new shell identity, and persist the first revision plus 0020 lineage in one
  Postgres transaction with idempotent replay. Grants and target bindings are
  never copied or rebound. The injected external release-authorizer preflight
  cannot be made atomic with the database transaction and remains a bounded
  residual race.
- Target records have one explicit owner, consent state, generation, adapter
  and capability digests, and an opaque credential reference. Read capability
  names are allowlisted; `apply`, `rollback`, and `sync.write` must be false or
  absent. Observations are append-only metadata evidence and require current
  consent/generation/digests.
- The target adapter contract is read-only (`observe` and `health`). The Codex
  adapter accepts only an explicit caller-supplied root and selected profile;
  it reads bounded metadata/frontmatter and emits no bodies, prompts, paths,
  URLs, credentials, or package bytes. It is not a live connector.
- Fixture sync planning is review-only. It accepts strict metadata-only
  desired-vs-observed input, returns deterministic operations, and has no live
  target write. The sync control service, in-memory fixture executor, and
  Postgres store can persist and exercise synthetic apply/verify/rollback and
  recovery transitions with approval, leases, fencing, idempotency, and digest
  gates. This is test/control evidence, not a target mutation path; no public
  sync-run route is enabled. Each bounded run allows at most 500 steps and
  2,004 append-only receipts: a 1,002-receipt max-step lifecycle, one full
  apply/verify retry, and two recovery/terminal receipts. Further retries
  require a new bounded run.
- Architecture, target, sync, and migration audit details contain actor,
  revision/digest, target identity, decision, and bounded counts only. They do
  not contain package contents, prompt text, tokens, credentials, raw target
  configuration, URLs, or local paths.
- The web editor and diagram are derived projections. The browser SVG and
  accessible outline use the same authorized compilation; neither is a
  writable source of truth. Durable server-side diagram storage, and CLI/MCP
  write parity for organization grants or migrations, remain deferred.

### Package Safety

- Public search and detail expose only public skills whose skill lifecycle and selected version lifecycle are `approved` or `deprecated`, whose review is approved, whose scan has passed, whose version has a non-null publish timestamp, whose version is not deleted, and whose artifact records are intact.
- Submission intake accepts normalized package text entries or base64 `.zip` archive uploads; the API does not accept server-local paths or URLs.
- Submission intake requires a strict root package manifest file that matches the submitted manifest metadata; publish revalidates stored artifact manifests before release.
- Submission is role-gated to owner, admin, maintainer, and author accounts; owner, admin, and maintainer submitters require MFA verification.
- Server code generates artifact hashes, sizes, content type, and storage keys instead of trusting client-supplied values.
- Object storage keys are internal, opaque, and never returned in public, CLI, web, or MCP responses.
- Object-backed publish and bundle delivery verify stored object bytes against database size and SHA-256 metadata and fail closed on mismatch.
- Blocking scan findings reject the submission before skill, version, or artifact records are created.
- Warning findings remain reviewable but unpublished.
- Submitting a new unreviewed version must not mutate or hide an already approved public release.
- Public bundle delivery uses the same public/lifecycle-approved-or-deprecated/review-approved/passed/published/not-deleted predicate as public search and detail.
- Deprecated releases remain visible for install/export continuity. Unpublished, revoked, archived, and deleted releases are hidden from public search, detail, metadata, and bundle delivery.
- Reject archive traversal, absolute paths, symlinks, encrypted archives, unsupported compression, excessive size, and excessive file count.
- The prerelease scanner blocks known credential/private-key patterns, destructive shell snippets, common encoded shell execution, unsafe prompt-instruction and exfiltration patterns, and unsafe archive structures, and warns on dependency install hooks. Broader fixture-backed scanning for uncommon secrets, generated binaries, and semantic package review remains business-safe production hardening.
- Require maintainer artifact inspection, hash-attested approval, and an explicit publish action before publication.
- Lifecycle actions change server-owned release or skill state only; they do not rewrite immutable artifact hashes or package payloads.
- Store immutable artifact hashes.

### Audit

- Record auth events, access decisions, package delivery, submissions, reviews, lifecycle actions, admin changes, and MCP calls.
- Record lifecycle action reasons without logging package contents, tokens, or credential material.
- Admin registration, user-status mutations, and MCP session authorization decisions write sanitized audit events; admin audit listing is MFA-verified session-only and bounded.
- Redact tokens, cookies, passwords, provider secrets, package contents, and overly long free-text fields.
- Export audit reports with spreadsheet formula injection defenses.

### MCP

- Authenticate every MCP request.
- The API-owned `/v1/mcp/session` check accepts either `skills:read` or
  `architectures:read`; registry tools and architecture projection tools then
  enforce their respective scope.
- Record each API-owned MCP session authorization allow/deny decision before returning the MCP auth result.
- HTTP MCP clients must send scoped API tokens in the `Authorization` header; the HTTP adapter must validate the token before MCP protocol handling and must not use a shared server-side bearer token fallback.
- HTTP MCP deployments must restrict Host and browser Origin headers; non-loopback binds require an explicit allowed-host configuration.
- Default to read-only tools.
- Keep package contents out of MCP results unless a future explicit, audited delivery tool is designed.
- Role-gate maintainer and admin tools.

## Minimum Security Tests

- Unauthenticated access is denied.
- Unauthorized restricted skill search, info, bundle, CLI, and MCP paths do not leak existence or contents.
- Revoked tokens stop working.
- API tokens without the required scope cannot submit or review even when the user has the matching role.
- MFA enrollment, challenge verification, recovery-code replay prevention, MFA-bound review token creation, and review-action MFA enforcement work.
- Package parser rejects unsafe archives.
- Scanner blocks known secret and unsafe-command fixtures.
- Audit sanitizer redacts sensitive fields.
- A newer unreviewed or unsafe version cannot displace a previously approved public release.
- Unpublish, revoke, archive, and delete actions remove releases from every public metadata and bundle path; restore re-enters public paths only when the rest of the safe-release predicate still passes.
- Generic metadata `visibility` and `myskills skills edit --visibility` remain
  deprecated beta.2 compatibility shims. Tests must enforce their
  session/MFA boundary, preserve omitted grants, and prevent API-token
  widening; authenticated sharing and `myskills sharing set` are the canonical
  visibility-management path for new clients. Organization visibility requires
  an active organization member, current policy, and the relevant organization
  grant; a context label alone never grants access.
- Architecture ownership and the explicit `architectures:read` scope deny
  reads, previews, diagrams, and sync plans for unrelated users; create and
  revision append remain session-only.
- Team-owner and team-member decisions use current store-resolved membership;
  an organization-parented team denies access when its parent is inactive or
  the actor lacks active membership in that organization.
- Organization policy revisions are immutable, canonical, digest-bound, and
  checked for same-organization current-policy references. Architecture grant
  replacements are manager-only, current-revision guarded, atomic, and audit
  sanitized; grants created under another organization or stale policy context
  fail closed.
- Nested-graph validation rejects cycles, orphans, invalid router/leaf edges,
  duplicate IDs, excessive depth/size, and malformed exact release digests.
- A package that becomes unavailable or unauthorized after a revision is saved
  fails preview generation without changing the stored revision or substituting
  a different release.
- Profile denials override router or leaf allows, and package visibility never
  acts as a runtime exposure grant.
- SVG/Mermaid renderers escape attacker-controlled labels and do not include
  unauthorized nodes, local paths, package payloads, or credentials.
- Fixture sync planning is deterministic, rejects unknown fixture fields and
  unsupported/conflicting states for automatic action, emits no target write,
  and does not log raw snapshots.
- Target registration requires exact architecture/profile/environment binding;
  observation append additionally requires explicit consent, the current
  generation, and matching adapter/capability digests. Revocation blocks
  refresh and mutation-like behavior while preserving safe audit evidence.
- Read-only adapter conformance rejects `apply`, `rollback`, `write`, and
  other mutation methods. The Codex adapter never follows paths outside its
  explicit root and never emits bodies, prompts, credentials, or raw config.
- Pattern migration rejects invalid mappings and exposure loss, derives a new
  shell candidate, persists the new shell/revision/lineage atomically with
  idempotent replay, and cannot mutate the source revision or rebind a target.
