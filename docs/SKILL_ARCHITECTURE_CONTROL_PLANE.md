# Skill Architecture Control Plane

Version: 0.1.0
Last updated: 2026-08-30
Status: implemented MVE contract

## Product goal

MySkills is the trusted control plane between reusable skill source and the
environments where skills run. It should let individuals and teams discover,
govern, version, share, compose, inspect, update, and eventually roll back skill
systems without making a target-specific directory or visual canvas the source
of truth.

This MVE makes a skill architecture an explicit, owner-private, versioned
object. A create request first produces an owner-private draft shell; each
saved graph is an immutable revision. The MVE proves nested
router-to-router-to-leaf topology, fail-closed runtime exposure, exact
server-authorized release binding, deterministic projections, and fixture
dry-run reconciliation. It does not connect to or change a live agent runtime.

The API and Postgres are canonical. Web, CLI, MCP, Mermaid, SVG, outlines, and
future adapters are clients or derived views.

## Included boundary

The MVE includes:

- immutable `ArchitectureSpecV1` revisions;
- `flat`, `domain-router`, and `multi-level-router` patterns;
- exact skill release references by slug, semantic version, and SHA-256;
- personal, work, and team-labelled environments and user/team profile
  contexts; these labels do not create tenancy or grant access;
- profile bindings that default to `disabled`, with matching denials taking
  precedence over grants;
- runtime exposure states `disabled`, `router`, and `leaf`, separate from
  package discovery visibility;
- deterministic validation, normalization, SHA-256 revision digests, graph
  positions, Mermaid, and accessible outline data;
- exact authorized release resolution through the existing registry lifecycle,
  visibility, review, security, and artifact-digest boundary;
- fixture-backed `noop`, `install`, `update`, `downgrade`, `enable`, `disable`,
  `remove`, `conflict`, `unsupported`, and `configure-router` planning;
- API and web workflows plus read-only CLI and MCP inspection;
- bounded metadata-only inputs with no package bytes, prompts, secrets,
  credentials, URLs, endpoints, or local paths.

The MVE does not include:

- live Codex, ChatGPT, Claude, filesystem, or other target adapters;
- sync apply, target mutation, or rollback;
- team-owned architecture records or organization tenancy;
- public architecture sharing;
- target credentials or a new authentication method;
- a graphical editor or persisted canvas layout;
- conditional runtime evaluation beyond the explicit exposure bindings.

The labels `personal`, `work`, and `team` describe configuration contexts. They
do not create tenancy or grant access. Architecture records remain private to
their owning user in this slice.

## Policy boundaries

Three decisions remain separate:

1. Package visibility answers who may discover or install a release. Existing
   registry sharing, lifecycle, review, security, and grant rules own it.
2. Architecture ownership answers who may read or append revisions. The MVE
   permits only the owning user.
3. Runtime exposure answers which already-authorized release should be active
   in one profile and environment. Missing bindings are disabled. A matching
   disabled binding wins over an enabled binding.

Compilation cannot widen registry access. The API resolves every reference to
an exact authorized published release and compares the server artifact digest
with the revision digest. Client-supplied visibility is ignored. Missing,
hidden, unpublished, revoked, organization-scoped, or mismatched releases fail
with `ARCHITECTURE_SKILL_RELEASE_UNAVAILABLE`. Organization visibility is not
supported by this MVE because organization tenancy is not enabled.

### Visibility migration

Changing skill visibility through generic metadata is an intentional breaking
change. The API rejects a `visibility` field on the generic skill metadata
update, and `myskills skills edit --visibility` is rejected/removed from the
supported CLI contract. Clients must use the authenticated
`/v1/skills/:slug/sharing` route or `myskills sharing set` instead. The
organization scope remains unsupported and fails closed. The `personal`,
`work`, and `team` labels used by architecture profiles do not grant tenant
access.

## Patterns

