# Libraries beta.8 implementation and verification

Status: implementation and focused native-install/browser verification complete. The clean canonical candidate gate remains required. No release or publication claim yet.

## Approved scope

The user approved building phases 1A–1C for the next release on 2026-09-26: personal public-GitHub import and provenance, manual/daily/weekly tracking, an in-app inbox, team curation of already-authorized releases, explicit adoption and installation bindings. The user also approved owner self-review for strictly private imports with an administrator enable/disable switch. Private repository credentials, organization-owned imported content, email delivery and unattended local updates remain later phases.

## Failure cases recorded before implementation

1. Admin disables private self-review while an owner has a preview open: attestation must fail with current policy, without making content shareable.
2. Owner or visibility changes during attestation: no stale authority may approve another user's or shared content.
3. A private attestation is used to publish or grant team/user/organization access: all canonical mutations must deny until ordinary instance review.
4. A user guesses another person's library, preview, notification or source ID: content and private metadata remain unavailable.
5. Team member removal or underlying release revocation occurs after list: subsequent reads, adoption and delivery recheck access.
6. Source branch moves between preview and confirmation: only held immutable bytes can be submitted, or confirmation fails.
7. Duplicate confirm/check requests and worker retries: one logical candidate, immutable provenance and one notification per subscribed recipient.
8. Upstream changes unrelated files: no selected-skill update notification. Selected support-file or license changes are material.
9. Upstream is deleted, renamed, rate limited or unavailable: last success remains distinct from last attempt; installed content stays pinned.
10. Invalid provider URL, redirects, oversized trees/blobs, symlinks, traversal, binary files or executable install hooks: fail closed without network or filesystem escape.
11. CLI explicit version differs from a bound library adoption, or the adoption changes before file promotion: no out-of-policy update.
12. Library entry disappears or access is revoked: existing files and recorded binding remain; never fall back to latest release.
13. Local managed files are edited: library update preserves them and reports drift; existing rollback remains available.
14. A newer registry version exists but a library still adopts the old version: Updates and CLI stay constrained to the adoption.
15. Conflicting library versions bind the same target skill: no candidate is executable until resolved.
16. A slow browser response arrives after a library/account change: do not display or act on the stale selection.
17. A server mutation succeeds but the client response is lost: retry the same mutation identity; do not create duplicate entries/imports.
18. Migration on populated beta.7 data: existing authorization and install behavior continue; new self-review setting is disabled.

## Evidence targets

- Backend: persistent PostgreSQL HTTP journey for owner/admin/outsider/team actors, fixture upstream changes, denied sharing, concurrent/replayed mutations and tracking.
- Browser: medium-complexity create/source/preview/import/adopt/subscribe journey with keyboard-accessible controls, error recovery, mobile layout, screenshot and Playwright trace.
- CLI: real local HTTP fixture and real temporary filesystem journey; adoption pin, advancement, drift and missing-binding denial, with a structured receipt.
- Integration: repository check, PostgreSQL suite, browser suite, production-like fullstack journey and clean release-artifact verification.
- Independent Opus review of final diff and verification evidence before release preparation is called complete.

## Current gate status

| Check | Result and limit |
|---|---|
| Repository check | Passed: 1,144 tests, all workspace builds, lint, web typecheck, prerelease/package smoke, structure/privacy/secrets and zero production audit findings; precedes final atomic lease changes |
| CLI suite | 217 passed, including the final review-digest option |
| API suite after final backend changes | 415 passed; API build and lint passed after the license-freshness fix |
| Web unit suite | 194 passed; the later identity UI is covered by the browser journeys |
| Libraries browser journeys | Nine passed in Windows-container Chromium; the complete 18-test browser suite passed without retries, including explicit name normalization and source-digest inspection |
| Persistent Libraries journeys | Both passed against Windows-hosted PostgreSQL: 41 import/curation scenarios and 20 remediation scenarios, including atomic takeover and the final license-freshness check |
| Complete PostgreSQL gate | Passed: 232 tests, zero failures, cancellations or skips; Node client and PostgreSQL both ran on Windows Docker, including all 61 Libraries scenarios |
| Populated beta.7 migration rehearsal | Passed after identity columns were added; existing users/skills unchanged, self-review disabled, rerun idempotent; 0032 SHA-256 `0af0856ea67bfa67108ff5beeaec3eaa11aa4b8c9a06dc660062dff2129d640e` |
| Production-like full stack | All six journeys passed with containers on Windows and Comet as the browser; no skipped or flaky results |
| Final Opus backend review | No release-blocking defect found in the tracking fences or license fix; read-only source and receipt review, with low-severity concurrency findings recorded below |
| Canonical release gate and artifacts | Pending; no release or deployment claim |
| Native imported-skill install | Passed all 18 persistent scenarios on Windows Docker: exact source preservation, served artifact, install, uploaded observations, adoption update, rollback and drift; actual Codex discovery independently found one enabled skill |

