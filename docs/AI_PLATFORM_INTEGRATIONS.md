# AI Platform Integration Contract

Version: 0.1.0
Last updated: 2026-09-01

## Status

Research and design baseline. This document does not claim that MySkills can
currently install, publish, or reconcile skills in ChatGPT, Claude, or
Perplexity. The proposed initial product slice is an export and guided-install
workflow; the current branch has no provider-specific projection or guided-
install implementation. Live adapters require separate implementation and
validation.

The architecture boundary is recorded in
[ADR 0005](adr/0005-ai-platform-integration-boundaries.md).

## Purpose

MySkills should help a non-technical user take one reviewed skill release and
use it in a supported AI web or desktop application. It should also give a
workspace administrator a governed path for distributing the same release.

The platforms do not expose one common management system. MySkills must project
one canonical release into platform-specific packages and delivery methods. It
must not imply that a generated download is installed, enabled, or still
current unless the destination platform supplies evidence for that state.

## Evidence Language

This document uses three labels:

- **Fact:** a current official source describes the capability.
- **Inference:** the conclusion follows from the sources but is not an explicit
  provider guarantee.
- **Decision:** the proposed MySkills product or architecture rule.

Provider features, eligible plans, package rules, and admin controls can change.
They require a live compatibility check before MySkills labels an adapter as
supported.

## Current Provider Capabilities

Research date: 2026-08-30. Sources are provider-owned help or developer pages.

| Platform surface | Native skill path | Managed distribution path | Runtime integration path | Current MySkills interpretation |
| --- | --- | --- | --- | --- |
| ChatGPT web and desktop | Eligible Business, Enterprise, Healthcare, and Edu workspaces can create, upload, share, and install skills. Admins can control these actions. | ChatGPT workspace plugins can include skills, apps, and app templates. Admins can import supported plugin manifests from GitHub and configure role-based availability. | Custom apps can connect through MCP and the Apps SDK, subject to workspace controls. | Native skill export, workspace plugin, and MCP app are distinct targets. |
| OpenAI API | The API exposes versioned skill resources scoped to the current API project. | API lifecycle can be automated with project credentials. | Responses API tools and remote MCP are developer surfaces. | An API project skill is not evidence of a ChatGPT workspace install. |
| Claude web and Cowork | Claude users can upload a ZIP that includes `SKILL.md`. Skills require code execution. | Team and Enterprise organizations can provision skills. Organization plugins can be uploaded or synchronized from private or internal GitHub repositories, with install policies and Enterprise group overrides. The documented plugin setup requires Cowork and Skills to be enabled. | Claude supports connectors and remote MCP integrations. | Native skill export, organization plugin, and remote MCP are distinct targets. |
| Anthropic API | The beta API exposes skill creation and versioned skill resources through an API key. | API lifecycle can be automated within the credential's authorized developer scope. | Skills can be used with supported API execution environments. | An API skill is not evidence of a Claude.ai organization install. |
| Perplexity web and desktop | Computer Skills can be created conversationally or uploaded as Markdown or a ZIP with `SKILL.md` at the root. The documented upload limit is 10 MB. | Enterprise roles include a `Manage organization skills` permission. Projects can contain project-scoped skills. No public skill registry API or GitHub marketplace synchronization was located in the current official documentation. | Perplexity currently documents local MCP on its macOS app. Its help center says remote MCP is coming soon. | Start with guided export. Treat organization publishing, remote MCP, and reconciliation as unverified until official interfaces and live pilots prove the workflows. |

### Official sources

