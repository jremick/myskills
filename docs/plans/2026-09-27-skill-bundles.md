# Skill bundles

Bundles explain why skills belong together. A reader can see the purpose, who selected the skills, and the authorized members without opening every skill. A bundle is a discovery relationship. Skills retain their own releases, trust evidence, sharing rules and adoption state.

## Data and authority

`skill_bundles` stores the name, purpose, owner, audience and revision. `skill_bundle_members` refers to stable registry skill IDs in selection order. User and team owners are supported. Public bundles require public members; authenticated bundles require public or authenticated members; team bundles require every member to be readable by that team. User-owned private bundles require the curator to be able to read every selected member. Team-owned bundles also require team-readable members when their metadata is private to team curators. Existing instance sharing settings apply.

Curated collections can combine sources. Source groups require an explicitly selected Library source entry, imported entries and immutable release provenance for approved published releases. Repository or author names do not infer membership. A new import or source check never changes membership automatically. The curator reviews the selected members and updates the source group with its current revision. A repository rename uses the acknowledged source-entry identity, while the bundle ID remains stable. Source updates never alter a curated collection.

Writes validate the current author role and owner under database locks, then validate members against the audience. Skill-row locks coordinate with existing sharing changes. Team and organization membership is rechecked under locks before reference saving. Revisions reject stale changes with `BUNDLE_REVISION_CONFLICT`.

Each read applies the existing registry authorization rules before names, counts, previews and search results are assembled. Only current curators receive a generic partial-membership notice. No hidden-member count is returned. Bundle access never grants skill access.

## Registry views

- **Grouped** is the default. Bundles have a member disclosure and a separate Details action. Unbundled skills remain visible.
- **List** contains each matching skill once, with links to its bundles.
- **Outline** uses nested native disclosures for curated bundles and source groups. It does not claim ARIA tree semantics.

Search covers skill name, slug and summary, plus bundle name, purpose and attribution. Member matches reveal matching children. A bundle metadata match includes its authorized members. The response always distinguishes the full authorized member count from matching members. Unique skill and bundle totals come from the same authorized query scope across views.

Top-level rows and member lists have separate pagination. The catalog uses a repeatable-read database snapshot for each request. Cursors bind the actor, query, view and a fingerprint of the authorized results. If that result changes between pages, `CATALOG_CHANGED` requires a fresh first page. No stale authorization snapshot is retained server-side. Exact totals currently require enumerating the authorized catalog in bounded database pages; this is the first-release implementation, with SQL aggregation an optimization for larger registries.

The UI follows the approved compact workspace: slate canvas, white surface, teal identity tiles, short rows and a detail inspector. The inspector switches to list/detail navigation based on available content width. Existing exact release, platform, history, trust and export controls remain the skill-detail path. Components and styles are scoped so the concurrent Libraries design work can integrate the small bundle-reference branch separately.

## Library references

A `bundle` Library entry stores only a bundle ID and the revision seen when saved. It creates no skill entries, artifacts, adoptions, bindings or installations. Repeated saves to the same Library return the same active reference. Opening a saved entry resolves the current authorized bundle. A lost bundle grant produces an unavailable reference without cached name or membership. Existing adopted skills remain unchanged.

## API, CLI and MCP

Reads use `skills:read`; source-selection discovery also requires `libraries:read`. Create/edit require `skills:submit` and the existing author/MFA checks. Source-group curation also requires `libraries:read` for its selection evidence. Save requires `libraries:write` and `skills:read`. Team-owned bundle writes and saves into team Libraries require a verified MFA session, matching existing team write policy.

| Operation | API |
| --- | --- |
| Catalog | `GET /v1/registry/catalog?view=grouped&query=...` |
| Bundle detail | `GET /v1/bundles/:id` |
| Members | `GET /v1/bundles/:id/members` |
| Skill memberships | `GET /v1/skills/:slug/bundles` |
| Reviewed source selections | `GET /v1/bundle-sources` |
| Create | `POST /v1/bundles` |
| Edit | `PATCH /v1/bundles/:id` |
| Save reference | `POST /v1/bundles/:id/library-references` |

CLI: `myskills bundles list|show|members|memberships|sources|create|edit|save`. Mutation bodies use a reviewed JSON file via `--input`. MCP exposes read-only `browse_bundles` and explicit write tool `curate_bundle`; both use fixed routes and the same API permission checks. Neither route installs bundle members.

## Verification and rollout

The pre-implementation HTTP journey uses real disposable Postgres and 31 overlapping members. It covers all view totals, complete member pagination, stale cursors and revisions, cross-audience rejection, source evidence and identity, explicit membership updates, token scopes, team-write MFA denial and verification, reference idempotency, adoption preservation, and a deterministic membership-revocation race. Existing Library journeys guard import, tracking and adoption behavior. Browser journeys verify search, overlap, pagination, forms, access errors, exact-release navigation, mobile layout and keyboard focus. CLI and MCP protocol journeys verify read/write routing and scope denial.

Apply additive migration `0033_skill_bundles.sql` before serving the new API. For a reversible fallback, set `MYSKILLS_BUNDLES_ENABLED=false`: catalog and bundle operations return 404, the web falls back to flat browsing, and Library reference readers remain available. Retain this version of the Library reader and the new tables; older readers do not understand bundle entries. Do not drop adoption or provenance data. No release, deployment or live migration is part of this implementation task.

Excluded: nested bundles, dependency execution, install/adopt-all, version pinning, subscriptions, upstream plugin manifests, organization-owned bundle authoring, and drag-and-drop composition.
