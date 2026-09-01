# API, MCP, And CLI

Version: 0.1.0-beta.4
Document revision: 0.2.0-draft
Last updated: 2026-09-01

## Shared Rule

For API-backed operations, web, CLI, and MCP use the same API-owned
authorization, sharing, lifecycle, review, and artifact decisions. Client
surfaces must not reproduce those policies as substitutes for server checks.

The same rule applies to the Skill Architecture Control Plane. An architecture
revision is a desired graph, not a second registry. The API resolves exact
skill releases, applies actor and release predicates, and returns one
consolidated preview plus a fixture-only sync plan. A web canvas, CLI output,
MCP result, or target snapshot cannot grant access or become canonical state.

## Implemented API Surface

The Fastify API currently provides:

- health and versioned capability discovery (`GET /health`, `GET /v1/capabilities`);
- email/password, verification, password reset, email change, session, MFA, invitation, and account flows;
- scoped API-token creation/list/revocation and MFA-gated admin token inventory/revocation;
- registration, user/role, provider metadata/mapping, audit, sharing, team, and organization administration;
- public skill search/detail and approved release metadata/bundle delivery;
- authenticated package submission, owned-submission export/withdrawal, maintainer artifact download, hash-attested review/publication, and skill/release lifecycle controls;
- MCP token authorization through `GET /v1/mcp/session`.

[API App](../apps/api/README.md) is the maintained route-level inventory. Public OpenAPI output is planned; it should be generated from, and verified against, implemented route schemas rather than maintained as a second hand-written source.

Browser auth uses token-free login/MFA responses followed by credentialed `myskills_session` cookie requests. CLI and API-token flows use explicit bearer credentials. Metadata browsing does not fetch package contents.

## Planned API Work

- Private draft endpoints separate from submitted versions.
- Provider login/linking and external identity lifecycle.
- Durable background scan/eval run endpoints and safe eval summaries.
- Signed/direct artifact delivery with the same authorization and audit guarantees.
- Generated OpenAPI once route schemas cover the stable beta surface.
- Public sync-run routes and live target operations only after their durable
  service, idempotency, fencing, recovery, authorization, and readback
  contracts are complete.

## Beta.3 breaking security and MCP changes

Beta.3 contains security and MCP contract changes that are not part of the
published `0.1.0-beta.2` surface. The source and package release does not prove
that the hosted Railway deployment has been promoted to beta.3.

Team creation, team-owner invitation/member lifecycle mutations, and
organization creation/invitation/member/policy/lifecycle mutations require an
interactive MFA-verified session. Canonical sharing is also session-only:
sharing expansions to team or organization scope require MFA, and privileged
sharing reads/writes require MFA. The deprecated beta.2
`skills edit --visibility` alias uses the same session/MFA boundary. API tokens
remain valid for their documented scoped reads, but cannot be used to widen
sharing or perform these mutations.

Migration from beta.2 to beta.3: enroll TOTP through
`POST /v1/auth/mfa/totp/enroll` (with password reauthentication), confirm it
with `POST /v1/auth/mfa/totp/confirm`, retain the one-time recovery codes, and
complete subsequent login challenges through `POST /v1/auth/mfa/verify` or
`myskills login`. Move mutation automation to an explicitly managed session;
API-token automation must remain read-only. Invitation acceptance remains
session-only where its route permits it.

The MCP `get_install_instructions` result no longer contains
`apiBundleEndpoint`, any bundle URL, or package contents. It returns authorized
release metadata plus generated `myskills install ...` and
`myskills export ... --output ...` commands. MCP clients must use those
commands, or the separately authenticated API/CLI delivery path; they must not
construct a bundle URL from metadata. `MYSKILLS_API_URL` and the MCP API base
URL accept only an absolute `http://` or `https://` URL without credentials,
query strings, or fragments. Generated CLI commands intentionally do not embed
the API URL or bearer token: configure the CLI with `myskills config set
api-url ...` or `MYSKILLS_API_URL`, then authenticate it separately. Bearer
credentials remain in request headers.

The repository version is `0.1.0-beta.3`. Hosted deployment state must be read
back separately and must not be inferred from the repository version.

## Skill Architecture Control Plane (Phase 2 draft)

