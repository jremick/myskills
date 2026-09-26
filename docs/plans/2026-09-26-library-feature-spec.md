# Libraries: source tracking, curation, and managed updates

Status: first-release implementation authorized on 2026-09-26. The user approved strictly private import self-review with an administrator enable/disable switch. Release scope is phases 1A–1C; later phases remain specified but are not part of this release.

Date: 2026-09-26. Authors: Codex, with a requested Claude Opus design and review pass. Repository baseline: GitHub `main` at `7a0fc44e6a1cabaabfdcf494c3cc96db4cf7d3cc`. Implementation evidence is source-level; this investigation did not test production behavior.

## 1. Product decision

Build **Libraries** as the place to collect useful skills, retain their origins, follow upstream changes, and choose which reviewed versions people use. Reuse the registry for releases and the existing Updates/target system for installation.

The promise: **Know where your skills came from, what changed, and which version you are using.**

Four actions must remain distinct:

| Action | What it does | What it authorizes |
|---|---|---|
| Save | Add a repo, skill, or registry release to a library | Store a reference and permitted metadata |
| Follow | Check that source for relevant changes | Read the source on the chosen schedule |
| Adopt | Accept a specific reviewed release into a library | Change the library's recommended version |
| Install/update | Apply a specific adopted release to a target | A separately authorized local file transaction |

Following a repo never implies publishing its content. Library membership never grants access to a private skill. Adopting a version never implies updating every device. A tag named “patch” never proves that a skill's behavior is safe.

### Recommended first release

Personal libraries and basic team curation; public GitHub repo/subdirectory/skill URLs; pinned import previews; citations; manual, daily, or weekly tracking; a focused change inbox; manual adoption and existing manual install/update flows. Include bookmark-only entries for sources that cannot yet be imported.

Specify private sources, company ownership, broader notification delivery, and unattended updates now, but deliver them through the phase gates in the [delivery plan](2026-09-26-library-delivery-plan.md). The user approved building the scoped first release on 2026-09-26. Private upstream credentials and unattended local updates remain later phases.

### Success and limits

The first useful journey is: save a real repo, choose a complete skill, import the exact previewed bytes, retain attribution, detect a later change, review the diff, and update through the existing delivery path.

An instance administrator can enable self-review of a user's own strictly private imports. This setting defaults to disabled for existing instances. When enabled, passed scans and an explicit owner attestation permit private use without impersonating an instance reviewer. Sharing or publishing that content still requires ordinary registry review. Disabling the setting stops new private attestations; it does not erase existing private installations or releases.

Do not add a second registry, a general Git client, a package-manager replacement, a skill execution service, mandatory usage surveillance, an AI ranking dependency, or an enterprise device-management platform. Do not promise that arbitrary plugins can be split into portable skills.

## 2. Current foundation and gaps

Verified against the refreshed GitHub baseline:

| Existing source contract | Reuse for this feature | Gap |
|---|---|---|
| API/Postgres owns releases, authorization, reviews, immutable artifacts and audit | The same trust boundary for every library client | Source and library domains do not yet exist |
| AUTHOR-1 plans commit-pinned GitHub imports with held-byte previews | One shared import pipeline | GitHub imports and continuous tracking are still planned |
| CLI scaffold, deterministic text package creation, intake validation and scans | Build eligible upstream skill packages | Native frontmatter must map into MySkills' stricter manifest |
| User, team and organization scopes and grants | Library access and ownership vocabulary | Libraries need their own grants; private-source entitlement is separate |
| Updates, immutable upgrade policies, exact releases, leased target operations, companion transactions and rollback | Manual application and later automation | A maintenance window currently limits claims; it does not create automatic updates |
| Organization and target policy constraints are conjunctive | Preserve every applicable ceiling | Library/source restrictions and automation consent must join that decision |
| Auth notification outbox and email transports | Reuse bounded delivery patterns | Auth intents are not a general library notification system |
| MCP skill delivery reads authorized immutable releases | Deliver adopted releases through existing reads | Do not promise automatic host activation or current MCP write support |