## Verification record

- Baseline: GitHub main `7a0fc44e6a1cabaabfdcf494c3cc96db4cf7d3cc`; isolated branch `codex/library-beta-8`. Changes are not committed or published.
- Runtime: Node 24.19.0 and repository-pinned npm 11.12.1. Isolated `npm ci` completed with zero audit findings. The final repository check also reported zero production audit findings.
- Container placement: the Windows PC ran Docker 28.3.0 with a Linux x86_64 engine. Local Docker Desktop was stopped. PostgreSQL test clients and Comet reached the remote services through loopback SSH forwards.
- Opus implementation and reviews used the existing personal Claude subscription. Runtime records identify `claude-opus-5-5`; the helper requested `xhigh`, but the runtime supplied no independent effort field. Delegates had bounded read or edit tools with no shell. Codex ran the reported checks.
- Backend review corrections cover per-entry repository identity acknowledgement, tracking retries, ignored candidates, import lineage order, discovery bounds and request quotas. The final fence changes make a tracking write and its lease check one transaction, and commit new candidates with their notifications. Persistent scenarios R16–R19 cover takeover before snapshot, candidate, event and completion writes; S41 independently hashes served owner and reviewer bundles. R20 passed on a separate disposable database and proves that missing live license metadata requires an explicit mapping rather than a cached identifier.
- CLI checks cover explicit adoption pins, bypass attempts, an adoption change before file promotion, deleted bindings, local drift, per-skill failure isolation, local unbinding and exact review-bundle hashes. All 217 CLI tests passed after the final expected-digest option.
- Eight Comet browser journeys cover policy revocation after preview, source refs, selected metadata, removal, saved candidates during a provider outage, artifact tampering, pagination, adoption, bindings, identity review, import ordering and uncertain policy responses. Each writes a structured receipt; the mobile journey writes a screenshot. These use route fixtures.
- All six production-like fullstack journeys passed with Windows-hosted containers and Comet. The persistent Libraries journey covers administrator policy enable/disable, creation, adoption, curator note retention, subscription, reload, reference removal without release deletion and anonymous denial. Its mobile screenshot was inspected. These results precede the final tracking fence and license-freshness refinements, whose affected paths are verified in PostgreSQL journeys.
- The populated beta.7 migration rehearsal passed after the identity columns were added. Existing users and skills were unchanged, private self-review was disabled, and a second migration run was idempotent. Migration 0032 has not changed since that rehearsal.
- The first complete PostgreSQL run used a Mac client and a Windows-hosted database. The database clock lagged the client by approximately 21 seconds, violating timestamp constraints in existing target-operation tests. A separate diagnostic reproduced the failure with pre-Libraries migrations and unchanged store code. No timestamp assertion or system clock was changed. A rerun with client and database together on Windows Docker passed all 232 tests in 113.4 seconds, including the previously failing cases and all 61 Libraries scenarios. The source image was checked against the final API/core/migration/test file digests.
- The complete existing route-fixture browser suite is not green in Comet. First-page startup reloads reset form/profile state, and native selects ignore synthetic arrow keys in a minimal HTML probe. Three existing tests fail; their assertions remain unchanged. After the owner approved a Windows-container Chromium exception, all 17 existing tests passed unchanged, and all 18 passed with the normalization preview journey added. The final candidate gate must still run against the integrated immutable commit.
- Native normalization verification passed with the real API, PostgreSQL, CLI and temporary workspace filesystem on Windows Docker. The original and installed file digests match the held artifact through import, private attestation, adoption, install, update and rollback; editing the runtime name produces drift. Before the final provenance correction, the full PostgreSQL suite passed all 232 existing tests and the new journey failed only at the stale importer-version assertion. The focused new journey then passed after the correction. The canonical run must refresh the complete suite.
- A separate local Codex 0.154.0 app-server probe used only initialization and `skills/list` against a temporary workspace containing a production-packager artifact. It found exactly one enabled skill under the normalized slug. The preserved original was not discovered as another skill. This proves native discovery, not model-selected invocation or execution.
- A read-only live source probe resolved `EveryInc/compound-engineering-plugin` to commit `a763b392c3c05faa1a383c0d228b7e95200ecc90`, with a complete 1,367-path inventory and 36 skill roots. The selected `skills/ce-plan` preview contained 38 files and 589,431 bytes. The existing scanner blocked two supporting files with potential-exfiltration findings, and `argument-hint` required host-capability review. No import or repository code execution occurred. This proves discovery and conservative blocking for that snapshot, not whole-plugin compatibility or a confirmed upstream vulnerability.

