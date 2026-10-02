# Task discovery

Task discovery finds authorized approved releases from a task description. The
API owns authorization and release identity. Discovery does not activate,
install or execute a skill.

## Method and limits

`lexical-v1` normalizes Unicode text, lowercases it, splits letter/number words,
removes common English stopwords and duplicate terms, then compares word sets.
Single-character terms are ignored. Title/slug matches have weight 3, tag matches
weight 2, and summary matches weight 1. Each term contributes its highest weight
once. The score divides the total weight by three times the task-term count.
Ties use ascending slug order.

This is word overlap. It does not understand synonyms, negation or intent. Scores
and overlap labels do not estimate trust, quality, execution authority or task
success. A positive match can be irrelevant. Users must inspect the release.

- Task: 1–4,000 characters; JSON request body: at most 20 KiB.
- Terms: first 64 distinct meaningful words, with explicit truncation status.
- Catalog: first 500 authorized entries in ascending slug order, with explicit
  truncation status. Ordinary paginated search can reach later entries.
- Results: 1–20 requested, default 10. Only approved, reviewed, scan-passed
  entries with a selectable default release can appear.
- Summary/tag/platform metadata has response bounds. Package bodies are not read.

Each candidate is checked against current skill visibility and its exact release
before return. Credential authorization is checked again after those reads. A
revoked or invalid credential fails; it does not fall back to anonymous access.
Changed or unavailable candidates are omitted and identified as uncertainty.
Responses use `Cache-Control: no-store`. Tasks are sent in a POST body rather than
a URL; this service does not persist or cache task text.

## Entry points

API: `POST /v1/skills/discover` with `{"task":"Review code for concurrency races","limit":3}`.
Anonymous calls use the public corpus. Supplied sessions, API tokens and OAuth
credentials retain the existing authorization rules; delegated credentials need
`skills:read`.

CLI: `myskills discover "Review code for concurrency races" --limit 3 --json`.
The command uses the configured API and existing login credential. It does not
create another authentication route.

MCP: `discover_skills` takes the same `task` and optional `limit`. It uses the
connection's existing `skills:read` grant. Ordinary `search_skills` stays available.

Web: open **Find skills for a task** in Skills. A result links to the exact release,
shows its digest, and reports the method and limits. Editing the task clears the
previous results. Ordinary search remains available.

The response includes `method`, `fallback`, `provider`, `catalog`,
`taskTermsTruncated`, `uncertainty` and `results`. Each result includes a skill,
exact `slug`/`version`/`sha256`, review/security status and word-overlap evidence.

## Provider boundary and remaining decisions

Provider status is `disabled`, reason `provider-not-configured`, calls 0 and
reported cost 0. No key input or provider execution path is implemented. The
roadmap's provider choice, credential ownership, data egress, budget, retention
and paid evaluation remain explicit strategic decisions. Basic discovery never
makes a model call.

## Repeatable evidence

The fixed synthetic corpus and relevance judgments in
`apps/api/test/fixtures/task-discovery.ts` were authored before ranking. They cover
release notes, code review, incident reporting, meeting notes, API documentation,
an ambiguous task and two tasks with no useful match. Public, team, owned private,
hidden private, archived and unsafe records exercise the authority boundary.

Run the HTTP/domain and CLI/MCP adapter journeys:

```bash
node --import tsx --test apps/api/test/task-discovery.e2e.test.ts apps/api/test/task-discovery-adapters.e2e.test.ts
```

The HTTP journey writes `test-results/task-discovery-evidence.json`. It compares
the identical full task text against ordinary substring search, using hit at 3,
reciprocal rank, no-match correctness and observed local latency. These are
fixture measurements, not production performance or a model-benefit claim.

`task-discovery.pgtest.ts` exercises real PostgreSQL visibility, release digests
and membership revocation. The browser journey in `task-discovery.spec.ts` records
desktop/mobile screenshots and a structured interaction receipt. Its mocked API
does not establish database or deployed proof. Real-host and deployed acceptance
must be recorded separately.

## Wave2 integration source state

Shared API production registration, CLI/MCP dispatch and browser entry paths are integrated on the roadmap candidate. Historical leaf-check receipts above remain historical and are not whole-candidate acceptance. Current Node22 source/narrow checks and parent canonical PostgreSQL/browser/image results are recorded in the wave2 build report.
The production final decision uses one read-only REPEATABLE READ snapshot for credential/account, visibility/grants, current default metadata and exact release identity. Results are lexical overlap only. Browser connection/credential changes remount and discard all task/result state. Fixed synthetic ordinary-search/no-match/latency receipt remains required under reports; no provider calls or effectiveness/activation/trust claim is authorized.

Wave2 local proof: fixed synthetic memory API corpus/ordinary-search/no-match/latency checks and CLI/MCP transport tests pass. The JSON receipt is retained in the wave2 reports. Desktop/mobile keyboard browser journeys pass, and two DOM regressions confirm that completed results, private task text and pending state cannot cross token/connection changes. Twelve static-site tests pass after aligning the home copy with composed skill sets, profiles/environments and architecture lifecycle; local rendering does not prove composed rollout or live host acceptance. Final coherent PostgreSQL snapshot tests are prepared and typechecked for controller execution, not run locally.