Sources: [architecture](../ARCHITECTURE.md), [AUTHOR-1](../ROADMAP.md#authoring-and-imports-author-1), [upgrade contract](../UPGRADE_POLICY.md), [source evidence](2026-09-26-library-review.md). The starting local branch is divergent; it is not the baseline for this proposal.

## 3. People and ownership

| Person | Job to complete | Typical scope |
|---|---|---|
| Individual | Keep a useful selection current without losing personal changes | Personal library and explicitly selected local targets |
| Team curator | Recommend a tested set and explain changes to colleagues | Team library; no automatic control of personal devices |
| Company administrator | Set source, sharing and rollout constraints; maintain continuity when people leave | Organization libraries and explicitly managed targets |
| Member/consumer | Find approved skills, subscribe to relevant changes, choose or inspect updates | Authorized library contents and their own targets |
| Self-hosting operator | Run tracking within credentials, resource limits and retention policy | Instance configuration, not default access to private content |

A library has exactly one owner: user, team, or organization. Ownership is independent of visibility. “Company” maps to the existing organization concept. A team can be standalone or belong to an organization; only an actual parent relationship introduces that organization's rules.

First-release roles reuse existing membership: personal owner manages; team owners curate; team members read, follow, and copy authorized references. A new curator role is deferred until demand justifies it. Organization owners manage ceilings; explicitly authorized admins curate. Keep existing MFA requirements for policy and access-sensitive changes.

Library curation does not grant registry review or publish permission. Imports use the existing review rules except for the explicitly approved, admin-controlled private self-review lane. The API checks current ownership, strict private visibility, scan results and the current setting at the time of attestation. Record private attestation separately from instance review; enforce the sharing boundary in canonical registry mutation and delivery paths.

Do not manufacture an invisible service user to own company imports. Shared source connections and imported assets need durable scope ownership before shared import is released. A library may reference a personally owned release, but must show that dependency; adding it does not transfer ownership or widen grants. Team curation can ship before team-owned imports.

In that first team slice, teams curate only releases already shared with them. They do not own imports or source tracks. The personal lineage owner remains responsible for new import revisions. If that owner is unavailable, freeze the team recommendation, stop owner-authorized tracking and show curators an owner-unavailable state. A fork creates a new lineage and requires explicit rebinding; it cannot take over the old slug.

## 4. Concepts and state

| Concept | Meaning |
|---|---|
| Source | A specific provider repository identity within an authorization scope; includes display URL and health |
| Source selection | Repo, explicit paths, discovered skill roots, plugin root, and exclusions chosen by a curator |
| Track | Selection plus a ref rule, discovery mode and tracking settings |
| Snapshot | Immutable resolved commit and bounded inventory of selected files and hashes |
| Library | Named collection with owner, grants, description, tags and curation defaults |
| Entry | A saved source selection or an existing registry skill; can be reference-only or have an adopted release |
| Candidate | One proposed skill-lineage revision for a snapshot and import profile, with exact bytes, mapped package, diff, findings and review state; related candidates can be grouped for display |
| Adoption | An immutable decision linking an entry to a reviewed MySkills release and its provenance |
| Subscription | Recipient's chosen library/entry events and delivery preferences |
| Target binding | An entry/adoption linked to an existing target installation, update policy and installation authority |

Use ordinary folders/tags inside a library initially. Do not create nested policy-inheriting library graphs.

In new technical contracts use `UpstreamSource`, `upstreamRef` and `upstreamVersionLabel`. Existing `minimumSourceVersion` refers to the installed version an upgrade starts from; it must not be reused for upstream repository versions.

Display source health, candidate state and installation state separately. A useful entry can say: “Source checked yesterday; new candidate needs review; library recommends revision 4; this target has revision 3; another target is offline.” Do not collapse this into “outdated.”

Source health: `not-tracked`, `healthy`, `checking`, `rate-limited`, `access-lost`, `unavailable`, `archived`, `identity-change-review`, `paused`.

Candidate lifecycle: `discovered -> preparing -> ready-for-review -> accepted | ignored | rejected | blocked | superseded`. Acceptance creates or links a registry submission; **only an approved, deliverable release can become adopted**. A review-pending candidate remains distinct from a library's current adoption. Preserve rejected and superseded history within retention rules.

A registry `request-changes` outcome blocks adoption. Correct it with an explicitly reviewed mapping/adapter change or a derived fork, then create a new candidate revision. Never edit the original upstream snapshot or an approved artifact in place.

Snapshot, approval, adoption and target receipt are separate records. Record `discoveredAt`, `lastAttemptAt`, `lastSuccessfulCheckAt`, upstream publication time, adoption time and target observation time independently.

## 5. Main journeys

### J1: Save and import from GitHub

1. Choose a library and paste a GitHub repository, directory or `SKILL.md` URL.
2. Resolve provider identity and ref. Show owner, license evidence, selected ref, exact commit, discovery completeness and tracking cost/limits where relevant.
3. Show discovered skill roots and supporting-file counts. Exclude examples, fixtures and generated output from default selection. Let the user refine paths.
4. Choose **Save reference** or **Import selected skills**. Adding all currently discovered skills is an explicit selection; future discoveries remain reviewable by default.
5. Preview package contents, unresolved dependencies, metadata mapping, name collisions, excluded files, license notices and compatibility. Import nothing if the preview is incomplete or unsafe.
6. Confirm the immutable preview, submit through normal registry review, then adopt the approved release. An upstream branch moving cannot change the held snapshot.
7. Offer tracking, subscription and installation as separate settings. The initial save can succeed while an import is blocked, with an actionable explanation.

An existing registry skill can be added directly as a reference. “Copy to my library” copies an authorized reference, not ownership or entitlement. “Fork and edit” creates a new derived lineage and preserves its origin.

### J2: Upstream changes

A scheduled check or verified webhook resolves the selected track, compares exact manifests, and records a candidate only when relevant state changes. The curator sees added/changed/removed files, new or removed skills, release notes, dependency and capability changes, license changes, and affected adoptions. They can compare, ignore this candidate, snooze the entry, pause tracking, reject, or submit/adopt a reviewed update.

New releases with identical selected bytes appear in source history without generating an install operation. Edits to release notes update metadata history without changing approved bytes. A changed shared file marks every selected package that includes it as affected.

### J3: Team rollout

A curator adopts a reviewed version. Eligible subscribers receive “approved update available,” with release notes and actions appropriate to their permissions. Members can update their own installations. A team administrator cannot silently enroll a personal device. Organization-managed targets follow their explicit enrollment and execution consent.

A later phase supports a pilot target group, an observation interval, then a broader rollout. Failure or drift pauses further scheduling. Fleet status counts installed files, pending reload, failures, offline targets and unknown state separately.

### J4: Local customization and competing installers

If the managed content hash differs from its baseline, stop automatic application and show the three versions: imported base, local content and proposed upstream. Offer keep local and pin, preserve local as a derived skill, or explicitly replace after saving a rollback snapshot. Automatic three-way merge is deferred.

If a host plugin manager owns the installation, track it as externally managed and link to its native update path. MySkills must not overwrite that manager's cache or claim transactional control. Transferring management requires an explicit migration preview and a single declared owner for each target path.

### J5: Stop tracking, leave a team, or lose source access

Use **Follow source** for an owner/curator's tracking configuration and **Subscribe to updates** for a recipient's notification choice. Members can unsubscribe themselves; they cannot stop a curator's track.

| Action | Consequence |
|---|---|
| Unsubscribe | Stops that recipient's notifications; source tracking and installations continue |
| Stop following source | Stops checks for that track; preserves adoptions, subscriptions and historical evidence |
| Remove entry | Ends its subscriptions, revokes automation grants and cancels unclaimed entry-derived operations; a now-unreferenced track stops |
| Delete library | Applies entry removal effects, soft-deletes the library for a proposed 30-day restore period, and retains required history |
| Restore library | Restores authorized records; does not silently restore automation grants or restart cancelled operations |

Claimed operations recheck entry/grant state before further authorized transitions. Entry removal leaves installed files and registry releases intact. Bindings become `curation-unavailable` and stay pinned to the last adopted version until the user explicitly rebinds or selects ordinary registry management. Never silently fall back to unconstrained registry updates. Show dependants and these consequences before deletion.

Membership and source credential changes are checked at execution and delivery time. Removed users receive no future private content or notification detail. Access loss pauses checks and prevents new private delivery; it does not prove the repo was deleted. Installed local copies cannot be remotely recalled while a device is offline. Revocation, explicit uninstall and organizational retention actions remain distinct.

## 6. Settings and defaults

All defaults below are proposals. Display the effective value, its scope, any enforced ceiling, and the reason an override is blocked.

| Setting | Options | Proposed default |
|---|---|---|
| Tracking | Off; manual; scheduled | Off for a saved reference; daily proposed during import |
| Schedule | Manual, daily, weekly; later 6-hour, hourly, custom bounded interval | Daily after explicit enablement |
| Update source | Published stable releases; tags matching a configured prefix; branch; exact commit | Stable releases when available; ask before branch fallback |
| Prereleases | Exclude/include with policy permission | Exclude |
| Ref rule | Exact branch/tag or validated simple tag-prefix mapping | No arbitrary user regex in the first release |
| File selection | Specific skill roots; explicit repo/plugin root; include/exclude paths | Selected skill roots and their verified supporting files |
| New skills | Discover only; propose additions; later auto-add eligible reviewed entries | Propose additions; never silently install |
| Removed/renamed skills | Alert; explicit remap/retirement | Keep installed version and flag; no automatic deletion |
| Candidate handling | Notify only; prepare import candidate; later policy-approved unattended adoption | Prepare a reviewable candidate; manual adoption |
| Adopted version | Exact immutable release; later stable/canary channel pointers | Exact release |
| Notification audience | Me; selected team/library subscribers; all eligible subscribers | Curators for upstream candidates; subscribers for adopted updates |
| Delivery | In-app; later email; later selected external connectors | In-app; optional daily email digest when delivered |
| Event filter | Candidates, adopted updates, new skills, security/revocation, source failures, target outcomes | Relevant adopted updates and actionable failures |
| Noise controls | Digest, snooze, mute, entry filter, quiet hours | Coalesce unchanged events; no periodic “all healthy” messages |
| Local updates | Manual; download/stage only; unattended approved updates | Manual |
| Apply timing | On explicit command; approved maintenance window | Existing manual flow |
| Automation eligibility | Reviewed stable release, no required user action, allowed diff/capabilities and license, compatible target, no drift | All checks required; version labels alone never grant approval |
| Pin and hold | Pin exact release; hold until date; pause indefinitely | Available at entry and target binding |
| Failure handling | Stop this target; pause rollout | Pause affected target and future rollout on material failures |

Tracking cadence, notification cadence and local application cadence are independent. A weekly subscriber does not prevent another subscriber's daily check. Shared fetching can use the fastest authorized track, while each recipient retains their delivery cadence. “Off” promises no checks on behalf of that track, not that another authorized public subscriber cannot fetch the same repo.

Scheduling uses UTC due times; user-facing windows retain an IANA time zone. Interval checks use elapsed time. Recurring digests/windows follow local calendar time; daylight-saving skips run at the next valid time and repeated clock times do not duplicate a digest or operation. Display requested cadence and actual `nextCheckAt`; resource limits can delay checks and must be visible.

## 7. Notifications and the meaning of everyone

“Everyone” must always name a boundary in the UI: **all eligible subscribers to this library**, **members of this team who subscribed**, or **organization subscribers**. It never means all MySkills accounts. Source authors do not gain a broadcast channel to people who saved their repo.

Calculate recipients from event scope, current membership, content entitlement, subscriptions, event filters and channel preference. Recheck before dispatch and again when a recipient opens the link. Library access alone cannot reveal an unavailable private entry's title, repo URL, release notes, installation count or people using it.

Consumer lists omit unauthorized entries and their counts entirely. Only a curator already entitled to the reference can see its access-blocked diagnostic; library membership is not sufficient for that diagnostic.

Curators see upstream candidates. Consumers normally see versions they can actually adopt or install. Deduplicate by recipient, semantic event, entry/adoption and channel. Consolidate multiple entries from one repo into a digest. A retry must not create a second in-app item; external email may still have an ambiguous delivery outcome and must not claim exactly-once delivery.

Use a transactional event/outbox record, bounded retry with backoff, delivery status and a dead-letter/operator path. Reuse transport adapters where suitable, not auth action payloads or token workflows. Private email defaults to minimal text plus an authenticated link. Even source-existence metadata is sensitive; external notifications are opt-in for private sources.

Security and revocation notices are separate from upstream self-reported “security” labels. A registry authority can mark a release revoked; an upstream label only creates evidence for review. Mandatory company security notices require an explicit documented organization policy, with the narrowest content and audience.

## 8. Source identity, provenance and packaging

### Identity and citation

Record provider + stable repository ID + owner scope; retain URL history. Within a track, a source item has a stable MySkills ID and an explicitly mapped path. A rename can be suggested by matching bytes or provider diff evidence, but path similarity alone cannot silently bind a different skill. A transfer or owner change triggers review even if the repository ID survives; deletion and recreation at the same URL is a different source.

Every imported release records: repository ID, display URL, original author/attribution when available, requested ref rule, exact commit, selected root paths, per-file hashes, snapshot digest, release/tag IDs and labels, retrieval time, importer/schema version, all transformations, license/notice file evidence, original snapshot digest, output artifact digest and derived-from links. Attribution is not an endorsement or authenticity guarantee.

Show the origin on the entry, skill details, candidate diff and export/install manifest. Source-backed citations use immutable commit URLs. Private citation URLs are subject to authorization. Preserve required license notices in exported package bytes; a URL alone is insufficient evidence of retained notices. Missing or ambiguous rights permit a reference-only entry; imported distribution stays blocked pending an explicit rights decision. This specification does not determine legal permission automatically.

### Exact versions and transformations

Keep upstream version labels separate from MySkills version identity. A repository may have no versions, several products, prefixed tags, dates, or a moved tag. Record all of them without pretending they are valid SemVer.

Use an importer-owned monotonically increasing package version for each imported lineage, such as `0.0.1`, `0.0.2`, with the upstream label displayed alongside it. It must be visibly described as an import revision, not upstream compatibility semantics. Do not use build metadata alone to order revisions. Existing versions remain unchanged; link an existing release only after exact byte/provenance verification. Allocate new revisions transactionally with uniqueness constraints and idempotency.

A lineage follows one explicit release line/ref rule. Accepting a candidate compares its expected prior adoption and source order under a lock. A later accepted source snapshot supersedes older pending candidates; accepting an older or noncomparable snapshot cannot silently allocate a newer revision. Use verified version ordering and/or commit ancestry when applicable. If order cannot be established, require an explicit track change or intentional revert decision. A revert gets a new revision, a recorded reason and conservative change metadata; it is never disguised as forward upstream progress.

Keep candidate change classification `unknown` until reviewed. When mapping an unclassified candidate into the current release schema, explicitly set `changeKind: breaking` and `requiresUserAction: true`; never inherit the existing default `maintenance`. A reviewer can set a supported classification with recorded evidence before submission. Automatic application evaluates every known skipped release and the provenance/compatibility findings, not just the destination label or numeric version increment.

The import API rejects missing explicit release metadata. A conservative mapping must be visible in the preview. Metadata that exceeds the manifest's bounds, including a long description, requires a reviewed mapping; source text is not silently truncated.

Generated MySkills metadata belongs in a separate import manifest. The owner approved explicit runtime-name normalization for beta.8 on 2026-09-26: the runtime `SKILL.md` name matches the unique registry slug, and `myskills-source-skill.txt` retains the exact upstream original. Preserve other frontmatter, body and supporting-file bytes. Preview the original and installed names, original path and both SHA-256 digests; include the transformation in the import manifest and immutable provenance. Both copies count toward limits and scans. Block ambiguous frontmatter or a reserved-path collision. Do not rewrite invocation text invisibly.

MySkills slugs are currently instance-wide. First-release imports allocate a valid slug with a readable prefix and an opaque lineage suffix on every import, within the existing 64-character limit. The server reserves it transactionally and retries collisions without disclosing another scope's allocation. Users can edit display aliases; they do not probe private lineages by requesting a bare global slug. Do not introduce slash-namespaced slugs or change existing URLs as part of this feature.

Keep three identities: registry slug, original native runtime name, and adapter install key. The beta.8 Codex adapter uses the registry slug for both its filesystem path and normalized runtime name, retaining the original name as source evidence. Future adapters that preserve source invocation names must detect duplicate native names across installed packages; distinct directories alone do not prevent a host-level collision. If a target requires names to match, block the mapping or preview an explicit reviewed rename. A platform may be marked supported only after its existing adapter/package contract checks pass; show runtime activation evidence separately and never redefine an existing support flag to bypass compatibility checks.

### Dependency and host limits

Discover skill roots using supported manifest conventions plus bounded `SKILL.md` scanning. Resolve literal relative file references within the approved snapshot. Treat dynamic references, cross-skill calls, external tools, MCP servers, hooks and environment needs as explicit compatibility findings. A text scan cannot prove semantic dependency completeness.

Package the complete reviewed file closure, including supporting assets and license notices. Reject path traversal, case/Unicode collisions, symlinks outside policy, submodules, Git LFS pointers, oversized files or archives, unsupported binary content and unapproved cross-root dependencies. Do not fetch a referenced external URL during import. Do not silently drop required files to fit a limit.

The existing intake supports bounded UTF-8 text packages and strict MySkills manifests. Preserve those limits for the first release. A plugin requiring binary files, hooks, shared host configuration or unsupported conversion remains reference-only until a tested adapter exists. Copying files successfully does not prove the host can run the skill.

## 9. Worked example: Compound Engineering

Observed on 2026-09-26 from GitHub, not installed or executed in this investigation:

| Evidence | Observation | Product consequence |
|---|---|---|
| Repository identity | `EveryInc/compound-engineering-plugin`, ID `1073224021` | Match source identity independently of a typed URL |
| Main snapshot | `a763b392c3c05faa1a383c0d228b7e95200ecc90` | A branch is a moving observation, not an install identity |
| Stable release | `compound-engineering-v3.29.0`, release ID `396790340`, tag resolves to commit `4043703d32c5df9e35f22757dee22f3a72a99c66` | Product-prefixed tag mapping; stable release and main differ |
| Main inventory | 36 root `skills/*/SKILL.md` files; multiple host manifests | Repo discovery must distinguish skills from plugin packaging and fixtures |
| `ce-plan` at the release commit | 38 files, 589,431 blob bytes within its directory; none differ on the inspected main snapshot | Importing only `SKILL.md` is incomplete; different repo commits do not necessarily require a skill update |
| License/author metadata | MIT file; plugin manifest identifies authors and version | Retain notice evidence and attribution without claiming endorsement |
| Upgrade guidance | Layout migration and host reload requirements | A new release can change packaging and require user action |

Example flow: save the repo; choose stable releases with prefix `compound-engineering-v`; resolve the release commit; inventory **that commit**; select `ce-plan`; preview its complete package and unresolved cross-skill/host requirements; create a private imported revision for review; adopt after approval; enable daily checks. Both inspected trees independently contain 36 root skills. The file count and byte total above exclude generated manifests and root license notices; they establish inventory size, not package validity or runtime compatibility.

If the next release changes only unrelated skills, show source history without proposing a `ce-plan` file update. If its supporting references change, create a candidate. If it requires another skill or a host migration, block unattended application and explain the requirement. If the user selects the whole plugin, offer native installation guidance/reference tracking until an adapter proves complete managed support.

Sources: [pinned repository](https://github.com/EveryInc/compound-engineering-plugin/tree/a763b392c3c05faa1a383c0d228b7e95200ecc90), [release](https://github.com/EveryInc/compound-engineering-plugin/releases/tag/compound-engineering-v3.29.0), [pinned ce-plan](https://github.com/EveryInc/compound-engineering-plugin/blob/a763b392c3c05faa1a383c0d228b7e95200ecc90/skills/ce-plan/SKILL.md), [license](https://github.com/EveryInc/compound-engineering-plugin/blob/a763b392c3c05faa1a383c0d228b7e95200ecc90/LICENSE).

## 10. Private sources and authorization

Private GitHub support is a distinct delivery phase. Prefer a repository-selected GitHub App connection with read-only contents/metadata access and short-lived installation tokens. Personal connections belong to the user; team/company connections belong to their durable scope. Keep provider authorization separate from MySkills login and from permission to redistribute a snapshot. GitHub recommends narrow permissions and token scope. [GitHub App guidance](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app)

The importer must not assume that installing an App makes every MySkills member entitled to every private repo. A connection administrator selects allowed libraries and downstream audiences. Reads require both the source-distribution grant and the existing registry/library permission. A user moving a private reference into a broader library sees a blocked or redacted entry until authorized grants exist; no automatic widening.

Store credential references in database records; keep credentials in the project's approved secret store. Never put source tokens in exported packages, URLs, browser payloads, logs or companion commands. The local companion fetches approved artifacts from MySkills and need not receive GitHub credentials.

Revocation, App suspension, repo removal and membership loss invalidate new jobs/deliveries and queued automated updates. Recheck at fetch, candidate acceptance, adoption, notification dispatch, artifact delivery and operation claim. Previously fetched content is quarantined from new delivery when source-distribution authority is unknown; retain only what the explicit retention policy allows. Existing approved snapshots can resume only after current authority is established, not merely because a cache exists.

Default private fetch/cache keys include owner scope, provider installation/connection, repository identity and credential generation. Do not share private metadata or content caches across scopes. Public caches still require current access classification and must never serve content obtained using private credentials as public data.

If a formerly public repo becomes private, pause tracking and block future delivery until a curator records a rights decision or connects authorized private access; a nonexistent public credential cannot be “reauthorized.” If a public repo is merely deleted or temporarily unavailable, stop/degrade tracking and preserve delivery of approved snapshots under recorded rights, unless an actual revocation or rights issue applies. Private connection suspension closes its derived-release delivery gate under the stated policy. These gates do not silently change registry lifecycle history. Already downloaded files cannot be recalled.

## 11. Tracking engine and safety

Use a bounded source worker and Postgres-backed job state with leases, idempotency and due-time indexes. Do not require Redis or a new workflow framework in the first implementation. Jobs fetch and compare data; they never execute repository instructions, scripts, build hooks or package install commands.

Public sources outside the user's control often cannot send this application webhooks. Use conditional polling there. For installed GitHub App sources, verified webhooks trigger an early check, with periodic reconciliation for missed events. A webhook is a hint to re-read authoritative state, not a trusted release artifact. Verify signatures, bound payloads and deduplicate delivery IDs. GitHub does not automatically redeliver failed deliveries. [Webhook failure guidance](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries)

Honor `ETag`, `Retry-After`, reset times and pagination; avoid burst concurrency per credential; add jitter and bounded retries. If inventory pagination or tree retrieval is truncated, mark the snapshot incomplete and publish no partial candidate. The UI displays delayed or incomplete checks. [GitHub REST guidance](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)

Freeze the ref to a commit before fetching files. Verify every file against the snapshot manifest and verify the output artifact at each existing delivery boundary. No branch/tag may replace bytes after preview. A tag moving creates a distinct source event, pauses unattended adoption, and preserves both resolutions. Force pushes and deletions do not silently downgrade a library.

URL support begins with HTTPS GitHub URLs mapped to fixed provider API hosts. Disallow embedded credentials, arbitrary fetch hosts, local/private IP destinations, unsafe redirects and shell interpolation. Download through an allowlisted adapter with time, byte, path, archive-expansion and file-count limits. Render upstream Markdown as untrusted text with safe links; do not load remote tracking images automatically.

A scanner passing is evidence about its checks, not proof of harmless behavior. Executable scripts, hooks, new tools/MCP servers, network destinations, permissions, license changes and unresolved dependencies block automatic adoption. AI summaries are optional later enhancements and cannot authorize an update or send private source content to a model by default.

## 12. Controlled local auto-update

There are two opt-ins: **unattended library adoption** and **unattended target application**. Deliver automatic application of already reviewed/adopted releases first. Unattended upstream adoption is a later, higher-risk capability and can remain disabled indefinitely.

An automation grant binds actor/delegated authority, library entry, approved channel, target ID/generation, policy revision, capabilities, allowed change conditions, expiry/revocation and installation ownership. Selecting a library is never blanket permission to add software, run hooks or alter host settings.

The scheduler creates existing target operations with exact release/version/digest, expected prior install identity, adoption ID and automation grant reference. At enqueue, claim, lease renewal, promotion and receipt, evaluate all current source, library, organization and target constraints. Policies combine by intersection; conflicting pins or disjoint windows yield an explicit blocked result. A team library rule constrains a personal target only for the entry the user explicitly subscribed that target to.

Library-bound installations add the current adoption as a dynamic exact-version constraint called `library-adoption`. It participates in existing Updates discovery, direct update requests, operation scheduling and claim checks from the first manual integration. Do not copy it into target policy revisions or offer an approved-but-unadopted version. Bindings are opt-in for both connected targets and standalone CLI installations; the latter retain a local entry reference and obtain an authorized adoption decision from the API when checking updates. Loss of that authorization preserves the installed pin and blocks automatic fallback.

Only one effective desired version may control a target/install key. Identical adoption versions can share a binding's reasons; conflicting libraries block until the user explicitly chooses or detaches a source. Detachment is a recorded local override and is unavailable where a managed organization policy forbids it.

Automatic eligibility checks the complete installed-to-proposed change range, including intermediate releases the curator never adopted and retained adverse evidence from rejected/revoked candidates. A skipped required user action, dependency/capability or license change blocks with `requires-user-action` or another specific reason. Compare installed-base bytes to destination bytes as well as the candidate-to-adoption diff. Existing change-kind checks are reused; the additional automation gate must explicitly cover `requiresUserAction` across the range.

Only already installed, MySkills-managed entries with current consent are eligible by default. New skills require explicit installation approval. A newly granted capability, source identity change, required user action, unknown compatibility, drift, missing rollback data, expired authority or unsupported adapter pauses automation.

Companions pull approved operations over an outbound connection. Use the existing lease/fencing/journal/atomic-swap/readback path, with a local exclusive lock and a final filesystem baseline check before promotion. Never mutate a native plugin manager's cache. Do not install a background daemon merely because a user enables tracking; enabling background application includes explicit companion setup and a clear status when it is not running.

Offline targets remain pending/unknown. On reconnect, recheck current desired adoption and permissions; supersede obsolete queued updates with an auditable chain, not blind replay. A grant revocation blocks further claims and promotion once known. Offline local files cannot be guaranteed immediately revoked. Interrupted swaps recover through the journal; failed targets pause while successful targets retain independent receipts.

Do not perform new unattended writes while disconnected from the authority needed to renew/validate the operation. Cancellation cannot promise to undo a filesystem promotion already completed; record its actual outcome and reconcile it. Grouped candidate review is not multi-skill atomic installation. Cross-skill coupling blocks unattended updates until an adapter proves an appropriate group transaction; the first release reports mixed manual results explicitly.

“Updated” means verified file and install-registry state. Show `reload required` separately. Never claim that the host reloaded, activated or actually used a skill unless a supported adapter provides that evidence. Rollback restores verified package files and registry state; it cannot undo actions a skill performed, external side effects or revoked authorization.

## 13. Experience and client surfaces

Add **Libraries** to navigation. Keep **Updates** as the common action centre, with views for upstream changes, library adoptions and target updates rather than three separate notification products.

The library page has an owner/scope label, source health, entries, filters, search, and an **Add source** action. Entry detail shows origin, selected/adopted/installed versions, compatibility, included files, license evidence, history, subscriptions and effective policy. Settings use simple defaults with advanced options progressively disclosed. Hide unavailable actions with a clear reason; do not present future capabilities as working toggles.

Search only authorized entries. Show duplicate origins and name collisions without merging ownership. A library may contain the same upstream skill at different explicit pins, but a single target/path cannot have two managers or conflicting selected versions.

Use keyboard-accessible forms, labelled status text, sensible empty/error/offline states, and diff views that work without color. Browser preview never needs source credentials or local paths.

Proposed CLI family: `myskills library list|show|create|add|remove`, `myskills source check|status`, and candidate preview/adopt commands. Exact grammar is finalized with existing CLI conventions during implementation. Every mutation supports an immutable preview and structured JSON result; existing `updates`, `update --dry-run`, `update` and `rollback` remain the install surface.

API and CLI can perform all library workflows without browser-only privileges. Extend MCP with authorized library/source/candidate reads first. Continue existing skill-content delivery; MCP mutation tools require a separately scoped contract and explicit action confirmation, not implicit writes triggered by reading a skill.

## 14. Prioritized improvements

| Improvement | Why it matters | Priority |
|---|---|---|
| Reference-only collection | Useful before import compatibility is solved | First release |
| Selection-aware change digest | Removes repo churn unrelated to chosen skills | First release |
| Explain why an update is blocked | Makes policy and compatibility actionable | First release |
| New-skill discovery inbox | Turns following a repo into useful discovery | First release |
| Duplicate origin/name detection | Prevents redundant or conflicting installs | First release |
| Pin, snooze, pause and ignore one candidate | Gives users control without abandoning the source | First release |
| Library snapshot/lock export | Reproducible onboarding and team environments | After manual loop; reuse exact architecture refs |
| Adoption presets such as “personal manual” and “team reviewed” | Reduces settings burden | After real defaults are validated |
| Source trust/health history | Identifies abandoned or transferred sources | Tracking phase; factual indicators only |
| Curator notes and compatibility evidence | Explains why a team recommends a version | Team curation |
| Fork lineage and three-way comparison | Supports useful local customization | Fork comparison early; merge assistance later |
| Pilot rollout and aggregate coverage | Limits blast radius and shows outstanding updates | Auto-update phase |
| Optional AI change summaries | Helps interpret long changes | Later; deterministic evidence stays authoritative |
| GitLab, other hosts, local folders/ZIP provenance | Expands source coverage | Reuse AUTHOR-1 after GitHub contract is proven |

Do not add popularity scores or claimed trust ratings as a substitute for evidence. “Installed” and “used” are different: update relevance can use opt-in target inventories; actual usage telemetry remains optional and is not required for core functionality.

## 15. Requirements and acceptance

| ID | Requirement | Decisive acceptance case |
|---|---|---|
| LIB-01 | Create and curate scoped libraries | A personal owner and team owner can manage their scope; another tenant cannot enumerate it |
| LIB-02 | Save references without importing or tracking | Saving an unsupported plugin produces a useful entry and no package/install job |
| LIB-03 | Discover complete source selections | A nested repo reports explicit roots, support files, exclusions and incomplete discovery |
| LIB-04 | Freeze import preview and provenance | A branch changes between preview and confirmation; confirmed bytes remain the previewed snapshot or fail |
| LIB-05 | Preserve original bytes, mapping and notices | Export identifies source commit/path and transformation; required files remain byte-identical |
| LIB-06 | Separate upstream and registry versions | Prefixed tags, no-tag branches and two commits with the same label create unambiguous ordered import revisions; accepting an older snapshot cannot silently create a newer update |
| LIB-07 | Track schedules and health honestly | Rate limiting, missed checks and access loss show stale state and next retry, never false freshness |
| LIB-08 | Detect relevant changes | Unrelated files cause no install candidate; changed support files do; renamed/deleted roots require explicit action |
| LIB-09 | Keep approval and adoption separate | A ready candidate or pending submission cannot become an installable library recommendation |
| LIB-10 | Compose access and policy constraints | A private entry in a visible library stays unreadable; approved but unadopted releases are excluded; conflicting library versions, pins and windows stay blocked |
| LIB-11 | Deliver scoped notifications | An unsubscribed or removed member receives no private update; duplicate events yield one in-app item |
| LIB-12 | Preserve local ownership and modifications | Drift and another package manager's files block automatic writes |
| LIB-13 | Apply only under a current automation grant | Policy/grant revocation between queue and claim or promotion blocks the update; a skipped revision requiring user action prevents unattended application |
| LIB-14 | Recover and report target outcomes | Offline, interrupted, stale-worker, partial-batch and reload-required states remain distinct and recoverable |
| LIB-15 | Maintain private-source boundaries | Connection suspension cancels future fetch/delivery; cross-scope caches leak neither content nor metadata |
| LIB-16 | Keep lifecycle actions independent | Unfollow/remove/delete does not silently uninstall or rewrite historical release bytes |
| LIB-17 | Support client parity and accessible review | API/CLI perform the same authorized flow; keyboard users can review and resolve a candidate |
| LIB-18 | Bound operational cost and retention | Duplicate tracks coalesce within their auth scope; limits fail clearly; audit and artifact retention are enforced |

The [delivery plan](2026-09-26-library-delivery-plan.md) maps these requirements to phases, contracts and validation. Full-feature completion requires all applicable cases; a first release must be labelled with its narrower supported scope.

## 16. Metrics, open decisions and stop conditions

Measure time from adding a source to first successful adoption; percentage of attempted imports yielding a complete preview; tracking freshness against configured cadence; actionable candidates versus irrelevant alerts; candidate-to-adoption time; verified update/rollback success; drift blocks and notification opt-outs. Record installed coverage and observation age, not inferred skill usage. Targets and thresholds should be chosen after pilot baselines, not invented as current performance claims.

Initial engineering targets for the pilot: no cross-scope disclosure, no unapproved writes, no lost local edits, deterministic replay of a held snapshot, and no duplicate adopted revisions under retries. These are acceptance invariants, not a statistical promise of zero future defects.

Decisions to confirm before implementation: personal/team priority; private repos in the first release or phase 2; whether shared imported assets require durable team ownership immediately; first managed host; email delivery scope; acceptable per-instance source budgets. Recommended defaults are public sources first, personal imports plus team curation, existing Codex companion first, in-app notifications first, manual adoption, and auto-application only after the manual loop is proven.

Approved review-lane decision (2026-09-26): add `self-reviewed/private-only`, controlled by an instance administrator. Require MFA for setting changes and private attestation, and audit both. Default disabled on migration. Existing private copies remain available after disabling; new attestations fail. Widening visibility, adding sharing grants, or publishing requires ordinary instance review. A pending preview cannot cache authority from a previously enabled setting. Do not encode the private attestation as an instance reviewer's approval.

Stop and propose a scope change if the chosen real-source package requires unsupported binary/plugin behavior; source rights are unresolved; existing ownership cannot preserve the approved team lifecycle; the first slice requires a new credential architecture; or a policy composition path cannot preserve current authorization. Do not hide these issues with silent conversion, synthetic ownership or skipped files.
