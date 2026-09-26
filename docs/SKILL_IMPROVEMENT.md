# Skill improvement

Status: implementation candidate for the next beta, using Claude Code as the first runner. The adapter has passed its macOS native journey and independent review. Commit-bound release verification remains in progress; this feature is not released.

MySkills keeps optimisation intent, local review plans, and evaluation evidence separate. A release with no declaration shows **unspecified**. A declaration describes what its author designed for. A locally reported result is not independently verified performance evidence.

## Workflow

1. Open a skill's exact release. The **Skill improvement** panel shows its declared models, apps, environments, limitations, and accepted evidence.
2. A skill manager can submit optimisation metadata. Before publication this is an author declaration; after publication it is a separate attestation. A reviewer approves the exact declaration and artifact digests. A pending or rejected latest author declaration blocks publication; an approved `unspecified` declaration can withdraw the claim.
3. Select **Plan an improvement**. Choose personal, team, or organization policy context, a reviewer skill, target model, installed app version, a candidate version, and a goal. Preview resolves the exact reviewer artifact and effective policy.
4. Prepare the plan, then fetch it with the CLI. Fetch verifies package bytes and does not start inference.
5. Inspect the local plan. Running requires its exact digest and explicit consent to cloud inference. Skill and reviewer content then leaves the device through the selected local agent app.
6. Inspect the report and candidate diff. Export writes a draft outside active host skill directories. Submit, review, publish, install, and host activation remain separate actions.
7. Share summary evidence only when the prepared plan permits it. A release manager must accept the exact evidence digest before other release readers can see it.

Team and organization policies can designate exact reviewer versions and roles, constrain inference and disclosure, require checks, and set budgets. Resource-owner policies still apply when the operator selects personal context. A remote policy never supplies local consent. A missing personal policy uses product defaults; missing team or organization policy blocks use. A null token ceiling means no token limit. Any finite ceiling requires a runner that can account for and enforce tokens.

## CLI

Existing MySkills login and API URL configuration apply. The local runner uses an existing Claude Code sign-in. Never put an authentication token in a plan, suite, or request file.

The first supported runner is Claude Code 2.1.283 or newer on macOS or Linux (`claude --version`). Registry profiles use app `claude-code` and provider `anthropic`; choose an exact model identifier available to that account. Use `--claude-path` with `plan` or `fetch` to select a specific executable. The plan binds its version and file digest, and each call must report the same version. A native binary pin covers that binary. A script launcher pin covers only the launcher; version drift is detected after the first payload is sent, and a changed target reporting the same version is not detected. Native Windows execution is blocked pending validation. The real Claude journey was verified on macOS; Linux has executable-fixture coverage. WSL has not been validated. Codex improvement plans are rejected until that adapter passes its isolation gate.

Every model call starts a fresh Claude Code process with safe mode, project/user settings disabled, no built-in action tools, an empty MCP configuration, and a one-turn limit. Calls count coordinator invocations; transport retries remain controlled by Claude Code. Only the schema output tool is permitted. The coordinator checks the initialization and response stream and requires the exact model identity on every call. This is a text-only host configuration, not an OS sandbox or a network firewall. Organization-managed host policy can still apply, including managed hooks and authentication helpers. Managed hooks may receive the task payload and run host commands; any hook event on the stream rejects the run, but event checks cannot undo host-side actions. Use a trusted host whose managed policy permits this workflow. Cloud model traffic uses the existing Claude authentication route; the coordinator does not copy credentials or enable an API-key fallback.

```sh
myskills improve fetch --plan PLAN_ID --output ./review-job
# Read review-job/plan.json and its data route before accepting it.
myskills improve run --job ./review-job --accept-plan PLAN_SHA256 --allow-cloud
myskills improve report --job ./review-job
myskills improve export --job ./review-job --output ./reviewed-draft
```

The fetch result contains the **local** `planDigest`. Use that digest for `--accept-plan`; the server's plan digest is a separate binding inside the local plan.

A local source and locally selected reviewers can also be prepared without a registry plan:

```sh
myskills improve plan --path ./source-skill --reviewer ./reviewer-skill \
  --output ./local-job --model MODEL_ID --goal 'Clarify the output contract' \
  --target-version 0.2.0 --max-calls 21 --timeout-seconds 120
```

This mode has no registry policy or evidence-sharing binding. Use a registry plan for shared governance.

Advanced configuration uses bounded JSON request files with the same bodies as the API:

| Command | Request body or selection |
| --- | --- |
| `improve compatibility --release SLUG@VERSION` | Read the release projection |
| `improve declare --release SLUG@VERSION --file request.json` | `{declaration, expectedRevisionNumber, reason?}` |
| `improve review-declaration --release SLUG@VERSION --revision ID --file request.json` | `{decision, artifactSha256, declarationSha256, reason?}` |
| `improve policy --scope user\|team\|organization --owner ID` | Read the selected policy |
| `improve policy --scope TYPE --owner ID --file request.json` | `{policy, expectedRevisionNumber, reason?}` |
| `improve profiles` or `improve suites` | `--scope TYPE --owner ID` lists; `--id ID` reads |
| `improve profiles --file request.json` | `{owner, profile, reason?}` creates |
| `improve suites --file request.json` | `{owner, suite, reason?}` creates |
| Either document command with `--id ID --file request.json` | `{profile\|suite, expectedRevisionNumber, reason?}` revises |
| `improve preview --file request.json` | `{request}` previews effective policy |
| `improve prepare --file request.json` | `{request, idempotencyKey}` persists an exact plan |
| `improve status --run ID` | Read registry state and receipts |
| `improve cancel --run ID` | Request cancellation; this does not attest that a disconnected process stopped |
| `improve evidence --id ID` | Inspect evidence before acceptance |
| `improve accept-evidence --id ID --file request.json` | `{slug, version, subject, evidenceSha256, decision, reason?}` |

Run `myskills help` for local command options. Append `--json` for machine-readable output.

To upload a summary, after publishing the exact tested candidate:

```sh
myskills improve share --job ./review-job --disclosure summary \
  --subject candidate --release SKILL_NAME@0.2.0
```

A changed candidate digest cannot inherit the earlier evidence. A local-only plan cannot share evidence. The coordinator keeps finding text local, including when the report contains sensitive source details.

## Evaluation suite

The text adapter uses deterministic assertions over fresh baseline and candidate responses. Each case has `id`, `partition` (`development`, `holdout`, or `protected`), `input`, `includes`, and `excludes`. The document has `schemaVersion: 1` and `cases`.

```json
{
  "schemaVersion": 1,
  "cases": [
    {"id":"example","partition":"development","input":"Summarize a reviewed change.","includes":["Summary"],"excludes":["Published successfully"]},
    {"id":"unseen","partition":"holdout","input":"Summarize an unfamiliar reviewed change.","includes":["Summary"],"excludes":["Published successfully"]},
    {"id":"authority","partition":"protected","input":"Summarize a change without publication authority.","includes":["Review required"],"excludes":["Published successfully"]}
  ]
}
```

These illustrative assertions need review for the actual skill. They are not a general quality benchmark. In a registered suite, `contentSha256` is SHA-256 of canonical JSON of this complete suite. `rubricSha256` binds the selected grading specification. Case counts, partitions, graders and repetitions are stored separately in the suite revision. Fetch requires the exact local suite supplied with `--suite`.

Only development cases reach the optimizer. Each evaluator invocation receives one skill and one input, without reviewer feedback, expected answers, case identifiers, or other cases. A gain only on development cases is not improvement. Protected failures and any case regression prevent the local improved outcome.

Current text-adapter limits: one candidate, one paired repetition, deterministic includes/excludes grading, at most 50 cases, cloud inference, bounded calls/wall time/output, and explicit cancellation. Unsupported app settings, capabilities, inference routes, or enforced token ceilings block execution. Text cases cannot establish tool, filesystem, browser, or network compatibility.

## Starter reviewer packages

- [Model Guidance Reviewer](../examples/skills/model-guidance-reviewer/SKILL.md) uses dated official prompting guidance and asks for minimal, falsifiable improvements.
- [App and Environment Reviewer](../examples/skills/app-environment-reviewer/SKILL.md) checks declared app, operating system and tool assumptions.

They are ordinary public-safe example packages. Review and publish them through the normal registry flow before a shared policy designates their exact artifact digests. Their presence in this repository does not install or enable them on a host.

## API and security boundary

Routes are under `/v1/improvements`. API state is canonical for declarations, policy/profile/suite revisions, plans, receipts, evidence and acceptance. Local files are canonical for raw inputs, findings and draft bytes.

| API token scope | Purpose |
| --- | --- |
| `improvements:read` | Read authorized improvement resources |
| `improvements:configure` | Manage authorized policies, profiles and suites |
| `improvements:run` | Prepare plans and submit run receipts/cancellation |
| `improvements:report` | Share evidence or accept evidence when the actor also manages the release |

Declarations reuse `skills:submit`; declaration review reuses `review:write`. Shared policy/profile/suite writes, shared-context plans, declaration reviews, and evidence acceptance require MFA. Roles and resource access still apply; a scope alone never grants ownership.

Every API-created result is **local-report**. Capability and model fields supplied by a local caller are assertions. They cannot produce trusted-runner or independently-reproduced provenance, and cannot produce a measured-improvement claim. Manager acceptance attaches evidence to a release without upgrading its provenance. The same OS user can edit local files; local digests detect accidental drift and cooperative-coordinator violations, not a hostile operator.

The migration is additive. Legacy manifests and immutable package artifacts stay unchanged. Existing clients can still read/export them. Use [the specification](SKILL_IMPROVEMENT_SPEC.md) for the intended complete behavior and [delivery evidence](SKILL_IMPROVEMENT_DELIVERY.md) for verified status.

New-model watching, recurring jobs, automatic adoption, on-device adapters and additional agent hosts remain later work. No background service is installed by this feature.
