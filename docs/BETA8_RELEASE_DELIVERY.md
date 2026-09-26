# Beta.8 release delivery

Status: combined candidate verification and staging acceptance in progress. Not released; production remains on beta.7.

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

## Integration verification before the final candidate

- Combined commit `e766673fd4f5fb928b0725ef51e560565ebba7a9` passed the clean canonical gate on Windows: 1,186 repository tests, 20 browser journeys, seven full-stack journeys and 234 PostgreSQL tests. The corrections below require a new commit-bound gate.
- An independent Opus 5.5 review found one medium integration defect: private self-review reached the database publication trigger without the application declaration guard. Publication stayed blocked, but the API returned 500 and omitted a durable deny audit. The combined persistent HTTP journey reproduced that failure before the four-line guard correction, then passed all seven scenarios. The browser now explains the review requirement.
- Four CodeQL findings were corrected: linear source-path boundary scans replace a quadratic regex, and three test journals use exclusive private files in unique private directories. Regression checks were written first. All three Libraries journeys passed in the integrated Windows checkout, covering 82 scenarios.
- The populated beta.7 upgrade rehearsal preserved 50 pre-existing tables and 18 seeded rows, applied both full migration IDs exactly once, kept private self-review disabled, and passed replay. This is synthetic migration evidence, not a production restore claim.
- Production configuration preflight passed. A fresh coordinated recovery set captured 51 tables and 87 artifacts at `2026-09-26T06:58:37.893Z`, with `sourceWrites=false`. Run ID: `2026-09-26T06-58-37.845Z_797679ecafbda4c1`; manifest SHA-256: `bcd9f287f7b5a50c34bd433f922da27dd5521ebe1069cb22ee8b8bd499217fdb`. Railway execution `38c3ebd0-4378-4bba-8e53-59b34b60c598` exited, and the daily 16:00 UTC schedule remains unchanged. Readback verifies the completed set; this capture was not separately restored.

PR review identified two further corrections after the first combined gate. Concurrent same-key run creation now rechecks the runner digest after the store serializes the requests. Evidence acceptance now re-resolves the reporter's current account, plan inputs and policies, plus the destination disclosure policy; rejection stays available. Regression journeys reproduced both failures before the changes, then all eight focused improvement journeys passed, including the persistent mixed-feature journey. A different release manager can still accept another reporter's valid evidence. Candidate `f1e0cc5d53e99a7aaf87b5e0187d374fbc940a67` passed the clean Windows canonical gate: 1,186 repository tests, 20 browser journeys, seven full-stack journeys and 235 PostgreSQL tests. All 12 GitHub checks passed. An independent Opus review found no actionable defects in those corrections.

Two subsequent Libraries review findings are corrected. Adoption locks and rechecks the active actor and effective library ownership inside its transaction, including required organization membership. Inbox traversal uses keyset batches past hidden events and counts all visible unread events. Tests written before the changes reproduced three unauthorized adoptions and two truncated inbox counts. All five regressions then passed on Windows, along with the three Library journeys covering 87 scenarios, lint and API build. The final combined gate, independent review and staging refresh remain required.

Staging API deployment `cf0dfd35-df9d-452e-9856-d8fdc8224659` serves `f1e0cc5` with all readiness checks passing. Production remains on beta.7.

Staging web deployment `5cf3dcd4-ab61-4f39-b478-539f020f9aec` also served `f1e0cc5`. Direct API, web and same-origin version readbacks matched; readiness and cache-header checks passed. All three deployed browser/API/CLI journeys passed on the Windows PC: persistent Libraries, the 20-check operational install/update/rollback flow, and skill improvement through exact candidate publication and evidence acceptance. Separate author, MFA reviewer and consumer accounts were used. Temporary owner MFA and supplied sessions were removed, the scoped MCP token was revoked, and private self-review returned to disabled. This proves that staging candidate, not the later corrected release commit.

The independent reviews used the existing personal Claude subscription. Assistant transcript records identify `claude-opus-5-5`; `xhigh` was configured. Codex ran the cited checks. The declaration/self-review race is not separately covered by the new journey; both writes use the existing release-row lock, and the guard runs inside it.

## Evidence to complete

- Combined candidate SHA, independent review and canonical gate artifacts.
- Populated migration preservation and replay receipt.
- GitHub required checks and tag workflow.
- Staging API/web deployment IDs and acceptance receipt.
- Coordinated recovery set and current readiness.
- npm exact-version integrity, fresh exact and `beta` installs, unchanged `latest` and `alpha` selectors.
- GitHub prerelease URL and artifacts.
- Production API/web deployment IDs, source/version readback, existing-session and anonymous/private-delivery browser checks, and sanitized error-log review.