- ChatGPT skills: [Skills in ChatGPT](https://help.openai.com/en/articles/20001066-skills-in-chatgpt)
- ChatGPT workspace plugin administration: [Manage plugins in your ChatGPT workspace](https://help.openai.com/en/articles/20001504)
- Codex and ChatGPT plugin manifests: [Plugins in Codex](https://help.openai.com/en/articles/20001256-plugins-in-codex)
- ChatGPT apps and custom MCP apps: [Apps in ChatGPT](https://help.openai.com/en/articles/11487775)
- OpenAI API skill resources: [Skills API reference](https://developers.openai.com/api/reference/go/resources/skills)
- Claude native skills: [Use Skills in Claude](https://support.claude.com/en/articles/12512180-use-skills-in-claude)
- Claude organization skills: [Provision and manage skills for your organization](https://support.claude.com/en/articles/13119606-provision-and-manage-skills-for-your-organization)
- Claude organization plugins: [Manage plugins for your organization](https://support.claude.com/en/articles/13837433-manage-plugins-for-your-organization)
- Anthropic API skill resources: [Create a skill](https://platform.claude.com/docs/en/api/beta/skills/create)
- Perplexity Computer Skills: [How to use Computer Skills](https://www.perplexity.ai/help-center/en/articles/13914413-how-to-use-computer-skills)
- Perplexity Enterprise permissions: [Enterprise roles and permissions](https://www.perplexity.ai/help-center/en/articles/11187754-enterprise-roles-and-permissions)
- Perplexity Projects: [What are Projects?](https://www.perplexity.ai/help-center/en/articles/10352961-what-are-spaces)
- Perplexity MCP support: [Local and remote MCPs for Perplexity](https://www.perplexity.ai/help-center/en/articles/11502712-local-and-remote-mcps-for-perplexity)

## Findings

### Facts

1. All three providers have a user-facing skill concept that can consume an
   instruction document or package.
2. ChatGPT and Claude expose separate organization distribution mechanisms in
   addition to individual skill upload.
3. ChatGPT/OpenAI and Claude/Anthropic expose developer API skill resources.
   OpenAI documents project scope; Anthropic requires a developer API key.
4. ChatGPT and Claude expose MCP-based runtime integration paths. Perplexity
   currently documents local MCP for its macOS app and describes remote MCP as
   coming soon. MCP is a connector or tool path, not a substitute for native
   skill packaging.
5. Enterprise controls differ by provider. Role names, sharing scope, review,
   scanning, analytics, Git synchronization, and installed-state visibility
   are not portable concepts.

### Inferences that require live validation

1. A useful instruction-only skill can probably share a portable Markdown core
   across the three platforms. Provider packaging and metadata still require
   separate validation.
2. ChatGPT's accepted Claude plugin manifests can reduce duplicate packaging
   for some managed-distribution cases. This does not establish full behavioral
   compatibility between the two runtimes.
3. Perplexity organization skill management appears usable through its product
   UI, but the current evidence is insufficient for an automated publisher or
   an installed-state reconciler.
4. Provider admin analytics can help an administrator assess adoption, but
   they do not necessarily expose a stable programmatic readback to MySkills.

## User And Administrator Journeys

### Individual or non-technical user

The primary action is **Use in…**, not **Export adapter**.

1. The user selects ChatGPT, Claude, or Perplexity.
2. MySkills asks for the relevant context: personal use, a team/workspace, or a
   developer API project.
3. MySkills shows only delivery methods supported for that context.
4. For the first release, MySkills generates a validated download and presents
   short provider-specific upload steps.
5. The user can record that they completed the upload. MySkills labels this
   state **user confirmed**, not **provider verified**.
6. MySkills keeps the source release and digest visible so that the user can
   later compare or replace the installed copy.

The user should not need GitHub, a command line, an API key, or knowledge of MCP
to complete the individual guided-install path.

### Workspace administrator

1. The administrator selects an immutable MySkills release.
2. MySkills identifies the destination platform, organization/workspace, and
   intended audience.
3. MySkills displays the platform controls that remain external, such as role,
   group, required install, default install, or availability policy.
4. A managed publisher, when implemented, creates or updates only the selected
   projection through an explicitly authorized provider route.
5. MySkills records the artifact digest and provider evidence returned by that
   route. It does not infer per-user enablement from organization publication.

### Developer or automation owner

1. The owner selects an OpenAI or Anthropic API target separately from the
   corresponding consumer web application.
2. MySkills requires a narrowly scoped project/workspace credential through an
   approved secret store.
3. Preview shows create, version, replace, or deactivate operations before an
   apply action.
4. Readback records the provider resource ID, version, digest where available,
   timestamp, and credential scope used for the observation.

## Target Model

**Decision:** model a destination as a capability-bearing target, not as a
single provider name.

Proposed target identifiers:

| Target identifier | Destination | Initial method |
| --- | --- | --- |
| `chatgpt.skill` | ChatGPT user/workspace native skill | Guided ZIP export |
| `chatgpt.plugin` | ChatGPT managed workspace plugin | GitHub-backed publisher after pilot |
| `chatgpt.mcp-app` | ChatGPT custom app or MCP runtime | Connector descriptor after security review |
| `openai-api.skill` | OpenAI API project | API adapter after project-scope pilot |
| `claude.skill` | Claude chat/Cowork native skill | Guided ZIP export |
| `claude.plugin` | Claude organization plugin | ZIP export, then private/internal GitHub publisher |
| `claude.remote-mcp` | Claude remote MCP integration | Connector descriptor after security review |
| `anthropic-api.skill` | Anthropic developer API scope | API adapter after credential-scope pilot |
| `perplexity.computer-skill` | Perplexity Computer Skill | Guided Markdown or ZIP export |
| `perplexity.local-mcp` | Perplexity macOS local MCP | Later desktop/CLI guidance after security review |
| `perplexity.remote-mcp` | Future Perplexity remote MCP | Unknown until Perplexity documents availability |

Each target capability record should declare:

- supported package profiles and maximum package size;
- personal, team, organization, project, or space scope;
- manual, Git-backed, marketplace, MCP, or API delivery methods;
- create, update, remove, list, readback, and analytics capabilities;
- required account plan and administrator role where known;
- last verification date, evidence source, and compatibility status;
- whether live state can be observed through a supported interface.

Compatibility status should be one of:

- `researched`: official documentation supports the design;
- `pilot`: the artifact passed a controlled live workflow;
- `supported`: fixtures and a maintained live workflow pass;
- `degraded`: a previously supported workflow has a material provider change;
- `unsupported`: the target cannot accept the release safely;
- `unknown`: evidence is missing or stale.

The existing manifest values `supported`, `planned`, and `deprecated` describe
author intent. They are not sufficient evidence for live provider compatibility
and should remain separate from this adapter status.

## Canonical Release And Derived Projections

**Decision:** the immutable MySkills release remains canonical. Provider files
are deterministic projections of that release.

A release can contain:

- a portable instruction core;
- examples and reference files;
- declared tools, scripts, or network requirements;
- target-specific overrides where portability is not safe;
- a manifest that identifies every generated file and its SHA-256 digest.

Proposed projection profiles:

1. `portable-skill-v1`
   - normalized `SKILL.md` with required name and description frontmatter;
   - public-safe supporting Markdown or data files;
   - no provider credential or machine-specific path.
2. `chatgpt-skill-v1`
   - validated ChatGPT upload archive;
   - ChatGPT-specific metadata or instructions only when required by a live
     compatibility fixture.
3. `claude-skill-v1`
   - ZIP with `SKILL.md` at the archive root;
   - provider limits and file behavior verified by fixture.
4. `perplexity-computer-skill-v1`
   - single Markdown file when no supporting assets are needed, otherwise ZIP;
   - `SKILL.md` at the archive root and total size within the verified limit.
5. `openai-plugin-v1` and `claude-plugin-v1`
   - provider plugin manifest plus selected skills and optional app/MCP
     descriptors;
   - a version bump and immutable source release reference.

Generation must be repeatable: the same release, profile version, and declared
inputs must produce the same logical file set and content digests. ZIP container
metadata can be normalized or excluded from logical digest comparison.

## Delivery Methods

### Guided export

This is the minimum viable integration.

- Generate the correct artifact.
- Validate structure, content policy, file types, and size.
- Give short steps for the selected provider and account type.
- Record `artifact-generated` evidence.
- Accept an optional user confirmation without upgrading it to provider
  verification.

### Managed marketplace or Git publisher

Use only where the provider documents this path and a live business or
enterprise pilot confirms it.

- ChatGPT plugin repositories must use a supported manifest and Git host.
- Claude organization plugin synchronization must use the documented private
  or internal repository path.
- A source merge or publish event does not prove that every user has installed
  or enabled the plugin.
- Provider sync failure must leave the last known state visible and must not
  silently claim success.

### MCP or app integration

MCP gives an AI application access to MySkills discovery or governed actions at
runtime. It does not place a native skill into the provider's skill library.

- Default to read-only search, details, and install guidance.
- Keep any write tool separately scoped and approval-gated.
- Present connector permissions and data destinations before connection.
- Do not send private skill content to a provider until the user selects it and
  policy permits the disclosure.

### Developer API adapter

Treat the OpenAI API project and the Anthropic developer API scope as
independent destinations.

- Store credentials outside skill packages and deployment receipts.
- Preview exact resource and version operations before apply.
- Use idempotency and provider resource identifiers where supported.
- Read back after mutation and preserve the previous external version for a
  tested rollback path where the provider permits it.
- Never use an API resource as proof of consumer web-app installation.

## Deployment Receipt And Evidence

**Decision:** separate desired, delivered, and observed state.

A future deployment receipt should include:

- MySkills release ID, semantic version, and artifact digest;
- target identifier and projection profile version;
- destination scope, represented by a non-secret stable reference;
- delivery method;
- requested actor and authorization decision;
- desired provider version or operation;
- state and timestamps;
- evidence type and evidence timestamp;
- provider resource reference where one is safely available;
- error category and retry guidance without raw provider secrets or content.

Proposed receipt states:

- `generated`: MySkills produced and validated an artifact;
- `handed-off`: the user downloaded it or a publisher submitted it;
- `user-confirmed`: the user reports completion;
- `provider-observed`: a supported readback confirms the external resource;
- `enabled-observed`: a supported readback confirms enablement for the measured
  scope;
- `failed`: a known delivery operation failed;
- `stale`: the external version differs from the desired release or the
  observation exceeded its validity window;
- `unknown`: no reliable observation exists.

Evidence strength, from weakest to strongest:

1. artifact generation;
2. user confirmation;
3. provider UI observation by an authorized administrator;
4. provider API readback;
5. provider readback plus a controlled runtime behavior check.

No state should be called `installed`, `enabled`, or `synchronized` without the
scope and evidence that support that claim.

## Reconciliation Rules

1. MySkills owns desired release state and generated projections.
2. A provider owns its installed resources, workspace policy, and runtime
   behavior.
3. MySkills may observe provider state only through an approved documented
   interface or a controlled manual verification.
4. A comparison can report `matching`, `different`, `missing`, `inaccessible`,
   or `unknown`.
5. Automatic overwrite is out of scope until each adapter has conflict,
   consent, audit, retry, and rollback behavior.
6. Provider-side edits must not silently mutate an immutable MySkills release.
   An authorized import can create a new draft candidate for review.

## Security And Privacy Requirements

- Never package API keys, cookies, workspace tokens, credentials, private
  repository URLs with embedded credentials, or local absolute paths.
- Treat scripts and executable assets as code. Scan them before projection and
  show their requested tools, network access, and file access.
- Instructions inside a skill do not grant MySkills or a provider extra
  permissions.
- Keep package authorization, destination authorization, and provider
  credential scope as separate checks.
- Default managed actions to the narrowest selected organization, group,
  project, or space.
- Require explicit review before a private release is sent to a third-party AI
  provider.
- Redact provider identifiers when they can expose an organization, user, or
  private repository.
- Preserve an audit event for generation, publish attempt, readback, failure,
  user confirmation, and rollback.
- Do not make browser automation the production integration contract. It can be
  used only for controlled compatibility testing with separate authorization.

## Implementation Plan

### Phase 1: research and contracts

Outcome: this document, including its provider evidence register and fixture
plan, plus ADR 0005 and explicit unknowns. No external credentials or provider
writes.

Exit criteria:

- web-app, managed workspace, MCP/app, and developer API targets are distinct;
- evidence levels and receipt states cannot overstate installation;
- non-technical and administrator journeys are defined;
- every proposed target is `researched` or `unknown`, not `supported`.

### Phase 2: export-only minimum viable integration

Outcome: deterministic projections, validation, and a **Use in…** guided flow
for individual users.

Required work:

- define portable and provider profile schemas;
- add fixture packages for instruction-only, references, assets, scripts, and
  intentionally incompatible cases;
- generate normalized Markdown or ZIP artifacts;
- implement structural, secret, content, and size checks;
- add API, CLI, MCP guidance, and web download surfaces through existing
  authorization boundaries;
- record only generation, handoff, and user-confirmed evidence.

Exit criteria:

- identical inputs produce identical logical digests;
- fixtures prove valid and invalid cases for each target;
- the web path requires no GitHub, command line, or provider API key;
- private release authorization is enforced before artifact access;
- no UI copy implies a provider-observed installation.

### Phase 3: live compatibility pilot

Outcome: controlled validation in eligible test accounts for ChatGPT, Claude,
and Perplexity.

Test each fixture for upload, rendering, activation, tool/file behavior,
sharing controls, update behavior, removal, size errors, and provider scan or
warning behavior. Capture plan, product tier, UI date, result, sanitized
evidence, and the exact artifact digest.

Promotion to `pilot` requires a successful upload and runtime behavior check.
Promotion to `supported` requires repeatable fixtures, maintained instructions,
negative tests, and a defined evidence-expiry policy.

### Phase 4: managed workspace distribution pilot

Outcome: one ChatGPT workspace plugin and one Claude organization plugin tested
with a non-production organization.

Required decisions include repository ownership, manifest versioning, admin
roles, group policy, pull request/release workflow, provider sync failure,
removal, audit readback, and rollback. Perplexity remains export-only until an
official and testable organization publishing route is established.

### Phase 5: MCP and app integration

Outcome: supported providers can discover authorized MySkills releases and
return guided install information through a read-only connector. Perplexity
remote MCP remains excluded until Perplexity documents it as available and a
live pilot verifies the target.

Write actions, provider submission, and private-content delivery remain
separate approvals. Public app or connector review is a later release decision.

### Phase 6: developer API workspace adapters

Outcome: versioned OpenAI API project and Anthropic developer API deployments
with preview, apply, readback, audit, retry, and rollback behavior.

These adapters must not reuse consumer web-workspace credentials or claim
consumer installation state.

## Live Validation Matrix

Each target pilot should cover at least:

| Case | Expected evidence |
| --- | --- |
| Minimal instruction-only skill | Upload succeeds and instructions affect a controlled task |
| Supporting reference file | Runtime can access the intended file and not undeclared files |
| Benign script | Provider warning, scan, execution, and permission behavior are recorded |
| Unsupported file or oversized package | Validation rejects before provider upload where rules are known |
| Private content | Access and disclosure require the correct MySkills authorization |
| Same version uploaded twice | Provider duplicate, replace, or version behavior is recorded |
| New release | Update path and visible version/digest relationship are recorded |
| Revoked release | MySkills blocks new delivery and reports external state as unknown or still present until observed |
| Workspace sharing | Role/group/audience result is verified for the measured scope |
| Removal | Provider resource is absent or disabled according to supported readback |

## Open Questions

1. What exact file types, archive paths, frontmatter fields, and size limits does
   ChatGPT currently enforce for native skill upload?
2. Which ChatGPT plugin capabilities and Git synchronization controls are
   available on each eligible plan, and which installed-state fields are
   programmatically observable?
3. Can a Claude organization administrator export reliable installed and
   enabled state, or only manage desired availability through the UI?
4. What is Perplexity's complete organization skill lifecycle for publish,
   update, group assignment, analytics, and removal? Is any supported API or
   repository synchronization interface available?
5. How do all three platforms handle duplicate names, semantic versions,
   provider-side edits, revoked source releases, and conflicting updates?
6. Which skill contents leave the user's device or workspace during scanning,
   execution, analytics, or support workflows?
7. What evidence validity window is reasonable before a provider compatibility
   status becomes `unknown` or `degraded`?

Until these questions are answered with live evidence, MySkills should describe
the corresponding feature as researched, planned, or pilot. It should not label
it supported.