## Repeating the focused checks

Use the repository's declared Node/npm versions and build the workspaces first. PostgreSQL checks reset their database; use a disposable database whose name contains `test` or `ci`. Run containers on the Windows PC when available. Set `DOCKER_HOST` and loopback forwarding for the selected host before a fullstack run.

```bash
npm run check
TEST_DATABASE_URL="$DISPOSABLE_TEST_DATABASE_URL" npm run test:postgres
node --import tsx --test apps/cli/test/library-journey.test.ts
MYSKILLS_E2E_BROWSER_EXECUTABLE="$APPROVED_BROWSER_EXECUTABLE" npm run test:e2e -w @myskills-app/web -- library-journey.spec.ts
MYSKILLS_E2E_BROWSER_EXECUTABLE="$APPROVED_BROWSER_EXECUTABLE" npm run test:e2e:fullstack
```

For a focused persistent rerun, execute `node --import tsx --test apps/api/test/library-journey.pgtest.ts` with the same disposable `TEST_DATABASE_URL`. `LIBRARY_JOURNEY_EVIDENCE_PATH` and `LIBRARY_REMEDIATION_EVIDENCE_PATH` select its two JSON receipt files. The native install journey runs with `node --import tsx --test apps/api/test/library-native-install.pgtest.ts`; `LIBRARY_NATIVE_INSTALL_EVIDENCE_PATH` selects its receipt. The browser runner retains reports, traces and journey attachments in its configured output directory; copy evidence before another run replaces that directory.

These focused runs diagnose and verify the implementation. The clean `npm run release:verify` gate in [RELEASE.md](../RELEASE.md) remains required before release preparation is complete.

## Open review findings

The final read-only Opus review found no release-blocking defect in the tracking fence or license-freshness changes. These observations remain open; they are not verified production incidents:

- Adoption and library deletion acquire row locks in opposite order. Concurrent actions can deadlock; PostgreSQL rolls one transaction back and the API currently returns HTTP 500. A retry is safe. Source-entry removal versus first import has the same possible lock cycle. The review establishes the lock order from SQL; these cycles have not been reproduced in a test.
- Discovery can theoretically replace a last-good snapshot written by a concurrent check when discovery began with no last-good snapshot. This can affect a root-change notification transition, without changing an artifact or its provenance. The race has not been reproduced.
- Lease-takeover tests cover snapshot, candidate/event, root-event and completion writes. Identity-change writes and notifications for an already-existing candidate use the same locking boundary, but do not yet have separate takeover cases.
- Explicit license mappings remain owner-reviewed decisions and persist across previews. A saved mapping that differs from current provider metadata is not separately flagged. Snapshot license notices remain in the inspected artifact.
- Frontmatter import supports a conservative YAML subset without a new dependency. Some valid YAML structures are blocked rather than rewritten or guessed; unsupported syntax is reported in the preview. Missing descriptions and byte order marks also block because the native install contract requires a description and an initial `---`.
- The web navigation assumes matching API/web versions; it does not hide Libraries when connected to an older API. Deploy both from the same candidate.

## Approved completion decisions

- On 2026-09-26 the owner approved normalizing the runtime `SKILL.md` name to its unique registry slug, preserving the exact original in `myskills-source-skill.txt`, and exposing both SHA-256 digests. The new 18-scenario persistent journey was authored before production changes. It fails against the previous importer at the expected runtime-name assertion; the original source name was still present where the normalized registry slug is now required. The 18-scenario journey now passes. It also caught a stale importer version in the provenance insert; that insert now uses the same version constant as the packager.
- On 2026-09-26 the owner approved matching Playwright Chromium in a Windows-hosted container for the complete browser gate. All 17 existing tests passed without retries; the added normalization preview journey then passed with the full 18-test suite. The exception is limited to this test workflow.

## Deployment constraint

Source review establishes that private self-review writes an approved release with a separate attestation, and library target constraints are enforced by beta.8 application code. Beta.7 lacks those guards. The release and Railway runbooks therefore require draining older API instances before library writes and preserving the guards in any rollback. No production migration or mixed-version behavior has been exercised in this task.