The architecture surface is a versioned, authenticated extension to the
registry. It stores immutable `ArchitectureSpecV1` revisions with typed
router/leaf topology, exact slug/version/digest release references, logical
profiles, and logical environments. Profiles default to deny and explicit
denials override allows. Package visibility, architecture ownership, runtime
exposure, organization sharing, and target consent remain separate decisions.
This section describes the Phase 2 source release; it is not proof of a live
Railway deployment and does not configure provider credentials.

Topology pattern and delivery/governance mode are also separate. The built-in
patterns are `flat`, `domain-router`, and `multi-level-router`; API, web, CLI,
MCP, guided export, and connected-target observation are delivery surfaces or
modes, not topology patterns. A provider or target must not change the
architecture graph implicitly.

### Implemented API routes

| Route | Purpose | Result and boundary |
| --- | --- | --- |
| `GET /v1/architecture-patterns` | List built-in pattern descriptors | Pattern metadata only. |
| `GET /v1/architectures` | List architectures visible to the actor | User/team ownership and current organization-grant policy apply. |
| `POST /v1/architectures` | Create an architecture shell | Server assigns identity; owner may be a user or authorized team. No revision or package inventory is implied. |
| `GET /v1/architectures/:id` | Read summary, revision summaries, and current state | Unauthorized records are hidden; organization-only projections filter unsafe revisions and set `latestRevision` to `null`. |
| `GET /v1/architectures/:id/revisions` | List immutable revision summaries | Current access policy applies. |
| `POST /v1/architectures/:id/revisions` | Append an immutable revision | Server validates exact release references and optimistic current-revision input; prior revisions/releases are unchanged. |
| `GET /v1/architectures/:id/revisions/:revisionId` | Read one immutable revision | Owner/team readers can read the raw revision; organization-only readers receive the generic not-found response and must use preview with an explicit organization context. |
| `POST /v1/architectures/:id/draft-preview` | Compile an unsaved editor draft | Requires an expected current revision; does not persist the draft or change a target. |
| `POST /v1/architectures/:id/preview` | Compile one revision/profile/environment and optional fixture plan | Raw response is `{ revision?, compiled, graph, outline, diagram, plan? }`; `revision` is omitted for organization-only projections, which require an explicit organization context; target remains untouched. |
| `GET /v1/architectures/:id/organization-grants` | Read the architecture's organization grants | Session-only manager read; returns organization IDs and the current-revision token. |
| `PUT /v1/architectures/:id/organization-grants` | Replace the complete organization grant set | Session/MFA manager write; current-revision token, current organization policy, membership, exact release, limit, and audit checks run before atomic persistence. An empty set revokes all grants. |
| `POST /v1/architectures/:id/pattern-migrations/preview` | Preview a derive-shell migration to another built-in pattern | Session-only owner/team-owner preview; accepts only target pattern, expected current revision, and bounded mapping intent. No identity or lineage is allocated. |
| `POST /v1/architectures/:id/pattern-migrations` | Create a derived shell, first revision, and lineage | Session/MFA owner/team-owner write; server allocates the new shell identity and persists the shell, revision, and 0020 lineage atomically with idempotent replay. Grants and targets are not copied. |
| `GET /v1/architecture-targets` | List targets visible to the actor | Target metadata only; credentials are never returned. |
| `POST /v1/architecture-targets` | Register a target binding | Session/MFA and binding authorization apply; adapter is not invoked. |
| `GET /v1/architecture-targets/:id` | Read target metadata | Current target access applies; no credential reference in response. |
| `POST /v1/architecture-targets/:id/consent` | Grant or deny target consent | Explicit consent transition; MFA is required. |
| `GET /v1/architecture-targets/:id/observations` | Read metadata observations | Generation/digest-bound, append-only evidence only. |
| `POST /v1/architecture-targets/:id/observations` | Append an observation | Requires granted consent and current generation/digests; metadata-only input. |
| `POST /v1/architecture-targets/:id/health` | Record target health | Bounded scalar health metadata; no adapter invocation. |
| `DELETE /v1/architecture-targets/:id` | Revoke a target | Revocation is explicit and audited. |

Architecture list/detail/revision/preview projections accept a session or a
bearer API token with the explicit `architectures:read` scope. Current target
routes are session-only, including target reads; target registration, consent,
observation, health, and revoke are also session-only, with MFA for privileged
actions. Architecture creation and revision append are session-only, with MFA
for privileged/team-owner actions. `review:write` is never an ownership
shortcut. Organization membership, status, current policy, instance sharing
switch, exact grant, and safe-release predicates are resolved by the API/store.
No client-supplied profile label or membership list is authority.

