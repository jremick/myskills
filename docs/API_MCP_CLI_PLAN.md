# API, MCP, And CLI

Version: 0.1.0-beta.2
Last updated: 2026-08-30

## Shared Rule

API, web, CLI, and MCP use the same API-owned authorization, sharing, lifecycle, review, and artifact decisions. Client surfaces must not reproduce those policies as substitutes for server checks.

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
- registration, user/role, provider metadata/mapping, audit, sharing, and team administration;
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

## Skill Architecture Control Plane (MVE plus read-only resolution)

The architecture surface is a versioned, authenticated extension to the
registry. It creates owner-private draft shells, then stores immutable
`ArchitectureSpecV1` revisions containing typed router/leaf nodes, exact
slug/version/digest release references, logical profile contexts, and logical
environments. Profiles default to deny and explicit denials override allows.
Package visibility, architecture ownership, and runtime exposure remain
separate decisions. Organization visibility is unsupported in this MVE; the
`personal`, `work`, and `team` labels are context labels, not tenant claims.

The MVE route contract is:

| Route | Purpose | Result and boundary |
| --- | --- | --- |
| `GET /v1/architecture-patterns` | List built-in pattern descriptors | Pattern metadata only |
| `POST /v1/architecture-resolutions` | Rank existing owner-visible revisions against a strict metadata-only target observation | Requires `architectures:read`; returns confidence, ambiguity, capability blockers, and a selected dry-run plan when the match is unique; never writes the target |
| `GET /v1/architectures` | List architectures visible to the actor | Owner-visible metadata only |
| `POST /v1/architectures` | Create an architecture record | Creates an owner-private draft shell and assigns identity; no package inventory or revision is implied |
| `GET /v1/architectures/:id` | Read architecture summary, revisions, and active state | No unauthorized private inventory |
| `GET /v1/architectures/:id/revisions` | List immutable revisions | Owner authorization applies |
| `POST /v1/architectures/:id/revisions` | Append an immutable revision | Server validates exact slug/version/digest references; existing revisions and package releases are unchanged |
| `GET /v1/architectures/:id/revisions/:revisionId` | Read one immutable revision | Owner authorization applies |
| `POST /v1/architectures/:id/preview` | Generate one selected revision/profile/environment preview containing the compiled graph, positioned graph (including Mermaid), and outline projections | Owner authorization applies; every projection comes from the same profile-filtered compilation; target remains untouched |

These routes are implemented API routes covered by architecture contract tests.
Architecture list/detail/revision reads and preview
projections accept a session or a bearer API token with the explicit
`architectures:read` scope. Creation and revision append are session-only;
privileged roles must satisfy the existing MFA policy. `review:write` must not
be used as an ownership shortcut. The API
must return one consolidated preview rather than maintaining separate
projection route contracts. The raw `POST /v1/architectures/:id/preview`
response has the exact top-level shape
`{ revision, compiled, graph, outline, plan? }`; `graph` includes the
server-generated `mermaid` projection. The API does not return SVG. The browser
derives SVG from the returned graph and keeps the outline and diagram on the
same profile-filtered node set. The preview omits `plan` unless the caller
explicitly supplies a strict metadata-only desired-vs-observed fixture; no
fixture target is inferred. The web submits that fixture only after the user
provides it. The resulting plan is a dry run and never touches a target.
Team-owned architectures, organization tenancy, and live target registrations
are not part of this MVE.

The web surface provides an architecture list/detail view, owner-private draft
creation, pattern selector, profile/environment selector, validation state,
and the consolidated preview. The preview's diagram and accessible
outline/tree must contain the same profile-filtered nodes and exposure
decisions. Visual positions and collapsed state are presentation data only.

The CLI provides read-only `architectures patterns`, `architectures list`,
`architectures show`, `architectures preview`, and `architectures plan`
commands when the API capability is present. `architectures plan` sends the
explicit observed fixture through the same preview endpoint. These
commands must use the existing API URL/token handling and must not accept or
print target credentials, local private inventories, or package payloads.

The first read-only connection slice also provides `architectures detect` and
`architectures configure --auto`. Detection reads only the MySkills-managed
Codex install registry under the explicitly selected install root and emits no
paths. Auto-configure posts the resulting `myskills.target-observation.v1` to
`POST /v1/architecture-resolutions`, then prints the uniquely selected dry-run
plan. Weak or tied matches remain ambiguous. `--apply` is rejected; this slice
does not register a connected target or mutate one. Agent managers can use the
same API contract with an `architectures:read` token after collecting target
metadata in their own authorized local execution context.

MCP remains read-only. `list_architecture_patterns`, `list_architectures`, and
`get_architecture_projection` call the API's `architectures:read` boundary for
each request. No MCP architecture write, target apply, or package-content tool
is included in the MVE.

### Visibility migration

Changing skill visibility through generic metadata is an intentional breaking
change. The API rejects a `visibility` field on the generic skill metadata
update, and `myskills skills edit --visibility` is rejected/removed from the
supported CLI contract. Clients must use the authenticated
`/v1/skills/:slug/sharing` route or `myskills sharing set` instead. The
organization scope remains unsupported and fails closed; a `personal`, `work`,
or `team` label is not a tenant or authorization claim.

## Implemented MCP Surface

The official TypeScript MCP SDK backs:

- a stdio server;
- a stateless Streamable HTTP server;
- `search_skills`;
- `get_skill_info`;
- `get_install_instructions`;
- `list_architecture_patterns`, `list_architectures`, and
  `get_architecture_projection` (read-only architecture projections).

Calls require an API token with `skills:read` through the API-owned MCP session check. Interactive sessions are rejected. HTTP authenticates each request and does not use a shared server token. MCP tools return metadata and install/export guidance, not package contents.

Planned MCP work is limited to role-gated maintainer/admin reads, authoritative per-tool audit events, and broader client compatibility evidence. Write tools remain deferred.

## Implemented CLI Surface

The public `@jarel/myskills` bundle currently supports:

- version, local validate, and local scan;
- local-first API URL config, password/API-key login, MFA completion, logout, auth status, and doctor diagnostics;
- search, info, verified export, local install/list/update/rollback;
- directory or `.zip` submission, owned-submission list/withdrawal;
- maintainer review queue, bundle inspection, and review/publication actions;
- non-visibility skill metadata/lifecycle and release lifecycle controls;
- team and sharing administration;
- API-token create/list/revoke.

Architecture inspection, managed-registry detection, and automatic resolution
commands remain read-only and capability-gated. Target apply, connected-target
rollback, live adapter registration, and target credential management are
deferred.

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
- `npm run release:verify` is the canonical beta candidate gate.
