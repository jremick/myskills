# OPT-1 delivery and verification

Status: implementation in progress; not released.
Baseline: `7a0fc44e6a1cabaabfdcf494c3cc96db4cf7d3cc`.
Scope: [specification](SKILL_IMPROVEMENT_SPEC.md), Phase 0 and Phase 1a/1b. Later scheduled detection and unattended adoption remain excluded.

## Failure cases defined before implementation

The primary checks traverse API/CLI/browser workflows. New isolated checks, if needed, must be written before the implementation they verify.

1. An actor selects personal context to evade the source owner's organization restrictions.
2. A revoked or modified reviewer, source artifact, policy, or target is used after planning.
3. A local report invents model identity, evaluation scores, or shared publication authority.
4. Declaration metadata changes after approval while package bytes stay unchanged.
5. A candidate changes its slug, version, visibility, permissions, tests, or locked files after evaluation.
6. An output path, symlink, duplicate path, or file collision escapes scratch storage or overwrites a source/installed skill.
7. Malicious source content or candidate instructions gain reviewer/evaluator tools, network access, hooks, or private context.
8. Cloud inference proceeds without explicit local data-route consent, or an on-device-only plan falls back to cloud.
9. Candidate generation removes protected requirements, self-grades, edits the evaluation suite, or uses holdout cases.
10. Cancellation, timeout, excessive output, failed invocation, malformed JSON, or budget exhaustion is represented as success.
11. A retry duplicates provider work, changes models, or publishes two results.
12. A report exposes tokens, private source text, paths, or unauthorized evidence in logs or another owner's release page.
13. Baseline and candidate use different cases/settings, or the candidate is packaged with untested content.
14. Old package readers fail after an API metadata extension.
15. A team/org member can edit reviewer policy or accept evidence without the required owner/admin/reviewer authority.
16. A completed filesystem install is shown as confirmed host activation.

## Required evidence

- Medium-to-hard local journey: checked source plus reviewer, explicit plan and data consent, proposed candidate, protected and holdout evaluations, regression/no-change results, repeatable report, safe draft export, tamper/timeout/cancel denial.
- API/Postgres journey: multi-actor policy/declaration/plan/report lifecycle with hidden-resource, tampering, ownership, stale policy, and third-party evidence-attachment denials.
- Browser journey: metadata states, local handoff, policy selection and report review, including errors and narrower viewport.
- One bounded real Codex adapter probe against public fixtures. Fixture results and real model results are recorded separately.
- Repository checks, CLI release artifacts and clean-install verification, plus independent Opus review of implemented security boundaries.

## Rollout and stop conditions

Use additive migrations and preserve immutable package bytes. Keep unsupported adapter capabilities disabled. Stop a dependent path if isolation, source identity, authorization, or an evaluation claim cannot be demonstrated. Resolve material gaps before release; report any proposed scope change explicitly.

A source change, merged PR, npm package, GitHub release, and hosted deployment are separate evidence states. Release coordination must avoid colliding with the concurrent Libraries work. Production promotion needs the repository's documented staging, backup, migration, and same-commit API/web checks.

## Evidence ledger

### Verified implementation candidate (2026-09-26)

