# Beta.8 release delivery

Status: combined candidate verification in progress. Not released or deployed.

## Scope and authority

The owner approved integrating Libraries and skill improvement, completing and pushing the release, and updating the live deployment on 26 September 2026. This chat owns integration, publication and deployment; the Libraries checkout remains unchanged.

Inputs:

- Skill improvement: `5b4d492e551455e88f4f4d9da9f273635b633716`, PR #87. Its clean canonical gate passed on Windows: 1,180 repository tests, 11 browser journeys, six full-stack journeys and 231 PostgreSQL tests. The native macOS Claude Code journey passed seven calls, and Opus reviews closed high/blocking findings.
- Libraries: `e530654c27d3830fe720b83353aef1e8aaf28c71`. Its checkout and verified feature evidence are preserved. See the [Libraries ledger](plans/2026-09-26-library-build-evidence.md) for scope and limitations.

Both feature commits must remain in the combined history. Package versions use `0.1.0-beta.8`; only the npm `beta` selector may move. New-model watching, unattended skill optimisation, private GitHub credentials and unattended local library adoption remain excluded.

## Combined failure cases and acceptance

The original feature journeys were written before their implementations. Integration must preserve both sets of assertions and address these combined failure paths:

1. A conflict resolution drops either API service, route registration, capability flag, token scope, UI client or CLI entrypoint.
2. Private library self-review or sharing elevation bypasses the latest skill declaration/artifact publication binding.
3. An accepted optimisation report upgrades locally reported provenance or grants library access to private content.
4. Library adoption or target binding changes allow improvement export or install to replace an unapproved package.
5. Migrations fail on populated beta.7 data, rewrite old records or fail on replay. Both full migration IDs must be applied exactly once.
6. An older API runs alongside beta.8 and ignores new private-attestation or library-binding guards.
7. Package, source archive, tag, staging and production report different candidate identities.

Acceptance requires a combined independent Opus review, clean canonical release verification on Windows, current GitHub checks, populated upgrade rehearsal, staging browser/API/CLI acceptance, a current database-and-artifact recovery point, and exact published package and deployed identity readback. Failure in a required gate stops dependent promotion.

## Promotion and recovery

Use personal Railway project `myskills-app`, staging `beta2-staging`, then `production`. Capture the live deployment IDs and recovery set before promotion. Drain the older API before enabling library writes, deploy the candidate API and verify readiness, then deploy web from the same commit. Account for a short API interruption.

Beta.7 cannot safely interpret new private attestations or library target constraints. After beta.8 writes, recover with a fix-forward candidate retaining both features' guards. A database restore that loses new data requires a separate explicit recovery decision. Do not drop new tables or point an old API at newer data as a shortcut.

## Evidence to complete

- Combined candidate SHA, independent review and canonical gate artifacts.
- Populated migration preservation and replay receipt.
- GitHub required checks and tag workflow.
- Staging API/web deployment IDs and acceptance receipt.
- Coordinated recovery set and current readiness.
- npm exact-version integrity, fresh exact and `beta` installs, unchanged `latest` and `alpha` selectors.
- GitHub prerelease URL and artifacts.
- Production API/web deployment IDs, source/version readback, existing-session and anonymous/private-delivery browser checks, and sanitized error-log review.
