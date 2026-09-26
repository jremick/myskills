# Skill Improvement and Optimisation

Status: proposal for product review; no implementation or release commitment.
Version: 0.1.0
Date: 2026-09-26
Source baseline: GitHub main `7a0fc44e6a1cabaabfdcf494c3cc96db4cf7d3cc`.

## Summary

Enable a person, team, or organization to select skills that review and improve other skills, run that workflow in an authorized local environment, compare proposed changes against the original, and adopt a reviewed result. Record what every release was designed for and what has actually been tested: model, agent application, runtime settings, tools, and environment.

Use **Improve skill** for the action and **Compatibility and evidence** for release metadata. Reserve **measured improvement** for a candidate that meets a declared evaluation contract. Following vendor prompting guidance alone supports a recommendation, not a performance claim.

Recommended first product release: scoped local analysis, candidate generation, baseline/candidate evaluation, user/team/org reviewer policies, metadata, and human-reviewed adoption. Start with an explicit local command and one verified host adapter. Add opt-in event-driven execution after that workflow is proven. This is a proposal, not an approved implementation plan.

## Problem and users

A skill can remain syntactically valid while becoming less useful after a model, host application, tool contract, or work environment changes. Authors cannot retest every combination. Organizations need their own reviewers and constraints. Users need useful adaptation without losing reliable behavior or creating an unmanageable fork for every model.

| User | Job to be done | Useful outcome |
| --- | --- | --- |
| Individual | Retune a skill for a new model or app | A reviewed candidate, clear comparison, and recoverable adoption |
| Skill maintainer | Improve a reusable release without breaking other users | Bounded target claims, regression evidence, normal release review |
| Team owner | Designate domain-specific reviewers and shared test expectations | Repeatable policy and results without uploading private workspaces |
| Organization admin | Establish allowed reviewers, providers, data handling, and limits | Explainable inherited controls and auditable decisions |
| Local operator | Run jobs on a device or controlled runner | Explicit capabilities, resource limits, cancellation, and recovery |

## Goals and non-goals

Goals:

- Make model/app/environment suitability visible for every release, including explicit unknowns.
- Allow ordinary versioned skills to serve as reviewers, candidate authors, and evaluators through a bounded contract.
- Keep execution and credentials under local control while MySkills owns shared registry records, policies, permissions, and release decisions.
- Measure useful outcomes: task success, correct activation, output quality, safety, latency, tokens, and cost where available.
- Automate repeatable review work without treating a model's recommendation as authority to install or publish.
- Support app/environment adaptation and model migration through one workflow.

Non-goals for the first release:

- Model training or fine-tuning; a hosted inference service; a replacement for local agent apps.
- A general autonomous-agent platform, arbitrary tool installation, or a new scheduler service.
- Unattended publication, production writes during evaluation, or automatic global skill replacement.
- Full compatibility certification, tamper-proof proof of local model behavior, or guaranteed performance on untested targets.
- Exhaustive testing across every combination of models, apps, operating systems, and tools.

## Observed foundation and gaps

These are source-level findings, not fresh deployment verification.