Organization membership, invitations, lifecycle, policy revisions, and team
adoption are exposed under `/v1/organizations` and `/v1/teams`. Organization
skill/architecture grant tables and evaluators exist. Architecture grants have
manager-only GET/PUT routes with policy-bound atomic replacement; the web
architecture workbench exposes the same complete-set save/revoke controls.
Pattern migration has owner/team-owner preview and MFA-protected create routes.
Sync-control remains persisted fixture/recovery evidence without a public
sync-run route. Each bounded run allows at most 500 steps and 2,004 append-only
receipts. That capacity covers a 1,002-receipt max-step lifecycle, one full
apply/verify retry, and two recovery/terminal receipts; further retries require
a new bounded run. Before a production deployment applies migration 0019, the
operator must verify a restorable database backup and the backup-restore
procedure, record the accepted data-loss boundary, and assess and approve the
expected Postgres lock window for its DDL work. A local migration pass or backup
artifact alone does not establish either gate.

Organization-only readers receive safe revision summaries rather than raw
revision payloads. The architecture detail response sets `latestRevision` to
`null` for that projection, and the raw revision route returns a generic
not-found response. A preview for that reader must name one authorized
organization context; the server then resolves the exact release set for that
context and omits the raw revision object from the response.

The consolidated preview compiles once. The graph includes escaped Mermaid;
the `diagram` artifact contains versioned Mermaid, its hash, and a plain-text
accessible outline, while the browser derives SVG from the same filtered node
set. The browser can download the derived diagram JSON or Mermaid text; these
values are not canonical server state. The `plan` field appears only when the
caller provides a strict metadata-only observed fixture. The plan always
declares dry-run/no-apply semantics; no target is inferred.

### Web, CLI, and MCP parity

| Surface | Current capability | Deferred or restricted |
| --- | --- | --- |
| Web | Architecture list/detail, shell creation, semantic editor, exact-release selection, immutable revision history/diff, “use as new draft,” profile/environment preview, SVG plus JSON/Mermaid downloads and a plain-outline projection, fixture dry run, manager-only organization sharing, derive-shell migration preview/create, organization management, and connected-target workbench. | CLI/MCP write parity, public sync-run UI, live adapters, and durable server-side diagram artifacts. |
| CLI | Read-only `architectures patterns`, `list`, `show`, `preview`, `compile`, `plan`, and `dry-run`, plus explicit-root local `architectures observe` and `architectures health`; canonical skill-sharing commands include organization grants and explicit complete-set clearing. | Architecture organization-grant/target/sync/migration API commands and any live Codex upload or mutation connection. |
| MCP | Read-only `list_architecture_patterns`, `list_architectures`, and `get_architecture_projection`. | Architecture writes, organization/target/sync/migration tools, and all target mutation. |

The local Codex read-only adapter is exposed only through explicit-root local
CLI commands. It does not upload or invoke an API target. All architecture
API-backed client surfaces use the API as the policy boundary and return
architecture/release metadata only; they do not return package content,
prompts, credentials, URLs, endpoints, or local paths. The separate registry
bundle routes remain the package-delivery boundary.

### Visibility migration

The canonical visibility contract is the authenticated
`/v1/skills/:slug/sharing` route and `myskills sharing set`. Existing beta.2
clients may still send generic metadata `visibility`, including through
`myskills skills edit --visibility`; the API and CLI retain that behavior as a
deprecated compatibility shim. The shim delegates the visibility change to
the canonical sharing boundary and preserves the existing team, user, and
organization grants when the newer fields are omitted.

Canonical `myskills sharing set` accepts either `--organization
<organization-id>` or `--organization-id <organization-id>` as part of the
complete organization grant set. Omitting both options preserves the current
organization grants for beta.2 compatibility. `--clear-organizations` sends
`organizationIds: []` to explicitly revoke the complete organization grant
set; it is mutually exclusive with either organization ID option. The
deprecated `skills edit --visibility` alias does not provide complete-set
organization controls, so clients that need to clear or replace organization
grants must use canonical sharing.

Canonical sharing remains subject to the API's session and MFA security rules;
the beta.2 metadata alias is session-only and requires an MFA-verified session
for every visibility mutation before it reads or replaces the complete grant
set. API tokens cannot widen a skill through the alias. Neither path bypasses
server policy. The organization scope is policy-gated by active organization
membership, current organization sharing controls, and explicit grants; a
`personal`, `work`, or `team` label is not a tenant or authorization claim.

