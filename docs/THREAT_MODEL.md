# Threat Model

Version: 0.2.0-draft
Last updated: 2026-09-01

## Scope

This model covers the public beta repository and the Phase 2 Skill Architecture
Control Plane implementation slices in the current branch: Fastify API,
Postgres schema,
object-storage artifact boundary, React web app, CLI, stdio/HTTP MCP,
package parser/scanner, architecture tenancy, organization policy/grants,
connected-target metadata and consent, fixture-only sync control, accessible
diagrams, editor revisions, and derive-shell pattern migration.

The documented Phase 1 beta Railway baseline is separate from this work. A
local branch, migration, fixture, or test does not prove Phase 2 behavior is
live there. The findings below describe source and test coverage in this branch;
they do not claim a passing release gate or hosted read-back.

Out of scope for this draft: live target adapters, automatic local discovery,
target writes, package installation by a target, live apply/rollback,
provider-specific managed publishers, public architecture publishing,
multi-instance federation, paid support, and external provider login flows
that are not implemented. These exclusions are security boundaries, not
future authorization.

## Assumptions

- Deployments are self-hosted by operators who control Postgres, object
  storage, email provider, TLS, and reverse-proxy configuration.
- Public beta users may run the app locally, self-host experimentally, or
  evaluate the documented API/web/CLI/MCP surfaces.
- Beta deployments should not be treated as business-critical systems without
  additional operational controls.
- Uploaded packages are untrusted until validation, scan, review, and
  publication gates pass.
- Architecture specs, mappings, fixtures, target observations, and adapter
  metadata are untrusted input. They must remain bounded and metadata-only.
- The registry remains the source of truth for release lifecycle, artifact
  integrity, and package visibility.

## Assets

- User accounts, roles, sessions, MFA state, API tokens, auth action tokens,
  and provider mapping configuration.
- Skill metadata, lifecycle/review state, scan findings, package artifacts,
  object hashes, and bundle payloads.
- Architecture shells and immutable revisions, exact release references,
  profile exposure rules, organization policy revisions, team memberships,
  sharing grants, and derived diagrams.
- Connected-target owner/binding, consent, adapter/capability/identity
  digests, generation, health summaries, and metadata-only observations.
- Sync run/step state, leases, fencing tokens, baselines, receipts, recovery
  evidence, and pattern-migration lineage/digests.
- Sanitized audit events, deployment secrets, release artifacts, checksums, and
  GitHub tag state.

## Trust boundaries

- Browser to API over HTTP(S), using token-free login/MFA responses plus an
  HttpOnly SameSite `myskills_session` cookie.
- CLI to API over HTTP(S), using stored bearer sessions or scoped API tokens.
- MCP clients to the HTTP MCP adapter, using scoped API tokens before protocol
  handling; stdio MCP uses explicit `MYSKILLS_TOKEN`.
- API to Postgres for canonical product state and to object storage for package
  artifacts.
- Browser/editor and API compiler/renderer to bounded user-authored specs,
  mappings, and observed fixtures.
- API target service to a future adapter. The current adapter contract passes
  IDs/digests only and has no write method.
- Explicit caller-supplied local Codex root to the read-only adapter. The
  adapter must not expand that root or follow profile pointers.
- Package upload boundary from untrusted author input into validation,
  scanning, object storage, review, and publication.
- Release boundary from clean git `HEAD` to source archive, metadata,
  checksums, and tag-triggered CI.

## Entry points

- Auth, registration, email verification, password reset, MFA, session,
  API-token, provider-admin, user-admin, audit, search, detail, bundle,
  submission, and review API routes.
- Architecture pattern/list/detail/revision/draft-preview/preview routes,
  manager-only organization-grant GET/PUT, and owner/team-owner pattern
  migration preview/create routes.
- Organization membership, invitation, policy, lifecycle, and team-adoption
  routes; team membership and sharing routes.
- Target registration, read, consent, observation, health, and revoke routes.
- Web login, admin, submission, maintainer review, architecture editor, and
  diagram/outline views.
- CLI auth, registry, sharing, team, and read-only architecture commands.
- MCP registry and read-only architecture projection tools.
- Package directory and `.zip` parsing, Docker/production configuration, and
  GitHub release workflow.

Pattern migration has a local authenticated preview/create route. There is no
public sync-run route. The fixture planner in the consolidated preview is
explicit and request-scoped; a target is never inferred.

## Abuse paths and mitigations

