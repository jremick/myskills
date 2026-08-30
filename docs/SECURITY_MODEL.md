# Security Model

Version: 0.1.0-beta.2
Last updated: 2026-08-30

This security model describes the current public beta controls. The companion threat model in [THREAT_MODEL.md](THREAT_MODEL.md) records attacker goals, trust boundaries, residual prerelease risks, and business-safe release gates.

## Main Risks

- Unauthorized users discovering restricted skills.
- Uploaded packages containing secrets, unsafe instructions, harmful scripts, or private data.
- CLI or MCP clients bypassing server-side authorization.
- Provider claims granting roles too broadly.
- Object storage exposing artifacts directly.
- Audit logs leaking tokens, package contents, or private data.
- Architecture graphs leaking restricted release metadata or exposing an
  unauthorized runtime placement.
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

### Visibility migration (intentional breaking change)

- Generic skill metadata updates reject the `visibility` field. Clients must
  use the authenticated `/v1/skills/:slug/sharing` route for visibility and
  grants.
- `myskills skills edit --visibility` is rejected/removed. The supported CLI
  path is `myskills sharing set`, which uses the authenticated sharing route.
- Organization visibility is unsupported and fails closed. `personal`, `work`,
  and `team` labels are profile contexts, not tenant or authorization claims.

### Skill Architecture Control Plane

- Architecture ownership is checked by the API for every read, revision,
  consolidated preview, and dry-run plan request. Read projections require the
  explicit `architectures:read` scope. Create and revision append are
  session-only. A profile name such as `work` is not an authorization claim.
- The server validates the complete bounded graph before persistence or
  rendering. Duplicate IDs, missing nodes, illegal edges, cycles, orphans, and
  excessive depth/size fail closed.
- Architecture revisions carry a skill slug, semantic version, and SHA-256
  digest. Before an effective desired state is returned, the API binds each
  reference to one exact server-authorized release and re-runs the existing
  server-side visibility, lifecycle, review, security, publication, and
  artifact-integrity predicates for the requesting actor. It never trusts
  client-provided visibility or falls back to `latest`. Organization-scoped
  visibility is unsupported until organization tenancy exists.
- Package discovery visibility, architecture ownership, and runtime exposure
  remain separate. A profile defaults to deny and an explicit deny overrides an
  allow at any router or leaf level.
- The consolidated preview derives the profile-filtered graph, diagram, and
  outline from one compilation. Projections include only nodes the actor may
  see and only the exact metadata needed for the view. The raw response is
  `{ revision, compiled, graph, outline, plan? }`, and `graph` includes
  Mermaid. The API does not return SVG; the browser derives SVG from `graph`.
  SVG labels/attributes and Mermaid labels are escaped; package payloads,
  credentials, local paths, and private inventories are excluded.
- Fixture sync planning is dry-run only in the MVE. It accepts a strict,
  allowlisted metadata-only desired-vs-observed fixture, compares it with
  compiled desired state, and returns reviewable operations; unknown fields,
  package content, credentials, and local paths are rejected. No fixture target
  is inferred; the web submits a fixture only when the user explicitly
  provides it. It has no target write, credential, adapter, apply, or rollback
  path.
- Managed-target detection is read-only and limited to the CLI's own install
  registry. The observation omits install roots and skill paths. Automatic
  resolution uses `architectures:read`, ranks only owner-visible revisions,
  records bounded audit counts, fails closed on tied or weak matches, and
  returns a plan with `canApply: false`. The CLI rejects `--apply`.
- Architecture and sync audit details contain actor, revision, digest, target
  fixture identity, decision, and bounded counts. They do not contain package
  contents, prompt text, tokens, credentials, or raw private target state.
- Team-owned architecture records, organization tenancy, provider-derived
  architecture roles, conditional rules, and live target adapters remain
  disabled until their authorization, consent, retention, and rollback rules
  are implemented and tested.

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
- Generic metadata visibility updates and `myskills skills edit --visibility`
  are rejected/removed; authenticated sharing and `myskills sharing set` are
  the only supported visibility-management path, and organization visibility
  remains unsupported.
- Architecture ownership and the explicit `architectures:read` scope deny
  reads, previews, diagrams, and sync plans for unrelated users; create and
  revision append remain session-only.
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