| Pattern | Required topology |
| --- | --- |
| `flat` | Leaf nodes only, no edges; each leaf is an entry node |
| `domain-router` | One router entry with `routes` edges to leaves |
| `multi-level-router` | One router entry and at least one real router-to-router-to-leaf path |

Topology is explicit. `contains` targets a router. `routes` targets a leaf.
Nodes have one parent, all nodes are reachable from an entry, and cycles are
invalid.

## `ArchitectureSpecV1`

This is the implemented wire shape. The API replaces `id` with the canonical
architecture resource ID when it creates a revision.

```json
{
  "schemaVersion": 1,
  "id": "server-injected-architecture-id",
  "name": "Personal and work skills",
  "description": "Two contexts under one governed root.",
  "pattern": { "id": "multi-level-router", "version": 1 },
  "skills": [
    {
      "id": "release-notes",
      "slug": "release-notes-helper",
      "title": "Release notes",
      "version": "1.0.0",
      "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "packageVisibility": "private"
    }
  ],
  "nodes": [
    { "id": "root", "kind": "router", "label": "All skills" },
    { "id": "delivery", "kind": "router", "label": "Delivery" },
    {
      "id": "release-notes",
      "kind": "leaf",
      "label": "Release notes",
      "skillRefId": "release-notes"
    }
  ],
  "edges": [
    { "from": "root", "to": "delivery", "kind": "contains" },
    { "from": "delivery", "to": "release-notes", "kind": "routes" }
  ],
  "entryNodeIds": ["root"],
  "profiles": [
    {
      "id": "personal",
      "name": "Personal",
      "subject": { "type": "user", "id": "user-id" },
      "defaultExposure": "disabled",
      "bindings": [
        { "nodeId": "root", "enabled": true, "runtimeExposure": "router" },
        { "nodeId": "delivery", "enabled": true, "runtimeExposure": "router" },
        { "nodeId": "release-notes", "enabled": true, "runtimeExposure": "leaf" }
      ]
    }
  ],
  "environments": [
    {
      "id": "personal-mac",
      "name": "Personal Mac",
      "kind": "personal",
      "profileId": "personal"
    }
  ]
}
```

Skill references are metadata, not package content. Version and digest are
required. The revision remains immutable if the referenced release later
changes state; a later preview then fails rather than silently selecting
`latest` or rewriting history.

The validator bounds the number of skills, nodes, edges, profiles, bindings,
environments, metadata keys, metadata string lengths, and topology depth before
expensive traversal or rendering.

## Persistence and revisions

`skill_architectures` stores the owner, display metadata, selected pattern, and
current revision pointer. `skill_architecture_revisions` stores a monotonic
revision number, immutable normalized JSONB spec, creator, message, and creation
time. The current revision pointer moves only when a new revision is appended.

The API validates JSON before persistence, and the preview compiler validates
the persisted spec again before it returns projections. Derived graph, outline,
Mermaid, compiled state, and sync plans are not stored as writable sources of
truth.

## Consolidated preview and projections

Preview generation compiles one architecture revision with an environment,
profile, and authorized registry snapshot. The API builds that snapshot from
current server-owned release metadata; it never accepts the snapshot from a
client.

The compiler returns:

- the normalized revision digest;
- the selected profile and environment;
- active nodes and edges;
- disabled node IDs;
- exact authorized skill slug, version, artifact digest, visibility, and tags;
- deterministic router configuration digests.

Graph, Mermaid, and outline views use the same compiled node set. Disabled
nodes do not appear in the selected effective projection. The browser draws a
deterministically positioned SVG and renders a matching semantic outline/table.
The diagram is never canonical.

## Fixture dry-run contract

The API accepts a bounded `ObservedArchitectureState`:

```json
{
  "targetId": "personal-mac-fixture",
  "environmentId": "personal-mac",
  "nodes": [
    {
      "nodeId": "release-notes",
      "kind": "leaf",
      "skillRefId": "release-notes",
      "slug": "release-notes-helper",
      "version": "1.0.0",
      "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "enabled": true,
      "runtimeExposure": "leaf",
      "managed": true,
      "supported": true
    }
  ]
}
```

