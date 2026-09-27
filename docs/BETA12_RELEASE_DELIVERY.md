# Beta.12 release delivery

Status: candidate preparation. No beta.12 deployment or release is claimed by this record.

## Approved scope

The owner authorized all four Opus-led redesign waves through push, deployment and release. The hosted application and GitHub prerelease are in scope. npm remains beta.8; the candidate CLI archive is still built and verified.

The work brings the approved Libraries design across Registry and mobile navigation; Submit, Review and Manage; Architectures, Connected targets and Updates; and Teams, Organizations, Admin, Settings and sign-in. Exact-release selection, artifact hashes, authorization, MFA, API requests, target consent and mutation boundaries remain intact. No schema or dependency changes are included.

Opus 5.5 leads design and implementation through the personal Claude subscription, with xhigh effort recorded in runtime evidence. Codex owns integration, browser and repository verification, publication and deployed readbacks. Four-width before/after captures use synthetic fixtures. They are visual evidence, not proof of deployed state.

## Verification and promotion

1. Complete all wave acceptance scenarios and resolve material visual findings.
2. Select one immutable beta.12 source. Pass the clean canonical `npm run release:verify` gate and protected-branch checks, retaining reports and release artifacts.
3. Deploy that source to staging API, wait for readiness, then deploy staging web. Verify exact identities and representative authenticated browser workflows, including export and anonymous denial.
4. Merge through the protected branch, confirm the tested source is included, create the immutable tag and pass its verification-only workflow.
5. Read back a completed backup within the existing 26-hour policy. Promote production API and wait for readiness before promoting web from the same source.
6. Verify API, web and same-origin identities, current sessions, rendered workflows and exact private export with anonymous denial. Publish the GitHub prerelease with verified asset checksums and record deployment IDs and evidence.

## Migration, rollback and stop conditions

No new migration is required. Retain the bundle-aware beta.10 schema and readers. The baseline is `v0.1.0-beta.10`, source `084b48e4bce0e8693357f7a4f89d7aabf8ff89f4`; refresh actual deployment IDs before promotion.

For a material runtime regression, redeploy the previous API, verify readiness, then redeploy its matching web source. Do not downgrade the database, remove bundle references, reseed the owner or change production credentials. No destructive restore is authorized.

Stop promotion on failed required checks, incorrect source identity, migration errors, missing recovery evidence, permission regressions or material visual defects. Record open limitations without substituting local-source results for deployed proof.

## Candidate supersession

Beta.11 stopped at tagged verification because an Admin browser test began its
keyboard assertion before the confirmation dialog closed and restored focus.
Beta.12 waits for those visible results before testing the End key. Application
source and the Opus-approved design are unchanged. The immutable beta.11 tag is
retained; its incomplete delivery is recorded in
[Beta.11 release delivery](BETA11_RELEASE_DELIVERY.md).