| Check | Result | Repeatable evidence |
| --- | --- | --- |
| Repository gate, Node 24.20.0 / npm 11.12.1 | `npm run check` passed: structure, privacy, secrets, production dependency audit, lint, builds, web typecheck, prerelease/package smoke, and workspace tests | Standard repository command; package smoke installs the built CLI artifact |
| Local CLI workflows | Nine journeys passed | `node --import tsx --test apps/cli/test/skill-improvement-journey.test.ts` |
| Core policy boundaries | 21 checks passed, including exhaustive reviewer role sets | `node --import tsx --test packages/core/test/improvement-policy-boundaries.test.ts` |
| API workflows | Six HTTP journeys passed | `node --import tsx --test apps/api/test/skill-improvement-journey.test.ts`; sanitized JSON journals in `MYSKILLS_JOURNEY_EVIDENCE_DIR` or the OS temporary directory |
| Complete PostgreSQL suite | All 231 tests passed with Node 22.23.3 and PostgreSQL 17.11 on Windows | `npm run test:postgres -w @myskills-app/api` against a disposable test database; includes deterministic declaration/publication lock races |
| Browser workflow | Two browser journeys passed | `apps/web/test/e2e/skill-improvement.spec.ts`; metadata editing, blocked/allowed plans, cached profile and local handoff |
| Full stack | Six journeys passed using the production proxy, API, Postgres, object storage and captured email on Windows | `npm run test:e2e:fullstack`; JSON report at `apps/web/test-results/fullstack-report.json`, screenshots and `improvement-acceptance` attachment |
| Starter reviewer packages | Both validate and scan clean | CLI `validate` and `scan` on the two new example package directories |

The new full-stack journey invokes the built CLI as a subprocess, evaluates a sealed candidate with development, holdout and protected cases, publishes the exact candidate bytes, and accepts its evidence. The screenshot shows `locally reported improvement · local-report · current`. Its executable is a deterministic fixture: this verifies integration, not model quality or agent-host isolation.

The Postgres test process and database run together on Windows. An earlier cross-host run exposed time-sensitive failures with a measured 21-second clock difference. The final co-located run passed. No production data or host clock was changed.

### Review corrections

Independent Claude Opus review found four blocking defects. Corrections cover finite token ceilings with unknown token usage, reviewer role restrictions, result-destination disclosure policy for unlinked local sources, and declared-target labels based on current subject evaluations. Additional checks cover personal default-policy composition, reviewer revocation at sharing, and candidate reviewer cycles.

Publication now checks the latest author declaration and exact artifact/revision approval in the same transaction. Declaration writes serialize on the release row. An unreviewed or rejected latest declaration blocks publication; no-declaration legacy releases still publish. A post-publication declaration is a separate attestation.

The boundary tests and publication assertions were written before their corresponding fixes. Opus used `claude-opus-5-5`, with helper-recorded `xhigh` effort, through the existing personal Claude subscription. Assistant transcript metadata confirms the model. Final read-only review confirmed that all four blockers and the publication gate were closed, with no remaining blocker or high-severity finding on those paths. This review did not execute tests.

### Open release gates

- The real Codex adapter probe completed one public-fixture `gpt-5.5` call with `no-change`. Its stream supplied no exact model identity. An earlier explicit `gpt-6-sol` request failed as unsupported; the product does not fall back.
- Codex 0.154.0 loads global `AGENTS.md` through `CODEX_HOME` even when user configuration and project documents are disabled. Its tool catalog can include `apply_patch`. The text adapter therefore has **not passed the required isolation gate** and must not ship as a supported runner in this state.
- A user decision is pending on retaining Codex as the first runner or changing the first supported runner to Claude Code. The latter still needs implementation and real isolation proof. No credentials were copied and no new authentication path was created.
- Beta.8 integration with the concurrent Libraries work, version changes, commit-bound release artifacts, GitHub/npm publication, and same-commit hosted deployment remain pending. This candidate is not merged or released.

Container testing uses the Windows PC through the existing SSH route. Local Docker Desktop remains stopped. The test databases and fixtures contain synthetic data only.

## Lower-priority review follow-ups

The final review also recorded bounded limitations for later triage: local source bytes cannot reliably establish their original owner's policy; destination disclosure is checked before storage without a shared policy transaction; target labels indicate a matching test, not complete coverage of every declared alternative; policy/document replay and concurrent runner-digest replay can be stricter; and finite token budgets have no supported text-adapter path. Token ceilings fail closed. None of these upgrades local reports to trusted evidence. Release acceptance must keep these limits distinct from the required real-runner isolation gate.
