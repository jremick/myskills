# Beta.10 release delivery

Status: candidate preparation on 27 September 2026. No publication or production promotion is claimed by this preparation record.

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

Codex owns promotion and post-deploy smoke checks. Stop promotion on failed required checks, migration errors, incorrect source identity, missing recovery evidence or permission regressions.

## Limits

MySkills remains public beta. Bundle totals enumerate the authorized catalog in bounded database pages; large-registry performance has not been benchmarked. Source membership changes require explicit curator review. Nested bundles, adopt/install-all and automatic upstream membership changes are excluded.
