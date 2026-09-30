# Beta.18 release preparation

Prepared: 30 September 2026. Target release: `v0.1.0-beta.18`.
This is a preparation record. It does not claim publication, deployment or
real ChatGPT/Claude acceptance. The existing beta.17 tag remains unchanged.

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

Tracked Collections and Library Groups remain in progress pending model
decisions and are excluded. Inventory coverage does not establish runtime
parity; partial capabilities and unverified host behavior remain explicit in
[the capability ledger](CAPABILITY_PARITY_IMPLEMENTATION.md) and
[connector acceptance](MCP_CONNECTIONS.md).

The preparation merges maintenance source
`ba0ffe4a73a1f2484a4c5fe214b7f469e829717a` with parity/image source
`dcc45c0df7526e82ef2e90ed426430da5ee16f64` at merge
`b06f8eb62c49fc3495326a647c490fbf675b27cc`, followed by smoke-recovery repairs
and beta.18 metadata. Maintenance main
`3fb8020d019ff437c7c7a90982aa3e11c1caca29` is also included through the
content-preserving ancestry merge `760dacfae1e2a96fa80f9676eb89488955fd357f`.
Final verification must name the resulting immutable
candidate SHA; these earlier identities do not prove that candidate passed.

## Gate states

| Gate | State at preparation |
| --- | --- |
| Earlier local repository gate | Passed at `0b2dacece7c8be298eabebd6791a7b47af145d4b` with Node 22.23.2/npm 10.9.8: 1,341 tests passed and two existing skips. This is not the declared-toolchain Windows gate. |
| Standalone image tooling | At `dcc45c0df7526e82ef2e90ed426430da5ee16f64`, 83 tooling tests, lint and repository drift/privacy checks passed. Actual image execution was not part of that local proof. |
| Final-source Windows matrix and required branch checks | Pending; run the complete maintained matrix for the final candidate SHA. |
| Additive migration upgrade, staging and deployed routing | Pending. Read back migration IDs/schema and deployed API/web/MCP identity. |
| Real ChatGPT and Claude consent, tool use and revocation | Pending in both actual personal accounts. |
| Tag and canonical release verification | Pending; preserve the immutable beta.17 tag and use a new beta.18 tag. |
| GitHub assets and npm beta publication | Pending; verify exact artifact bytes and npm selectors after publication. |
| Production promotion and rendered acceptance | Pending; staging evidence does not establish production state. |

## Migrations and rollback

New since beta.17: `0034_oauth_connections` and `0035_oauth_assurance`. The first
adds six OAuth tables; the second adds nullable assurance timestamps and
constraints to authorization codes and grants. Existing grants gain no
assurance by backfill. The runner records complete filename basenames, sorts
filenames and applies each missing migration transactionally under an advisory
lock. Shared numeric prefixes do not collide; preserve both full identities.

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