| Threat | Impact | Current mitigation | Remaining work or residual risk |
| --- | --- | --- | --- |
| Unauthorized private/unsafe skill discovery | Metadata or package exposure | Server-owned lifecycle, review, scan, visibility, grant, and artifact predicates; generic denial paths; API/CLI/MCP tests | Broader future role-gated tool matrix |
| Architecture references a changed or restricted release | Private metadata or unsafe desired state | Exact slug/version/SHA-256 binding at preview; no `latest` fallback; current release predicates; fail-closed unavailable-release error | Signed release-reference policy and wider cross-surface matrix |
| Team membership is used as organization membership | Cross-organization access | Store resolves memberships; parented team access requires active parent organization, current policy, and same-organization active membership; standalone teams retain legacy path | Review every future bulk/list path for the same predicate |
| Organization grant or policy confusion | Cross-tenant architecture/skill read | Grant is read-only to recipients, bound to organization and policy revision; owner/admin GET/PUT replacement checks the current revision, active status/current policy/active membership/instance sharing switch, exact release visibility, and limits; the Postgres adapter rechecks gates under lock; organization-safe revisions exclude private, team-scoped, and explicit-user refs | Review selected-organization UX and complete CLI/MCP architecture-grant write parity; default is deny |
| Stale organization policy or membership | Access survives revocation | Current policy and active membership are resolved for each service/store decision; immutable policy revisions and same-org FKs prevent rebinding; replacement is audited and atomic | Continue cross-tenant regression coverage as policy fields expand |
| Nested graph cycle/orphan/oversized payload | DoS or incorrect routing | Bounded JSON, strict pattern/schema validation, cycle/orphan/edge/depth checks before persistence/rendering | Stress fixtures and production resource limits |
| Profile/exposure confusion | Skill appears in wrong environment | Default-deny profiles, explicit denials win, exposure separate from package visibility/ownership, exact profile/environment selection | Conditional exposure and target capability enforcement |
| Diagram injection or misleading projection | Script/directive injection or metadata leak | Escaped Mermaid/SVG labels, authorized-node filtering, same-set accessible outline, no package/private target content | Browser CSP and interactive-canvas review |
| Fixture or observation mistaken for canonical/applied state | Unsafe overwrite or false success | Fixture is explicit, bounded, metadata-only, and dry-run; observations are append-only evidence; no inferred target or write path | Live adapter contract, user confirmation/readback, and provider pilots |
| Sync replay, stale run, or lease loss | Duplicate or cross-target mutation | Tenant-scoped FKs, immutable digests, request/idempotency keys, generations, lease/fencing records, recovery decisions, and synthetic fixture executor | Public sync route and live executor remain disabled |
| Pattern migration loses exposure or ownership | Unintended runtime disclosure or target change | Core derive-shell validates mappings, preserves leaf bindings, blocks exposure mismatch; owner/team-owner API preview/create uses exact source access, source locking, idempotency, and atomic shell/revision/0020 lineage persistence; grants and targets are never copied or rebound | Injected external release authorization is preflight-only and cannot be atomic with the database transaction |
| Read-only Codex adapter leaks local data | Private paths, prompts, or credentials leave host | Explicit caller root/profile, bounded metadata/frontmatter reads, no body/prompt/path/URL/credential output, no mutation methods, core adapter conformance check | Local CLI is enabled; API upload and live target invocation remain disabled until consented wiring and privacy review |
| Target consent/capability bypass | Unapproved observation or future write | Explicit consent state; current generation and adapter/capability digests; mutation capabilities false/absent; observation append-only | Provider-specific scopes and live readback before any write |
| Token theft/replay | Account/API misuse | Opaque hashed sessions/tokens, scopes, revocation, token-free web login/MFA responses, MFA-gated privileged actions, keyring-first CLI storage | Browser/device login for CLI |
| Malicious package archive | Traversal, unsafe install, secret leakage | Root manifest, archive traversal/symlink/encryption/compression/size/file-count defenses, blocking scans, maintainer review | Background scan jobs and richer policy fixtures |
| Artifact tampering/direct object exposure | Modified or unreviewed content | Opaque storage keys, API-owned writes, byte-size/SHA-256 verification, fail-closed mismatch handling | Signed/direct delivery with authorization and audit |
| MCP bearer misuse | Unauthorized metadata or unsafe action | Scoped API token before protocol handling, read-only architecture tools, no bundle payloads, host/origin restrictions | Per-tool authoritative audit and future role-gated tools |
| Audit/error leakage | Token/package/private-data exposure | Sanitized audit details, generic auth responses, no raw target state, bounded fields | Structured audit export hardening |
| Release pipeline/provenance weakness | Harder source-to-artifact proof | Reproducible source archive, checksums, tag/version checks, release workflow | Pinned actions/images, SBOM, signatures, protected release tags |

