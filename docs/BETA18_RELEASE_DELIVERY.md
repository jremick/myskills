# Beta.18 release preparation

Prepared: 30 September 2026. Target release: `v0.1.0-beta.18`.
This is a preparation record with completed Collections verification and
phase-1 staging evidence. Final Collections staging, publication, production
promotion and real ChatGPT/Claude acceptance remain pending. The existing beta.17 tag remains unchanged.

## Scope

- Named API-backed CLI and MCP workflows, scoped delegated access, explicit
  browser/local handoffs and the maintained capability inventory.
- Opt-in OAuth remote connections with consent, PKCE, refresh rotation,
  revocation and session-derived MFA assurance. Grants gain no new scopes or
  assurance without fresh authorization.
- The fast-uri and brace-expansion dependency repairs, four-lane local CI,
  retained connector evidence, owned cleanup and a dedicated Railway MCP image.
- The existing beta.17 application changes described in
  [its delivery record](BETA17_RELEASE_DELIVERY.md).
- Personal and team Library Collections and Groups, inherited Library
  permissions, overlapping membership, derived source tracking, and named
  API/CLI/MCP operations. See [Libraries](LIBRARIES.md).

Collections and Groups merged in [PR #124](https://github.com/jremick/myskills/pull/124)
after the final Node 22/24 repository, PostgreSQL, browser, image and CodeQL
gates passed. Their source identities and retained evidence are recorded below.
Inventory coverage does not establish complete runtime parity; partial capabilities and unverified host behavior remain explicit in
[the capability ledger](CAPABILITY_PARITY_IMPLEMENTATION.md) and
[connector acceptance](MCP_CONNECTIONS.md).

The preparation merges maintenance source
`ba0ffe4a73a1f2484a4c5fe214b7f469e829717a` with parity/image source
`dcc45c0df7526e82ef2e90ed426430da5ee16f64` at merge
`b06f8eb62c49fc3495326a647c490fbf675b27cc`, followed by smoke-recovery repairs
and beta.18 metadata. Maintenance main
`3fb8020d019ff437c7c7a90982aa3e11c1caca29` is also included through the
content-preserving ancestry merge `760dacfae1e2a96fa80f9676eb89488955fd357f`.
The Collections verification below names its immutable candidate and tested
merge; these earlier identities describe ancestry only.

## Gate states

| Gate | Recorded state on 30 September 2026 |
| --- | --- |
| Earlier local repository gate | Passed at `0b2dacece7c8be298eabebd6791a7b47af145d4b` with Node 22.23.2/npm 10.9.8: 1,341 tests passed and two existing skips. This is not the declared-toolchain Windows gate. |
| Standalone image tooling | At `dcc45c0df7526e82ef2e90ed426430da5ee16f64`, 83 tooling tests, lint and repository drift/privacy checks passed. Actual image execution was not part of that local proof. |
| Final-source Windows matrix and required branch checks | Passed for Collections PR #124: all seven matrix jobs and CodeQL succeeded; tested merge `c2bd1e71d7bb6118f79ad1f07f28ae6d022a27e6` and landed source `6905bf690cd0b9108fc74a392f51909c9726aeb2` have the same tree. See the verification record below. |
| Additive migration upgrade, staging and deployed routing | Phase-1 OAuth schema and staging routing passed at `14970ba10a67f7372b713a3c29a17b8b72d91a24`. Migration `0036_library_selections` passed disposable PostgreSQL journeys; its staging upgrade and final-candidate deployment remain pending. |
| Real ChatGPT and Claude consent, tool use and revocation | Pending in both actual personal accounts. |
| Tag and canonical release verification | Pending; preserve the immutable beta.17 tag and use a new beta.18 tag. |
| GitHub assets and npm beta publication | Pending; verify exact artifact bytes and npm selectors after publication. |
| Production promotion and rendered acceptance | Pending; staging evidence does not establish production state. |

## Collections and Groups verification

[PR #124](https://github.com/jremick/myskills/pull/124) merged on 30 September
2026 after the four controller status contexts and GitHub CodeQL check
succeeded. Candidate head `a486f60fae00b449359ac83034ac056efff53d94`, tested PR
merge `c2bd1e71d7bb6118f79ad1f07f28ae6d022a27e6`, and landed main
`6905bf690cd0b9108fc74a392f51909c9726aeb2` share tree
`9e647634a7e28d6b63c7b324664ce9d9ee6f4219`.

The Windows WSL worker ran the complete maintained matrix as
`myskills-verify-c2bd1e71d7-1`, using Node 22.23.3 and 24.21.0 with npm 11.12.1.
All seven jobs passed, the result was gating, and cleanup completed.

| Check | Recorded result |
| --- | --- |
| Repository gates, Node 22 and 24 | 1,372 tests passed per runtime; no failures or skips. Includes API, CLI, MCP, web and tooling suites. |
| PostgreSQL gates, Node 22 and 24 | 253 tests passed per runtime; no failures or skips. |
| Browser gates, Node 22 and 24 | Per runtime: nine full-stack journeys, one isolated connector journey, and 160 mocked journeys passed; one mocked journey skipped. No global browser errors. |
| Railway images | Maintained image job passed. This is build/runtime smoke evidence, not a Railway deployment. |
| CodeQL | Separate gating run `myskills-codeql-c2bd1e71d7-1` passed on the tested merge; cleanup completed. |

The [PostgreSQL selection journey](../apps/api/test/library-selections-journey.pgtest.ts#L33)
uses real HTTP authentication, imports, review, tracking and PostgreSQL, with
fixture GitHub transport. Both runtime receipts confirm multiple sources,
independent `0.0.2`/`0.0.1` Library pins, hidden-member position filtering,
concurrent `200`/`409` writes, concurrent `201`/`422` quota outcomes, and
membership reorder/removal during reads. Selection changes preserve underlying
entries, adoptions and bindings. The [full-stack browser journey](../apps/web/test/e2e/fullstack/library-selections.spec.ts#L7)
passed without retries on both runtimes and proves Collections and overlapping
Groups persist without changing adopted skills.

The retained matrix export contains 92 files with SHA-256
`ac697a1e6d079fa2c947b38b91690659c6a288f12fb49a176505df89f16b1119`;
its application result indexes 89 evidence artifacts. The eight-file CodeQL
export has SHA-256
`fc6076588856bbdadd75b6becff5893d8dd7b1b802145ef7e4bf80dd8c2f24b6`.
Logs, browser summaries, screenshots and sanitized PostgreSQL receipts remain in the private
delivery packet. CLI and MCP selection fixtures prove adapter contracts;
they do not establish complete adapter-to-PostgreSQL parity or actual provider
acceptance. These checks do not deploy the Collections revision to Railway.

## Phase-1 staging evidence

On 30 September 2026, Railway `beta2-staging` was deployed from
`14970ba10a67f7372b713a3c29a17b8b72d91a24`, before Collections and Groups.
All seven maintained matrix jobs passed on that exact source in
`myskills-verify-14970ba10a-1`, with complete cleanup. [PR #123](https://github.com/jremick/myskills/pull/123)
also has five successful GitHub checks. Tested merge
`f8e7ceb99882694c6b1ff2b8a84764348f72b179` and the landed commit share tree
`68c18d6c93488fccce3046f436c808880dcaacff`. This evidence covers phase 1 only.

| Staging service | Verified deployment |
| --- | --- |
| API with OAuth enabled | `2455f9dc-ac0b-4213-85f0-5ceaeca1a368` |
| Web after same-build recovery | `47f8b7d4-3417-46c7-9435-28d5bedb5e83` |
| MCP | `c789caf9-98bd-40d7-b914-03252549fa52` |

Direct and same-origin API/web identity readbacks matched beta.18 and the
phase-1 revision. MCP runtime verification matched all 156 compiled files.
Schema readback found 41 recorded migrations, including both OAuth migrations,
six OAuth tables and four nullable assurance columns. It did not include
`0036_library_selections`; the Collections staging upgrade and deployed runtime
proof remain pending.

The first routing check passed three of six checks: API proxy requests timed
out after the final API replacement, although the direct API was ready. nginx
resolves `API_PROXY_TARGET` at startup. Redeploying the same verified web build
after final API readiness refreshed that resolution; all six routing checks
then passed. Both the failed result and successful recovery are retained.
A bounded log sample found no confirmed application faults in 25 API, 10 web
and two MCP lines; the MCP error-severity startup diagnostic was triaged as
expected `console.error` output.

The private delivery packet retains the staging rollout, schema, initial and
final routing, final runtime and log-sample receipts, plus the phase-1 matrix,
CodeQL and merge reconciliation. These records do not establish real provider
acceptance or the later Collections candidate. Production remains beta.16 at
`acfb7c8c7f8bc560f6fdba13cf0414033ab6d00e`; GitHub remains beta.17 and npm
`beta` remains beta.16. No beta.18 tag, canonical release verification or
publication is claimed.

## Migrations and rollback

New since beta.17: `0034_oauth_connections`, `0035_oauth_assurance`, and
`0036_library_selections`. The first
adds six OAuth tables; the second adds nullable assurance timestamps and
constraints to authorization codes and grants. Existing grants gain no
assurance by backfill. The runner records complete filename basenames, sorts
filenames and applies each missing migration transactionally under an advisory
lock. Shared numeric prefixes do not collide; preserve both full identities.
The Library migration adds selection and membership tables. It does not
change existing entries, lineages, adoptions, or installations. Verify both
new tables and the recorded migration identity after the upgrade. Include
them in backups and retain them during an application rollback.

An instance upgrading from beta.16 must also apply beta.17's
`0034_github_integration`, `0034_team_library_ownership` and
`0035_github_source_cooldown`. Keep the already applied observation-privacy
migration and all migration history. Back up the database, artifact storage
and configuration before the upgrade.

Apply migrations with OAuth disabled. Build Railway MCP from `Dockerfile.mcp`,
leave `MYSKILLS_MCP_PORT` unset for Railway's `PORT`, and deploy matching
API/web/MCP revisions. Check both OAuth migration IDs and their four assurance
columns; API health alone does not verify the OAuth schema. Follow the
[routing and host acceptance runbook](MCP_CONNECTIONS.md).

To disable connections, unset or disable `MYSKILLS_OAUTH_ENABLED` on the API
and clear the MCP service's paired OAuth URL variables, then restart those
services. For an application rollback, restore the previously verified service
revisions and configuration while retaining additive tables and migration
history. Stored grants remain; re-enabling may recognize grants that are still
valid. Revoke connections explicitly if permanent invalidation is required.
Do not drop connection tables as a rollback shortcut.
