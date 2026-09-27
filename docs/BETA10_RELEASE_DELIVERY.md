# Beta.10 release delivery

Status: GitHub prerelease published and production promotion verified on 27 September 2026. npm publication is excluded.

## Approved scope

The owner authorized pushing skill bundles for the next release and updating the live deployment. The release targets GitHub and the hosted application. npm publication is explicitly excluded. The CLI archive remains a verified GitHub asset.

The release adds grouped, list and outline registry views; source groups grounded in reviewed imports; curated collections; revision-aware editing; reference-only saving to Libraries; and matching API, CLI and MCP operations. Each read filters current access before returning names or counts. Team writes retain MFA requirements. Bundles never adopt or install skills.

The isolated branch preserves the resident checkout and the separate design-framework, Libraries redesign and email/outbox work. Opus 5.5 implemented the UI through the personal Claude subscription with xhigh recorded in runtime settings. The visual layout follows the approved mockup and the shared design direction.

## Pre-release implementation evidence

The implementation passed the repository gate (1,191 tests, two Linux-only tests skipped on macOS), all 241 Postgres tests, eight browser journeys with no uncaught page errors, and a real browser/API/Postgres save-and-reopen journey. These results precede the release version commit and do not replace its canonical release gate or deployed acceptance.

## Delivery sequence

1. Commit the beta.10 candidate, push the feature branch and pass current protected-branch CI, including CodeQL policy.
2. Run the clean canonical `npm run release:verify` gate and retain its artifacts. Verify the same immutable source on dedicated Railway staging.
3. Merge through the protected branch, verify the merged source and create the immutable `v0.1.0-beta.10` tag. Wait for its verification-only release workflow.
4. Read back backup freshness and the production baseline. Promote API, wait for migration success and readiness, then promote web from the identical source.
5. Verify direct API, web and same-origin identity, current sessions, private export, anonymous denial and rendered bundle browsing. Publish the GitHub prerelease with verified assets and record the evidence.

## Migration and rollback

`0033_skill_bundles.sql` adds bundle and membership tables and Library reference columns. It does not change skill releases, artifacts or adoption records. The standard API startup applies migrations under the existing migration lock. Do not run owner seeding.

The pre-promotion production baseline is beta.9, source `4e728b16cc04f11faa7e23ad0657913b67f50577`, API `7ccb9f32-10bf-4efa-8f24-fcad805e6476`, web `d8e6fc04-d028-4579-aaaa-c69af7758394`; these values were read back before preparing the candidate and must be refreshed before production.

Before any bundle references exist, the previous API/web pair can use the additive schema. After references exist, beta.9 readers cannot safely handle them. Keep the beta.10 reader and set `MYSKILLS_BUNDLES_ENABLED=false` to return the registry to flat browsing and stop bundle writes; fix forward for a reader failure. Retain tables, audit records and recovery data. No destructive database rollback or restore is authorized.

Stop promotion on failed required checks, migration errors, incorrect source identity, missing recovery evidence or permission regressions.

## Verified release

- [PR #93](https://github.com/jremick/myskills/pull/93) merged through the protected branch. All 12 checks passed on source `084b48e4bce0e8693357f7a4f89d7aabf8ff89f4`, including both supported Node versions, browser and PostgreSQL suites, image builds and CodeQL. The merge commit is `f7daef45aa4fd8e435ca5503af402977b225154b`; its tree matches the tested source.
- Two review findings were reproduced before repair: anonymous CLI reads incorrectly required a token, and authenticated bundle audiences could accept public members while public sharing was disabled. Both regression journeys pass after the fixes, and the review threads are resolved.
- The final clean Linux canonical gate passed 1,194 repository tests, 241 PostgreSQL tests, 28 browser tests and eight full-stack journeys, with no skipped or flaky full-stack journeys. Its report and bundle persistence screenshot were retained outside tracked source. An earlier macOS run stopped at the existing native release-selector keyboard test; it is not counted as a passing canonical run.
- Immutable tag `v0.1.0-beta.10` points to the tested source. The [tagged workflow](https://github.com/jremick/myskills/actions/runs/36299367000) passed the canonical gate, application and Railway image builds, and credential-free backup-image entrypoint smokes.
- The [GitHub prerelease](https://github.com/jremick/myskills/releases/tag/v0.1.0-beta.10) contains five assets. All uploaded sizes and SHA-256 digests match the local files. The workflow's source archive, metadata and checksums match the prepared files byte for byte. Source archive SHA-256: `70b46e32665c381224d08e22e218ccf36e60fc692331e424951ec47a80be325d`. CLI archive SHA-256: `1c9bbd6bb5f56934a53db9facb5ae6298b397c78e74abd0627eb117400ccaf1d`.
- The CLI archive passed a fresh installation, version readback, example validation and scan. npm remains beta.8.

## Staging and production

Staging API `5c90c8ff-b81e-4968-8076-2cd825589e65` reached readiness before web `cd2dd483-39c1-4020-8cfc-ce08f1c900a2` deployed. Both succeeded from the tested source. Fourteen HTTP checks passed. Authenticated acceptance covered bundle creation, all three catalog views, membership reads, idempotent reference saving, retained saved revision, stale-edit rejection and private-bundle denial. Temporary staging MFA was removed, and ordinary login and logout were read back. Browser inspection confirmed the bundle inspector and outline collapse, with no console errors.

Production API `a73367e7-94c5-4f31-a6aa-917f8002e5f0` applied migrations and reached readiness before web `77cdfa45-cd97-4564-8f34-f4487edfc499` deployed. Both report `SUCCESS` and serve version beta.10 with revision `084b48e4bce0e8693357f7a4f89d7aabf8ff89f4`. No owner seeding ran.

Fourteen production HTTP checks passed across direct API, web and same-origin API, including health, readiness, revision identity, three catalog views and anonymous denial of a private artifact. The fresh CLI passed all eight doctor checks and anonymous catalog browsing. The existing owner session remained usable. Browser checks confirmed all three view controls, the private-default creation dialog and keyboard/pointer activation, with no console errors. No test bundles were created in production.

Authenticated browser export returned HTTP 200 and a 17,300-byte package with four files and the selected private release manifest. Anonymous access to that release returned 404. The native download event timed out and a newly saved file was not confirmed; verification inspected the actual browser network response without retaining its private contents.

Sampled logs contained no application faults across 67 API and 100 web entries. Railway labelled 54 nginx startup notices as errors because they used stderr; none carried an nginx error, critical, alert or emergency level.

Pre-promotion backup validation passed for capture `2026-09-26T16-00-54.119Z_525b18d1a2ca4cad`, captured at `2026-09-26T16:00:54.194Z`, with manifest SHA-256 `172c83c83d6d31cc3521d4fc97c99ab55e747a6d8aedcfce73d9bcd1fd3eb4dd`. Its age was 51,192 seconds, within the existing 26-hour policy. This is freshness and completed-manifest evidence; no new capture or restore is claimed.

## Limits

MySkills remains public beta. Bundle totals enumerate the authorized catalog in bounded database pages; large-registry performance has not been benchmarked. Source membership changes require explicit curator review. Nested bundles, adopt/install-all and automatic upstream membership changes are excluded.