Fixture fields are strictly typed and allowlisted. Paths, credentials, tokens,
package content, nested metadata, and unknown fields are rejected. Existing
resources marked `managed: false` are `unsupported`; managed entries outside
the desired graph are explicit dry-run removal candidates. The planner never
applies either result.
Every plan has `dryRun: true`, `canApply: false`, and `requiresApproval: true`.
No fixture target is inferred. The web sends a strict desired-vs-observed
fixture only after the user supplies it; a preview without that explicit
fixture has no `plan`.

## Read-only target resolution extension

The first post-MVE connection slice adds a metadata-only detector for the
existing MySkills-managed Codex install registry. It does not scan arbitrary
Codex directories, prompts, configuration files, or credentials. The detector
emits `myskills.target-observation.v1` with an operator-selected target ID,
tool/adapter identity, boolean capabilities, and the managed skill
slug/version/artifact digest state. Local install paths are never included.

`POST /v1/architecture-resolutions` accepts that bounded observation through
the existing `architectures:read` boundary. It evaluates the latest revision
of each owner-visible architecture across matching environments, derives the
existing dry-run plan, and ranks candidates deterministically. The result
contains match evidence, confidence, ambiguity, capability blockers, and a
full plan only for a uniquely selected candidate. Equal, weak, empty, or
over-broad matches fail closed. Router topology does not increase confidence
when the reporting adapter cannot inspect routers.

This extension still has no target write. `myskills architectures configure
--auto` means detect, resolve, and produce a dry run. `--apply` is rejected.
The API records only bounded resolution identity and counts, not the raw target
inventory.

## API and clients

MVE API routes:

```text
GET  /v1/architecture-patterns
POST /v1/architecture-resolutions
GET  /v1/architectures
POST /v1/architectures
GET  /v1/architectures/:id
GET  /v1/architectures/:id/revisions
POST /v1/architectures/:id/revisions
GET  /v1/architectures/:id/revisions/:revisionId
POST /v1/architectures/:id/preview
```

Owner reads and preview projections require an interactive session or
an API token with the explicit `architectures:read` scope. Creation and
revision append require an interactive session; privileged roles must have
verified MFA. No API token can write architecture state. The preview response
is one raw object with the exact top-level shape
`{ revision, compiled, graph, outline, plan? }`. `graph` includes the
server-generated Mermaid export. The API does not return SVG: the browser
derives the SVG from `graph` and renders the accessible `outline` from the same
profile-filtered compilation. The preview includes a dry-run `plan` only when
its caller explicitly supplies a strict metadata-only observed-state fixture.
No target fixture is inferred.

The web app can choose a pattern, create an owner-private draft shell, inspect
saved revisions, select profile/environment contexts derived from the current
revision, and review one consolidated preview plus a dry-run projection. A new
shell is shown as an intentional no-revision draft; the web MVE does not claim
a visual revision editor.

The CLI provides pattern/list/show/preview and fixture dry-run inspection. It
also provides managed-registry `detect` and read-only `configure --auto`
resolution for Codex. MCP provides read-only pattern, list, and preview
projection tools. Agent managers can call the resolution API with an
`architectures:read` token; a remote API or browser cannot inspect a local
machine by itself. All clients use the API as the policy boundary and return
no package contents.

## Deferred architecture work

The next product slices are:

1. a web/API revision builder that selects authorized registry releases;
2. team-owned architectures and explicit tenancy/policy revisions;
3. environment registration, consent, adapter capabilities, and health;
4. staged apply, conflict resolution, audit, rollback, and recovery;
5. optional interactive graph editing and automatic layout once real graph
   sizes prove the need.

## Verification gate

The MVE is complete only when core, API, Postgres migration, web, CLI, MCP,
browser/accessibility, privacy, security, supply-chain, and full repository
checks pass on a supported Node/npm runtime. The final report must distinguish
implemented fixture behavior from deferred live-adapter behavior.