## Audit findings at this branch review

The following are evidence-labeled implementation findings, not claims that
the deferred paths are safe to enable:

1. **Branch foundation present:** migrations 0015–0020, shared core contracts,
   API architecture/organization/target routes, stores, web architecture
   workbench, read-only CLI/MCP projections, and focused test suites cover the
   bounded contracts described above. This inventory is not a passing-gate or
   hosted-readback claim.
2. **Guarded write source present:** organization architecture grant
   persistence, manager-only GET/PUT routes, web controls, current-revision
   concurrency, policy-bound release checks, atomic Postgres replacement, and
   sanitized audit coverage are present. Fresh disposable-Postgres evidence is
   still required. The receiving organization still has read/preview access
   only; CLI/MCP grant-write parity is deferred.
3. **Fail-closed gap:** `ArchitectureSyncService`, the fixture executor, and
   the Postgres store persist and exercise synthetic staged transitions,
   recovery, and rollback, but no sync-run route, live adapter, package
   installer, or filesystem writer is wired. Each bounded run is limited to
   500 steps and 2,004 append-only receipts: a 1,002-receipt max-step
   lifecycle, one full apply/verify retry, and two recovery/terminal receipts;
   further retries require a new bounded run. “Apply” in fixture tests is not a
   deployment operation.
4. **Guarded migration source present:** derive-shell migration is implemented
   in core, API service/routes, web controls, and the 0020 Postgres transaction.
   The source identity, grants, and target bindings are not copied. Fresh
   migration/concurrency evidence is still required. The injected external
   release-authorizer preflight remains a bounded race with database commit and
   must be revalidated before any provider write path.
5. **Privacy boundary:** the Codex adapter is fixture-tested and explicit-root
   only. It is not a live home-directory reader or connected API adapter.
6. **Client parity gap:** web exposes organization management, target
   management, grant save/revoke, migration preview/create, current-revision
   editing, revision diff/history, and derived JSON/Mermaid/plain-outline
   downloads. CLI and MCP remain without architecture-grant, target, sync, and
   migration writes; CLI skill-sharing writes remain API-governed. Durable
   server-side diagram artifacts remain deferred.
7. **Deployment boundary:** Phase 1 Railway state requires a documented live
   read-back. Local Phase 2 migrations and tests do not establish hosted
   availability.

These findings are mitigated by the current default-deny routes, explicit
capability flags, no-write adapter interfaces, bounded metadata validators,
immutable/digest-bound records, and documented non-goals.

## Existing beta.2 risk acceptance (not Phase 2 release acceptance)

The beta can be public if repository release checks pass, beta
support/compatibility/upgrade docs are current, and GitHub private vulnerability
reporting is enabled. Operators must not rely on this draft's fixture or
metadata foundations for business-critical live synchronization. Any future
Phase 2 release requires a fresh supported-runtime release gate,
disposable-Postgres and browser/UAT evidence, independent security review, and
separate hosted read-back.

## Business-safe release gates

- Independently review the organization-grant replacement route, selected
  organization context, and cross-tenant web controls before any hosted
  promotion.
- Complete target consent, scoped credential-store integration, capability
  negotiation, conflict handling, idempotent apply, audit, readback, and
  rollback before enabling any target write.
- Keep Codex and other adapter privacy tests separate from live-provider tests;
  prove the rendered/client result as well as the API result.
- Add public sync routes only after the persisted fixture contract is extended
  with a live adapter, target write, package-install, readback, rollback, and
  independent lease/fencing/recovery proof.
- Recheck pattern-migration authorization, lineage, idempotency, and the
  external release-authorizer race before any target or provider integration.
- Run the complete release gate on a clean supported-runtime candidate and
  review fresh disposable-Postgres, browser/UAT, and independent security
  evidence before any hosted Phase 2 promotion.
- Before production applies migration 0019, verify a restorable database backup
  and the backup-restore procedure, record the accepted data-loss boundary, and
  assess and approve the expected Postgres lock window for its DDL work. A
  local migration pass or backup artifact alone does not establish either gate.
- Finish per-tool MCP audit events, background scans, provider lifecycle,
  browser/device CLI login, signed/direct artifact delivery, release
  provenance, and production operational runbooks.
- Perform a final security review against the live deployment and current
  provider documentation before marketing connected management.