| Current contract | Consequence for this feature |
| --- | --- |
| [Manifest](../packages/skill-package/src/manifest.ts) is strict and contains platforms/tags, but no model or evaluation metadata | Keep Phase 1 declarations in API-owned release metadata; embedded fields require a later reader migration |
| [Package loading](../packages/skill-package/src/package-path.ts) accepts one root JSON manifest; stored artifacts have a separate reader | Preserve existing bytes and package contracts; do not create a second canonical package manifest |
| [Release metadata migration](../apps/api/migrations/0021_skill_release_metadata.sql) and [types](../packages/core/src/skill-updates.ts) already separate release metadata from artifact bytes | Add a dedicated bounded declaration field; existing `compatibility` allows only three installation-version fields |
| [Architecture](ARCHITECTURE.md) makes API/Postgres authoritative; reviewed releases have immutable artifacts | Store shared policies/evidence in the API; candidates enter existing submission and publication flows |
| [Milestone 6](ROADMAP.md#milestone-6-skill-evals) is planned | Build a minimal reusable eval foundation; do not pretend an eval service already exists |
| [Target contracts](../packages/core/src/architecture-target-contracts.ts) identify user/team/org ownership, consent, generations, and capabilities | Reuse target identity where appropriate; existing inventory/install consent does not authorize model execution |
| [Upgrade policy](../packages/core/src/skill-upgrade-policy.ts) composes organization ceilings and target restrictions | Use the same restrictive composition principle, with a distinct improvement policy |
| [Target operations](../packages/core/src/target-skill-operations.ts) bind install/update/rollback to exact artifacts and plans | Reuse adoption after publication; do not add arbitrary model jobs to install-operation enums |
| [CLI](../apps/cli/README.md) has an explicit `companion run-once` command | There is no basis for assuming an always-running optimization daemon |
| [Platform integration design](AI_PLATFORM_INTEGRATIONS.md) separates author intent and observed adapter compatibility | Reuse this distinction; do not collapse adapter support into skill quality |
| [Scanner](../packages/skill-package/src/scan.ts) can block malicious examples as well as instructions | Reviewer packages remain subject to scans; adversarial test corpora need separate controlled handling |

## Product decisions

| Question | Recommended decision | Reason and alternative |
| --- | --- | --- |
| What is an optimized skill? | A release can declare design targets; measured improvement is a scoped evidence claim | A single optimized badge would imply unsupported general quality |
| Who supplies expertise? | Users select exact versions of ordinary skills, bound to a workflow role and result contract | Built-in reviewers can be curated starters; avoid a privileged reviewer package class |
| Where does it run? | A local CLI coordinator prepares an isolated job and uses an explicitly configured host adapter | A managed local inference runner is a later adapter, not a prerequisite |
| Who controls inference? | The local operator selects an allowed provider/account route | Local execution does not imply on-device inference |
| What changes automatically? | Analysis, proposed candidates, and approved test execution | Adoption/publication have separate authority; unattended adoption is future opt-in scope |
| What is canonical? | API/Postgres for shared settings, results, approvals, lineage, and releases; local storage for private inputs and drafts | Git remains optional source collaboration, not a second registry |
| How many variants? | Prefer one portable release; create a named derivative only when evidence justifies divergence | Avoid a model-by-app-by-environment fork matrix |
| How are new models handled? | Discovery creates a relevant review opportunity; execution requires an enrolled policy and local runner | New-model availability alone is neither a regression nor permission to spend |

## End-to-end journeys

### Manual model migration

1. Select a skill release or a local package. Choose **Improve skill**.
2. Choose the desired model/app/environment profile, goal, and protected behaviors. For a release, preserve the exact source version and artifact digest. For local files, capture a checked snapshot digest and mark any divergence from an installed release.
3. Resolve the applicable policy and reviewer skills. Show their provenance, permissions, data exposure, estimated work, and evaluation coverage. Unknown compatibility remains visible.
4. Prepare a local job. Verify target consent, reviewer availability, adapter capability, allowed inference route, budgets, and writable output directory.
5. Review the original. A reviewer can recommend changes, a configuration adjustment, more evaluation data, or no change.
6. Resolve the proposed release name, version, visibility, and derivative identity before generation. Generate at most the configured number of candidates in scratch storage, freeze the final file tree, and validate/scan it before execution. Show file diffs and rationale. Do not touch the installed skill.
7. Compare original and final candidate on the same target profile and fixed evaluation suite, in separate constrained evaluation sessions. Show regressions, missing checks, uncertainty, and resource tradeoffs.
8. The user accepts, edits, rejects, or defers the candidate. A user edit changes its digest and invalidates affected evaluation claims.
9. Export a local draft or submit a new release/derivative through existing review. Once published, installation follows current plan/consent/update/rollback controls.
10. Confirm host recognition where supported. Files installed on disk are not proof the host loaded the new skill. Restart/reload instructions and evidence remain separate.

### Tailor to an application or environment

Choose an existing profile or define requirements: host application, operating system, runtime, available tools/MCP contracts, filesystem conventions, offline/network policy, language, and domain output requirements. Bind private paths and endpoints locally. The reviewer can identify impossible requirements before generation. Missing tools produce a blocked or incompatible result; they do not trigger installation or permission expansion.

A smaller model might need shorter instructions or more examples. A different app might need tool-name or loading changes. A restricted environment might require a different workflow. Each is a hypothesis to evaluate. Runtime settings can be the better recommendation; a text rewrite is not mandatory.

### Team or organization workflow

An owner/admin designates reviewer releases, required checks, allowed provider routes, and optional automatic-review rules. A member selects that policy for an authorized skill and runs it locally. Only approved result fields are shared. Organization policy can require a reviewer or prohibit cloud inference, but cannot grant itself filesystem or account access on a member's computer.

A source package need not be owned by the requester to be analyzed if the requester can lawfully retrieve it. Submitting a replacement still requires existing maintainer authority. Otherwise create an explicitly owned derivative, subject to license, sharing, and source provenance.

### Automatic review opportunity

An enrolled local runner detects a watched model/profile/guidance change, checks relevance and deduplication, and either notifies or runs a bounded analysis/proposal job. A powered-off device does not execute. Missed events coalesce into the latest applicable opportunity after reconnection. No unchanged-state notification loop.

## Metadata model

### Three separate records

1. **Design declaration:** immutable, reviewed release metadata saying what the author intended; optional embedding in a future package schema.
2. **Target profile:** a versioned description of the model, host, settings, and environment to test. Portable requirements are separate from private machine bindings.
3. **Evidence:** append-only records of what ran, against which bytes, under which conditions, and with what result. An API projection shows current relevance and trust.

Every release has a normalized metadata projection. Old or unspecified packages resolve to `unspecified`; they do not become universally compatible. Authoring tools ask for a declaration but allow an honest unknown. No mandatory test run is needed to publish an ordinary skill unless owner policy requires one.

### Proposed declaration schema

Code/API names use `optimization`; product prose uses optimisation. Phase 1 accepts this declaration with the submission and stores it beside the release, following the existing release-metadata pattern. It is not a field accepted by the current strict package manifest. Local unregistered packages keep the declaration in their local job record. A future versioned package extension can embed the same declaration once reader support is deployed. Names and IDs in examples are illustrative.

```json
{
  "optimization": {
    "schema_version": 1,
    "intent": "targeted",
    "targets": [
      {
        "id": "review-in-local-agent",
        "models": [{ "provider": "example-provider", "id": "example-model-v2" }],
        "apps": [{ "id": "example-agent", "version": "2.0" }],
        "environment": {
          "os": ["linux", "macos"],
          "required_capabilities": ["workspace.read", "structured-output"],
          "network": "optional"
        }
      }
    ],
    "objectives": ["task-success", "token-efficiency"],
    "limitations": ["No claim for other model or app versions"]
  }
}
```

Declaration rules:

- `intent`: `unspecified`, `portable`, or `targeted`. Portable describes an aim, not verified universality. Targets are required for targeted intent.
- A target is a tuple constraint. Multiple target entries are alternatives; dimensions within an entry apply together. Arrays within one dimension are alternatives. Never infer that separately tested dimensions prove their Cartesian product.
- Model identifiers are provider-scoped opaque strings. Record exact resolved model/snapshot identities in evidence. Do not parse model names as SemVer or assume `latest` is stable.
- App/runtime versions use an adapter's declared scheme: exact opaque value by default, ranges only when its version comparator is defined. Unknown custom apps are permitted but cannot acquire verified support automatically.
- Include relevant model settings, context limits, tool contracts, runtimes, locale, and resource requirements through a versioned target-profile schema. Do not encode secrets, absolute user paths, tenant URLs, or private inventory in public release declarations.
- An absent dimension means no declaration for that dimension; it never means verified compatibility with all values.
- Proposed initial bounds: 16 target tuples, 16 entries per dimension, 32 capability requirements, 8 objectives, and 2,000 characters of limitations. Enforce limits before model execution.

### Evidence and display semantics

Keep these axes separate:

| Axis | Values/examples | Meaning |
| --- | --- | --- |
| Declaration | Unspecified / Portable intent / Targeted intent | Author statement |
| Review | Not reviewed / Recommendations available / No change recommended | Static or semantic analysis |
| Evaluation | Passed / Regressed / Inconclusive / Failed to execute / Not run / Incompatible | Measured outcome with explicit coverage |
| Relevance | Current for this profile / Stale / Different target / Unknown identity | Applicability now |
| Provenance | Local report / Registered runner receipt / Independently reproduced | Who supplied or reproduced evidence |
| Adoption | Draft / Submitted / Published / Installed / Host recognition confirmed | Separate lifecycle evidence |

A signature establishes who produced a receipt and whether it changed; it does not prove the task was run faithfully or that the result is correct. In a private report, show **Locally reported improvement for profile X** when only self-reported observations support the result. Show **Measured improvement for profile X**, with the baseline, rubric, and provenance inline, only after the configured evidence acceptance/provenance requirement is met, required checks pass, evidence is relevant, and a scoped improvement criterion is met. An author claim alone displays **Designed for X — untested**.

Uploading evidence does not grant authority to attach a public claim to someone else's release. Uploads belong to the authorized reporting scope by default. A release owner or the release-review role designated by policy must accept an exact evidence revision/digest before it appears in that release's shared evidence view. Owner/org policy sets the minimum accepted provenance. Acceptance records what was reviewed and any reproduction; human acceptance does not relabel self-reported results as independently reproduced. Public summaries require an explicit approved public-safe projection; source, reviewer, guidance, suite and result permissions still apply. Rejections and regressions can remain visible in authorized private reports without becoming unsolicited public ratings.

Evidence binds source and candidate content, release artifact hash when available, target-profile revision, exact model identity or unresolved alias, inference route, app/adapter/runner versions, model settings, tool-schema/context fingerprints, reviewer pins, guidance revisions, dataset/suite/rubric hashes, observations, timing, and result provenance. Record both requested and observed model identity. Missing identity limits claims; do not invent it from model text.

Keep evidence outside package bytes to avoid self-referential hashes and to add later results without modifying immutable releases. An optional export envelope carries declarations and evidence references alongside the unchanged artifact; the API resolves only authorized records. Offline imports verify the artifact binding and label the envelope as an imported claim, not current registry approval. Private context fingerprints stay private; even hashes and model/skill names can disclose information.

### Release metadata, approval, and migration

- Accept legacy manifests unchanged. Normalize absent declarations to `unspecified` in the new metadata projection, without rewriting artifacts or changing their digests.
- Phase 1 uses a new release declaration record/column, not extra keys in existing strict `compatibility`. Submit declarations through CLI/web/API alongside package bytes. Existing package-only submission remains valid and produces an unspecified declaration.
- Bind approval to a versioned digest of `{releaseId, artifactSha256, declarationRevisionId, declarationDigest}`. Updating a pre-publication declaration invalidates its approval. Publication rechecks this binding atomically. Legacy approvals without declarations remain valid only for the unspecified projection; they cannot silently approve new claims.
- For already published releases, adding or correcting a declaration creates an independently reviewed append-only attestation. The normal release-review role approves `{releaseId, artifactSha256, attestationRevisionId, attestationDigest}`; later edits create a new unapproved revision. Show its issuer and date separately from the original release declaration. A new release can make it part of its author declaration.
- New metadata endpoints and opt-in projections avoid changing old strict response shapes. Test the supported older CLI against the upgraded API for search/info/export/install/update/rollback, including response parsers and token scopes. Old clients may omit new metadata; they must not misrepresent or corrupt it.
- Local export produces the original package plus a separate explicitly requested metadata envelope. The envelope includes artifact identity, declaration revision/digest, issuer, and evidence references. It confers no authority. Missing metadata on a standalone imported archive is shown as unknown.
- Later embedded package declarations require reader-first rollout, manifest equality/archive updates, a minimum-client/capability signal, and an actionable upgrade error. Never strip fields from immutable delivery bytes. An embedded declaration must match the API declaration digest at submission; mismatches are rejected.
- Agent Skills frontmatter permits string-valued metadata and a short compatibility field. A later authoring/export projection can generate a concise summary and namespaced string reference. Keep structured MySkills metadata out of unsupported host frontmatter; do not assume hosts interpret custom metadata. [Agent Skills specification](https://agentskills.io/specification)

## Reviewer selection and policy

### Reviewer skills

A reviewer is an ordinary scanned, versioned skill selected by policy. A binding assigns one or more roles: `analyze`, `propose`, or `evaluate`. A skill may perform multiple roles, but an independent check is required for any objective improvement claim; self-grading alone is advisory.

Each binding pins registry/release identity, artifact digest, role, supported contract version, target applicability, and approved parameter values. Keep credentials and arbitrary command strings out of parameters. Existing skills can be wrapped by an adapter into the result contract; unstructured output remains a recommendation until validated.

The job supplies source snapshots, the target profile, objectives, protected requirements, permitted context, guidance references, and a fixed development-test budget. The result returns structured findings, evidence references, applicability, proposed file changes, expected benefit, limitations, and disposition (`no-change`, `recommend`, `candidate`, `blocked`). Never accept a reviewer-provided authorization decision or claimed measured score as a runner observation.

Exactly one candidate author runs at a time. Findings retain reviewer identity and each candidate records `addressed`, `rejected` with reason, or `deferred` against every finding. Conflicting advice is shown to the user. A reviewer cannot propose or approve changes to itself or its own active dependency chain within the same job; reject cycles. Reviewer improvement uses a separate explicitly selected workflow.

Pin the complete reviewer dependency closure. A router reviewer cannot fetch an unapproved leaf or silently acquire more tools. Reviewer updates are reviewable policy revisions, not automatic floating pins. Reviewers get the same design/evidence metadata as every other skill.

### Policy scope and composition

Policies may belong to a user, standalone team, organization, or an organization child team. A run has exactly one explicit owning context and at most one selected team. Merely belonging to several teams does not merge all their defaults. Applicable hard policies include the run context, the owners of the subject release, each reviewer and its dependencies, guidance, suite/input data, and the result destination. Source access and owner data-handling policies apply regardless of the selected run context. Personal context cannot bypass an organization's restrictions on its source skill, private reviewer, guidance, or test data. Resolve those resource restrictions before any local/provider handoff; conflicting scopes block rather than merge permissions. Organization-owned workflows start disabled until an administrator designates an allowed reviewer policy. A personal analysis does not create authority to submit or adopt on behalf of an organization.

| Field | Composition |
| --- | --- |
| Allowed reviewers, providers, models, capabilities, destinations | Intersection across applicable hard policies; empty intersection blocks |
| Required reviewers, protected requirements, required checks | Union; contradictory requirements block |
| Budget, concurrency, duration, retention maximum | Most restrictive applicable ceiling |
| Sharing/privacy | Most restrictive allowed disclosure; no lower scope broadening |
| Default goal, preferred optional reviewer/profile | Run choice, then selected team, then organization, then user, then product default, within hard bounds |
| Local authority | Operator consent is additionally required; remote policy cannot substitute for it |

The supported coordinator and API acceptance rules reject removal of mandatory reviewers. A new mandatory reviewer or provider changes the effective plan and requires renewed local consent. Show the source and explanation for every inherited constraint. Policy revisions, memberships, target generation, and release lifecycle are rechecked at execution and submission/adoption boundaries. Shared authorization expires at the plan deadline and is rechecked between stages before new protected retrieval or provider work; revocation stops subsequent stages and blocks promotion. Already completed calls cannot be undone.

### Settings and recommended defaults

| Setting | Default | Other supported choices / effect |
| --- | --- | --- |
| Automation | Off; explicit local run | Notify only; auto-analyze; auto-propose/evaluate, when enrolled |
| Adoption | Human review | Later constrained auto-adoption for selected low-risk private targets |
| Reviewer selection | Explicit pinned bindings | Curated starter recipes, organization-mandated reviewers |
| Objectives | Task success first | Latency, cost, tokens, activation accuracy, domain quality; fixed priority order |
| Protected behavior | Existing authority, privacy, output and routing constraints | User/team can add stricter invariants |
| Inference | Explicit route chosen locally | Cloud-allowed, approved providers only, on-device-only |
| Results sharing | Local only | Sanitized summary, selected evidence, full approved report |
| Candidate limit | One per run | Explicit increase within policy; no open-ended self-improvement loop |
| Run bounds | One active job per local runner; finite calls/tokens/time | Numeric caps set before execution; fail if required caps cannot be enforced |
| Retry | One bounded transient retry | No unlimited retry, model substitution, or scope expansion |
| Guidance | Pinned approved sources | Optional refresh; changed guidance becomes a new revision |
| Evidence freshness | Target/profile change invalidates applicability | Optional age window by policy; history remains available |
| Notifications | Meaningful change/action only | Digests, per-skill mute, cooldown, and snooze |
| Retention | Local report retention chosen at setup | Shared retention follows explicit policy; privacy review before upload |

Subscription use is not zero resource use. Record calls, wall time, and tokens when reported; report cost as unknown if there is no reliable billing telemetry. A hard currency cap is unavailable on adapters that cannot enforce it; select enforceable limits or block that policy rather than claiming a guarantee.

## Local execution and trust boundaries

### Coordinator and adapters

Keep deterministic job planning, schema validation, digesting, budgets, state transitions, and patch application in the CLI/coordinator. Models supply analysis and candidate content. An adapter declares capabilities such as exact model readback, structured output, cancellation, workspace isolation, token accounting, and tool/network restrictions.

Start with one verified adapter for an existing local agent app. Codex is the recommended pilot because MySkills already has a Codex workspace path; the present install companion is not an inference adapter. Prove the new execution contract separately. Define the contract so Claude Code and on-device model hosts can follow without changing policy semantics. Do not claim those adapters supported until their fixtures and live workflows pass.

Use a dedicated scratch job directory containing only approved inputs. Treat subject skills, references, evaluation inputs, and returned output as untrusted data. Avoid loading the subject skill as executable reviewer instructions. Inherited host instructions, plugins, hooks, MCP servers, auto-loaded skills, and account context must be constrained or fingerprinted; an uncontrolled session cannot claim isolated/reproducible execution.

Prompt instructions are not an OS sandbox. An adapter that cannot enforce the required filesystem/network/tool restrictions must block automatic execution or offer a clearly labeled supervised handoff with weaker evidence. On-device-only requires known on-device inference and enforced external-egress restrictions for the whole job, including graders and telemetry. A loopback URL alone proves neither.

### Two enforcement layers

The supported local coordinator rejects plans that exceed policy or differ from accepted inputs. Those controls are cooperative on a member-controlled device: modified software or an operator with device control can bypass them. Label each guarantee by who enforces it: API acceptance, local coordinator, host/OS isolation, or user assertion. Do not claim MySkills can prevent misuse of bytes after authorized retrieval.

Shared runs register their complete plan and effective policy revisions with the API before execution. Evidence is accepted against the server-recorded plan ID/digest, authorized runner/actor, expiry, and current resource permissions. The API checks immutable identities and allowed transitions; it does not infer actual execution from those checks. Unregistered/offline drafts remain local-report provenance and cannot automatically satisfy organization-required checks or publish a shared claim. A retrospective import can be reviewed as reported evidence, never relabeled as a preregistered run.

A server plan alone also cannot prove that a member ran every reviewer or used the declared inference route. Organization-required evidence additionally needs the provenance and human acceptance or independent reproduction specified by policy. Where strict centrally enforced execution is required, use an organization-controlled runner with a verified isolation/egress boundary in a later phase, or block the job. That guarantee is outside the member-operated Phase 1 adapter.

### Data paths

- Registry to coordinator: authorized subject/reviewer packages, profile/policy revisions, selected source references.
- Coordinator to host/provider: only the explicitly approved input categories. Credentials stay in the user's existing supported auth route.
- Coordinator to local output: detailed report, candidate files, eval records, recovery state.
- Coordinator to API: opt-in, schema-validated, bounded evidence summary and approved artifacts; no automatic transcript, prompt, workspace, or test-data upload.
- API to web/CLI/MCP: authorization-filtered projections. Public release visibility does not make private adaptation reports public.

Local-only jobs can work from already available packages and policies without a registry round trip, but cannot claim current remote authorization or submit/publish offline. This applies only when every input policy permits offline use; choosing personal context cannot make restricted shared inputs offline-eligible. Shared-policy jobs require fresh authorization to start. If connectivity is lost, follow the policy's explicit offline allowance; shared authoritative upload/adoption always revalidates. Deleted or revoked access cannot erase bytes already legitimately retrieved.

### Job states and recovery

Proposed execution states: `planned`, `ready`, `running`, `completed`, `failed`, `cancelled`, `expired`. Stages identify `analyze`, `propose`, `evaluate`. `completed` means the workflow completed, not that the candidate improved. Review disposition and release/adoption state are separate records.

A plan digest covers the source snapshot, reviewer closure, target and settings, context categories, guidance, suite, policy revisions, budget, output scope, and permissions. Any material change needs a new plan. Store idempotency key and per-attempt IDs; use leases/fencing for later shared runners. A late result cannot override a newer attempt or revive a cancelled job.

On interruption: retain verified completed stages locally; classify incomplete checks explicitly; never replay a side-effecting test blindly. Resuming revalidates input hashes and authorization. Cancellation stops new work and requests process termination; report if an adapter cannot confirm remote cancellation. No partial result can be presented as a passing complete comparison.

## Evaluation contract

### Evidence tiers

1. **Static analysis:** package validity, deterministic checks, guideline/routing/permission analysis. Produces findings only.
2. **Behavioral comparison:** original and candidate run against versioned tasks on the same target. Produces scoped observations.
3. **Host integration:** prove activation, tool availability, skill discovery and lifecycle behavior in the actual app.
4. **User acceptance / independent reproduction:** human workflow confirmation or a separate authorized runner repeats the result.

Do not claim tier 3 from a direct model API test. Host system prompts and tool behavior can dominate the result. Preserve the existing platform-adapter statuses (`researched`, `pilot`, `supported`, `degraded`, `unsupported`, `unknown`) separately from skill-evaluation outcomes.

### Minimum valid comparison

Use separate session types. Reviewer sessions see subject and candidate as data and do not execute their instructions. Evaluation sessions load only the particular baseline or candidate under test, plus the fixed harness, in fresh isolated contexts; they must not load the optimizer or its conversation. Clear cross-case memory and caches that could leak solutions, or record and control the intended cache conditions.

Before any baseline/candidate execution, validate the package, rerun scanning, and compare requested tools, permissions, platform requirements, dependencies, and locked content against the approved plan. Reject unexplained expansion. Tools run only against declared fixtures/test systems with bounded side effects. If the adapter cannot enforce that boundary, block tool-enabled evaluation and offer static review. Candidate validation only at submission is insufficient. Live business-system tests need a separate approved scope and are outside the first-release evaluation default.

- Define the objective, acceptance thresholds, protected cases, graders, and budget before candidate generation. Goals can be multidimensional; do not hide a safety regression in a weighted score.
- Run original and candidate on the same new target. Optionally run original on the old target to distinguish a model migration regression from candidate benefit. If the old model is unavailable, mark that comparison unavailable.
- Include positive activation, negative activation, ambiguity, expected output contracts, meaningful edge cases, and authority/privacy invariants. App adaptation also needs install/load/tool integration cases.
- Preserve a separate holdout or independent acceptance set. Do not let the optimizer rewrite expected answers, graders, or protected checks. If the host cannot isolate hidden cases, report possible contamination and downgrade the claim.
- Store every candidate attempt and failed check. Include a no-change control to estimate run-to-run variation where statistical claims are made. Fixed repetition counts, paired case-level comparisons, and a predeclared decision rule limit cherry-picking and stochastic noise. Use confidence intervals where the method and sample size support them; otherwise mark the result inconclusive.
- Prefer deterministic grading for structure and exact constraints, expert assessment for domain judgments, and calibrated model grading for semantic criteria. Use blinded/randomized pair ordering when applicable. A second model is not automatic proof of independence or correctness.
- Preserve user-specific constraints during compression. Fewer tokens alone is not an improvement if task success or permission behavior worsens.
- When no suite exists, offer a small user-reviewed starter suite and static findings. Tests generated by the same optimizer are development assistance, not sufficient independent evidence.
- A correct outcome may be **no change**, **configuration change only**, **incompatible**, or **insufficient evidence**.

Guidance supports hypotheses. OpenAI recommends evaluating and manually reviewing optimized prompts before production because individual inputs can regress. Anthropic recommends specific measurable success criteria and task-relevant evaluations. These support the gated comparison workflow; they do not establish that any proposed MySkills candidate works. [OpenAI prompt optimizer](https://developers.openai.com/api/docs/guides/prompt-optimizer), [Anthropic evaluation guidance](https://platform.claude.com/docs/en/test-and-evaluate/develop-tests).

## Guidance and change triggers

A guidance reference records publisher, exact URL, retrieval timestamp, applicable model/app versions, content digest/revision, locator for the cited recommendation, and access/reuse restrictions. Store approved bounded excerpts or a local snapshot where permitted. If only a URL is retained, mark that the source is mutable and reproduction is weaker.

Curated public source sets can include official OpenAI/Anthropic prompting and migration guidance, app skill specifications, and approved internal standards. Distinguish official recommendations, organization rules, and reviewer judgment. Conflicting recommendations are surfaced against the declared objective and evaluated; do not silently blend them. Model-specific advice is not assumed transferable. [Anthropic prompting guidance](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)

No dependency on a provider-hosted optimizer is required. The provider-neutral contract matters because vendor tooling changes independently of guidance. Reverify any service lifecycle and adapter interface before implementing it.

| Trigger | Relevance check | Default action |
| --- | --- | --- |
| User request | Selected skill/profile and access | Plan local run |
| New model or model deprecation | Watched family, allowed route, available exact ID | Review opportunity |
| App/tool/environment drift | A fingerprint dimension relevant to that skill changed | Mark applicable evidence stale; offer review |
| Guidance revision | A pinned source changed in a relevant section | Queue review of the source update |
| Skill/reviewer update | A selected release/digest changed | Re-resolve policy; do not float existing pins |
| Scheduled check | Enrolled local runner, window, cooldown, budget | Bounded analysis/proposal |
| User feedback or observed failure | Explicitly collected, authorized, and relevant | Propose a test case; do not ingest transcripts silently |

Maintain an owner-selected catalogue of relevant model/app/profile combinations. An organization can see which of its skills have declarations, current evidence, unresolved failures, or no coverage without making a model call. Prioritize by explicitly assigned criticality, deployment relevance, changed requirements, and prior failures; usage telemetry is optional and opt-in. Adding an unrelated model does not invalidate evidence for an unchanged existing target. Guidance-only changes stale guidance reviews, not the historical truth of behavioral measurements.

Use a deduplication key over subject digest, target revision, reviewer closure, guidance revisions, suite, and objective. A new release notification creates no run unless the enrolled rule allows it. Verify model availability locally; catalogs, news, or a model's self-description are not execution identity evidence. Apply cooldown and per-period ceilings. Do not watch private workspace files without consent.

## Candidates, variants, and adoption

A candidate is a checked snapshot with parent source identity, generated/edited file hashes, rationale, target profile, and evidence references. No in-place mutation of installed packages. Protect permissions, scope, license/attribution, secret handling, output contracts, and explicitly locked files/sections. A necessary change to these becomes a separate material-change request.

Prefer fixes upstream when they benefit all supported targets. For divergent adaptations, create a named derivative with an immutable parent release/artifact reference and explicit maintainer/visibility. Use current platform variants for packaging differences; do not overload `platform` with model names. Runtime conditional overlays and automatic variant selection are later features; their composition and tested identity must be defined before use.

A reviewer revocation adds a warning to dependent evidence and pending candidates; it does not automatically declare every derived release malicious. Block pending use and let owners decide on rerun, recall, or rollback. Repeated accepted generations retain lineage and cumulative diff visibility; a finite per-run limit alone does not prevent long-term drift.

Choose the complete candidate release identity (name/slug, version, visibility, and derivative target) and freeze all executable/content bytes before acceptance evaluation. Bind the result to a canonical file-tree digest over normalized relative paths and exact bytes; use the existing canonicalization/hash conventions and reject path collisions. Deterministic packaging must map that tested snapshot to the submitted artifact, with both tree digest and archive digest recorded and verified at intake. Packaging determinism and relevant metadata inclusion are Phase 0 proof requirements. A changed version string or metadata file that is visible to the host changes the tested input and needs revalidation; do not silently relabel a tested snapshot after the fact.

Before submission, rerun package validation, scans, and hash checks on the final bytes. Submission rechecks source access and ownership, license/attribution, sharing, and artifact identity. Evidence about earlier bytes does not transfer automatically. Publishing still requires existing release review. Deployment to an enrolled target still requires the existing operation plan and consent.

If upstream changed, show the new base and require an explicit rebase plus affected re-evaluation. Do not silently overwrite local edits. A private adaptation cannot be made public by changing a single visibility flag without reviewing all inherited content and evidence.

Rollback restores the exact previous artifact and records the operation. It cannot undo external side effects caused by executing a skill. Evaluation should use fixtures or test systems; permission for live business actions requires a separate, explicit test scope.

## Surfaces and contracts

### Web

- Skill detail: **Compatibility and evidence** with declaration, evaluated tuples, date, coverage, provenance, limitations, and **Improve skill**.
- Run wizard: select source, target/goal, reviewer policy, context/data route, tests/budget, and local handoff. Explain unmet requirements before starting.
- Improvement report: source/candidate diff, findings with citations, protected checks, case-level comparison, resource tradeoffs, missing evidence, and accept/reject/defer actions.
- User/team/org settings: reviewer bindings, inherited rules, trigger preferences, allowed routes, budgets, sharing/retention, enrolled runners, and effective-policy explanation.
- Review opportunity queue: relevant changes, deduped notifications, snooze, dismiss with reason, and rerun after a correction.

The browser creates a plan/handoff, not an implicit ability to execute on a laptop. Initial handoff is a copied local command or downloaded bounded job bundle, with explicit local confirmation. No new inbound localhost service is required.

### CLI and MCP

Proposed CLI commands, not commands available today:

```text
myskills improve plan <skill>@<version> --profile <id>
myskills improve run --plan <file> --workspace <directory>
myskills improve report <run-id>
myskills improve cancel <run-id>
myskills improve export <run-id> --candidate <id> --output <directory>
myskills improve share <run-id> --summary
```

Plan must show resolved pins, policy, data exposure, and budgets. Run requires the exact accepted plan. Export creates a draft for existing package/submit commands; it does not publish or install. CLI and web expose the same API authorization decisions. A normal user can complete the workflow without manually authoring policy JSON.

Team/org settings can govern a member-operated local job without requiring a team-owned execution target. The current Codex install adapter is workspace-scoped and does not support team-owned execution targets; shared runner enrollment and adoption into such targets need their own later adapter acceptance.

Keep MCP read-only initially: expose authorized compatibility/evidence, opportunities, and plan/handoff guidance alongside existing discovery. Native delivery must serve immutable verified bytes, never dynamically rewrite skills for the requesting model. Later mutation tools require their own scopes and consent; read access does not grant execution or upload.

### API/domain entities

Proposed entities, with API-owned shared persistence and local equivalents for unshared drafts:

| Entity | Required identity and purpose |
| --- | --- |
| `OptimizationDeclaration` | Release/artifact-bound author metadata, revision/digest, review status, and approval binding |
| `ImprovementProfileRevision` | Owner, target tuple, objectives, protected requirements, revision/digest |
| `ImprovementPolicyRevision` | User/team/org owner, bindings, hard limits, sharing/triggers, actor, reason |
| `ImprovementPlan` | Source/candidate scope, complete input digests, policy revisions, permissions, expiry |
| `ImprovementRun` | Plan, attempt, stage/state, runner/provenance, timestamps, terminal reason |
| `ImprovementCandidate` | Parent identity, full checked content digest, diff, lineage, disposition |
| `EvaluationSuiteRevision` / `EvaluationRun` | Reusable Milestone 6 suite/rubric hashes, case outcomes, target identity, coverage |
| `EvidenceSummary` | Authorized projection, artifact/target bindings, provenance, freshness, public-safe fields |
| `ReviewOpportunity` | Dedupe key, triggering revision, relevance, disposition; later automation phase |

Tables are a migration design task, not necessarily one table per entity. Reuse existing release, organization/team, target, submission, object-storage, audit, and operation stores. Keep private raw test data and transcripts out of default shared records. Use bounded append-only records plus current projections rather than mutable histories.

Proposed API operations: read release compatibility; preview/create profile and policy revisions; resolve an effective plan; create/read/cancel run records; upload selected evidence; create a candidate submission through existing intake. Define new narrowly scoped permissions such as `improvements:read`, `improvements:configure`, `improvements:run`, and `improvements:report`; existing publication/target execution remain distinct capabilities. Match current sensitive-operation MFA requirements for shared-run authorization and reviewer policy changes. A scoped API token is attribution/authorization, not an inference credential or performance proof.

All mutations require current membership/resource authorization, schema and size limits, content hashing, idempotency, optimistic revision checks, and sanitized audit events. Use existing non-enumerating denial behavior. Evidence visibility must account for source, reviewer, suite, and environment data; do not blindly inherit the source's public visibility.

## Failure and abuse cases

| Failure | Required behavior |
| --- | --- |
| Reviewer, source, or dependency revoked | Block new use; revalidate before execution/submission; retain restricted historical record |
| Forged receipt or score | Treat as reported evidence; validate schema/hash bindings; never auto-publish |
| Candidate modifies tests, permissions, or locked rules | Reject or require an explicit new plan; cannot pass by weakening the gate |
| Malicious subject/reference/tool output | Keep it in the data boundary; constrain execution and outbound access |
| Missing grader/model/app or unsupported setting | Block or mark the specific check unavailable; no silent substitution |
| Local content changes after approval | Reject digest mismatch; create a new snapshot and plan |
| One model improves while another regresses | Preserve per-target results; recommend narrower claims or an explicit derivative |
| Rate limit, offline device, exhausted budget | Bounded stop/retry; retain incomplete evidence without a passing label |
| Duplicate scheduled event or late completion | Dedupe/fence; no duplicate adoption or terminal-state overwrite |
| Reviewer includes adversarial examples blocked by scanner | Keep normal scan rules; use approved local fixtures or defer separate corpus handling |
| Private evidence proposed for sharing | Preview exact fields and recipients; enforce current policy and sensitive-content checks |
| Unknown actual host configuration | Mark reproduction limitations; no host-verified claim |

## Phased delivery and acceptance

### Phase 0 — contract and adapter proof

Deliver release-metadata/approval schema decisions, the bounded reviewer/job/eval contracts, and one local host capability spike using public fixtures. Resolve the first adapter's real isolation, model identity, auth, cancellation, and budget capabilities. Demonstrate the smallest credible baseline/candidate comparison. This phase changes no published skills.

Exit: legacy artifact bytes remain identical; new release metadata round-trips and participates in approval; a host capability matrix distinguishes enforced controls from declarations; unsupported required controls block execution.

### Phase 1 — first useful release, in two reviewable slices

**Phase 1a: declarations and local findings.** Deliver release declarations and approval binding, compatibility display, reviewer policies, explicit local preparation/review, findings/no-change reporting, and optional scoped evidence upload. All results are labeled static or locally reported; there are no measured-improvement claims. This is an earlier useful stop point if evaluation work takes longer. Its release gate is AC-01–AC-06, AC-09–AC-11, AC-14–AC-15, AC-17–AC-18, and a findings-only form of AC-16.

**Phase 1b: candidate evaluation and adoption.** Complete the first recommended end-to-end product release. Deliver normalized metadata for all releases; authoring/UI declarations; versioned profiles and user/team/org reviewer policies; manual local plan/run; one supported app adapter; one candidate; shared minimal eval suite/run records; local report and optional sanitized upload; draft export and normal submission/adoption path. Provide curated starter reviewer recipes for model guidance and app/environment compatibility, using scanned ordinary skill packages.

Automatic work within an approved run covers analysis, proposal, and evaluation. New-model detection and recurring unattended jobs are Phase 2. This boundary and the single supported Codex pilot adapter must be explicit in release messaging; other host adapters remain proposed.

### Phase 2 — enrolled automation and broader execution

Add optional local scheduling/event checks, model/guidance/app drift opportunities, budget/cooldown enforcement, queue/recovery controls, opt-in notifications, batch triage, Claude Code and on-device adapters once verified. Add policy-managed sharing/retention and richer independent reproduction. Do not install a background service silently.

### Phase 3 — advanced optimisation

Consider bounded multi-candidate search, Pareto comparisons across quality/cost/latency, architecture-wide conflict tests, derivative maintenance/rebase assistance, evidence-based variant selection, and carefully constrained automatic adoption. Require explicit product decisions and measured demand before each extension. Automatic public publication remains a separate decision.

### Acceptance matrix for Phase 1

| ID | Acceptance case | Proof required |
| --- | --- | --- |
| AC-01 | Legacy packages and new declarations coexist | API/CLI/MCP fixtures and supported-old-client smoke; bytes and digest unchanged; approval covers declaration |
| AC-02 | Untested author targets never appear as measured compatibility | API projection tests and rendered web/CLI states |
| AC-03 | User, team, org, and child-team reviewer selection works | Membership/policy tests including standalone and multiple-team cases |
| AC-04 | Supported coordinator and API reject policy bypass; remote policy cannot create local consent | Choose personal context for org-restricted inputs: block forbidden egress/sharing; reject altered/missing server plan; label cooperative local enforcement |
| AC-05 | Exact source, reviewers, guidance, profile, and suite are bound to the run | Tamper/stale-plan tests; result linkage checked deterministically |
| AC-06 | Candidate generation preserves source/install directories | Before/after filesystem checks, path/symlink tests, local dirty-source rejection |
| AC-07 | Missing suite yields recommendations or inconclusive evidence | No measured-improvement badge; starter-suite review flow |
| AC-08 | Baseline/candidate comparisons include protected cases and regressions | Known-good/known-bad controls, reproducible case results, no cherry-picked pass |
| AC-09 | Cloud and on-device policies are accurate | Egress/capability evidence for supported routes; unsupported enforcement blocks |
| AC-10 | Stop, retry, cancellation, and resume are bounded | Interrupted-run, budget exhaustion, duplicate/late receipt fixtures |
| AC-11 | Private report remains private until an explicit allowed share | API/cross-tenant denial, upload preview, log/telemetry inspection |
| AC-12 | Final release identity is evaluated; edits/upstream changes invalidate evidence | Name/version/visibility and tested-tree-to-archive binding checks; hash/rebase tests and review-state UI |
| AC-13 | Submission, publication, installation, and host activation stay separate | Existing release/target gates plus live pilot handoff/recognition evidence |
| AC-14 | No-change and configuration-only recommendations are valid | End-to-end report and disposition flows |
| AC-15 | Revoked access/reviewer/target or policy changes block stale work | Current-state revalidation tests before execution and submission |
| AC-16 | A normal user can complete the selected workflow | One local manual journey and one org-policy journey on the supported host |
| AC-17 | Report scope cannot create a public/shared claim on another owner's release | Unauthorized evidence attachment rejected; exact evidence acceptance and provenance checked; local report cannot satisfy stricter org gates |
| AC-18 | Unsafe candidates cannot execute before validation | Pre-evaluation scan/protected-diff checks; reviewer/evaluator session separation; fixture boundary capability tests |

Implementation verification should follow repository gates in proportion to changed contracts: targeted tests, `npm run check`, disposable Postgres integration for new persistence/auth, and release artifact checks for CLI changes. Browser and actual-host acceptance are additional proof. Do not claim them from fixture success.

## Success metrics

Measure against a pre-feature manual-review baseline, using explicit opt-in telemetry or a pilot study:

- Time from selected skill/target to a useful, reviewable finding or justified no-change decision.
- Fraction of adopted candidates that meet their predeclared objective on held-out cases.
- Regression/rollback rate after adoption, with cause and target context.
- Correct activation rate and false activation rate where the host supports observation.
- Review effort, calls/tokens/time/cost per accepted improvement; unknown telemetry stays unknown.
- Coverage: important target profiles with current usable evidence, not raw count of model badges.
- User understanding of declaration versus evidence and local execution versus inference location.

Guardrails: zero unauthorized publication/install, no unexpected private-data upload, and no measured-improvement claim from static analysis alone. Establish numeric efficacy/latency targets during the pilot; there is no measured product baseline yet.

## Open product choices and next step

Recommended defaults remain proposals until reviewed:

1. First automation level: analysis, candidates, and evaluation with human adoption; narrower alternative is analysis-only.
2. First execution host: a verified Codex local adapter; alternative is a host-neutral supervised handoff pilot with weaker automation/evidence.
3. First test domains: choose two maintained skills with concrete outcomes—one text/review skill and one safe tool-using workflow—to expose different failure modes.
4. Metadata naming: **Designed for**, **Tested on**, and **Measured improvement**, avoiding an unqualified optimized badge.
5. First release should include user/team/org reviewer designation; scheduled detection can follow without blocking the manual useful workflow.
6. Numeric budgets and retention defaults require adapter/pilot evidence and owner policy; do not invent enforceable currency caps for subscription sessions.

Next implementation plan should cover Phase 0 only, with named files, fixture skills, host capability checks, and stop conditions. Stop if required isolation, exact input binding, or credible evaluation cannot be demonstrated; return the gap and the smallest alternative. Approval of this specification does not publish packages, change live policy, install a daemon, or authorize ongoing provider spend.

## Opus collaboration and resolved tradeoffs

Claude Opus 5.5 independently inspected the repository and proposed a smaller metadata-and-local-review first slice. Its contribution materially changed this design:

- Adopted API-owned release declarations before package schema changes, with explicit approval binding and legacy-client proof.
- Adopted per-finding dispositions, reviewer-cycle prevention, activation tests, revocation lineage, and warnings about private model/environment names.
- Kept the full requested feature's first useful release dependent on a minimal evaluation foundation. Metadata and findings can ship as an earlier slice, but must not be presented as automated measured improvement.
- Kept improvement jobs separate from install/update/rollback actions. Reuse lease/fencing patterns rather than add arbitrary inference to the existing installation protocol.
- Treated independent grading as a property of tests, inputs, and authority. Different model families can reduce some bias but do not guarantee independent evidence.
- Kept guidance as versioned references/approved snapshots, without requiring a new privileged package type or scanner exception system in Phase 1.

A second Opus review identified five material specification gaps. The final revision closes them by applying resource-owner constraints irrespective of run context, separating cooperative device controls from authoritative API acceptance, fixing candidate identity before evaluation, requiring acceptance before shared evidence attachment, and validating/scanning before evaluation execution. It also defines attestation approval binding and splits Phase 1 into findings and evaluated-adoption slices. These are design corrections; implementation and live enforcement remain unverified.

## Source register

Repository pointers above were inspected at the stated GitHub main baseline. Some architecture documents retain historical statements; current source and the latest roadmap delivery records take precedence for implemented behavior. No production state was checked for this specification.

External primary sources read on 2026-09-26:

- [Agent Skills specification](https://agentskills.io/specification): interoperable frontmatter shape and compatibility metadata.
- [OpenAI prompt engineering](https://developers.openai.com/api/docs/guides/prompt-engineering): model-specific prompting and regression evaluation context.
- [OpenAI evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices): task-specific evaluation and handling variable model output.
- [OpenAI prompt optimizer](https://developers.openai.com/api/docs/guides/prompt-optimizer): evaluation/manual-review requirement and regression caveat.
- [Anthropic prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices): model-specific guidance and limits on transferring recommendations.
- [Anthropic success criteria and evaluations](https://platform.claude.com/docs/en/test-and-evaluate/develop-tests): measurable, relevant multidimensional objectives.

These sources inform design principles. The proposed MySkills schemas, limits, policy rules, and delivery phases are design decisions, not vendor requirements or proven implementations.