The beta.2 compatibility shims remain in beta.3. Their removal requires a
later, separately published prerelease boundary with migration guidance and
release verification. The Phase 2 source release does not imply a hosted
deployment.

The read-only CLI commands `architectures preview`, `architectures compile`,
`architectures plan`, and `architectures dry-run` already accept the explicit
`--organization-id <organization-id>` context argument. The existing
`--organization <organization-id>` input alias is also accepted. The API
authorizes the exact organization projection; the argument is a scope filter,
not an ownership shortcut. Architecture organization-grant replacement
remains an API/web manager operation.

## MCP Surface In The Current Branch

The current branch's official TypeScript MCP SDK integration backs:

- a stdio server;
- a stateless Streamable HTTP server;
- `search_skills`;
- `get_skill_info`;
- `get_install_instructions`;
- `list_architecture_patterns`, `list_architectures`, and
  `get_architecture_projection` (read-only architecture projections).

The API-owned MCP session check accepts an API token with either `skills:read`
or `architectures:read`. Registry tools require `skills:read`; architecture
projection tools require `architectures:read`. Interactive sessions are
rejected. HTTP authenticates each request and does not use a shared server
token. MCP tools return metadata
and install/export guidance, not package contents. The current branch's
`get_install_instructions` returns only authorized metadata and generated CLI
install/export commands; it does not return `apiBundleEndpoint` or any bundle
URL. Clients must use the generated commands or the separately authenticated
API/CLI delivery path. MCP API base URLs must be absolute HTTP(S) URLs without
credentials, query strings, or fragments, and bearer tokens remain in headers.
Generated CLI commands do not embed either value; configure the CLI API URL and
credentials separately before running them.

Planned MCP work is limited to role-gated maintainer/admin reads, authoritative per-tool audit events, and broader client compatibility evidence. Write tools remain deferred.

## CLI Surface In The Current Branch

The current Phase 2 branch's `@jarel/myskills` bundle supports:

- version, local validate, and local scan;
- local-first API URL config, password/API-key login, MFA completion, logout, auth status, and doctor diagnostics;
- search, info, verified export, local install/list/update/rollback;
- directory or `.zip` submission, owned-submission list/withdrawal;
- maintainer review queue, bundle inspection, and review/publication actions;
- non-visibility skill metadata/lifecycle and release lifecycle controls;
- team and sharing administration;
- API-token create/list/revoke.

Architecture inspection commands are shipped in this branch as read-only,
capability-gated API clients. They are not a published beta.2 artifact. Target
apply, rollback, live adapter registration, and target credential management
are deferred.

[CLI App](../apps/cli/README.md) is the command-level source of truth. Browser/device login, package init/archive creation, and platform-specific install adapters are planned and should not appear as implemented commands.

The CLI build bundles `packages/skill-package` into `dist/index.js`. The published manifest has no runtime dependency on private `@myskills-app/*` workspaces. `npm run smoke:cli-package` verifies the exact tarball file allowlist, clean temporary install with public dependencies resolved from npm, version output, and example validate/scan behavior.

## Compatibility Targets

- Codex Agent Skills packages are the first supported package target.
- Generic prompt/workflow bundles are the next target.
- Claude, ChatGPT, and other adapters remain planned until package and review rules are stable.

See [Compatibility](COMPATIBILITY.md) for supported runtimes and operating systems.

## Verification

- API and Postgres contract tests cover authorization and lifecycle paths.
- CLI unit tests cover command parsing, auth/config, artifacts, and local install state.
- The public tarball smoke exercises the installed CLI instead of the workspace source.
- MCP initialize, tools/list, tools/call, and HTTP guard tests cover both transports.
- Architecture contract tests cover nested router graphs, profile/environment
  exposure, exact server-authorized release bindings, immutable revisions,
  consolidated preview parity, diagram escaping, accessible outline parity,
  and deterministic fixture sync plans.
- Cross-surface architecture authorization tests cover API, web, CLI, and any
  optional MCP projection; unauthorized releases and private inventories do
  not appear in derived outputs.
- Playwright covers browser routes; Postgres integration tests cover the disposable database path.
- A passing `npm run release:verify` on a clean supported-runtime candidate is
  the canonical beta gate; the presence of these source/test suites is not a
  passing-gate or hosted-deployment claim.
