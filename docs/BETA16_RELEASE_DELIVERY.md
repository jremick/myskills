# Beta.16 release delivery

Released: 29 September 2026. Canonical verification, GitHub/npm publication,
staging acceptance, and production acceptance are complete.

## Scope and immutable source

Beta.16 adds separate CLI configuration profiles, read-only global/project
inventories for Codex and Claude, scope ownership/exclusions, explicit legacy
root acknowledgment, and guided browser onboarding. Managed Codex workspaces
remain the only installation/update writer. Native provider inheritance is unchanged.

Frozen candidate and tag `v0.1.0-beta.16`:
`acfb7c8c7f8bc560f6fdba13cf0414033ab6d00e`.
[PR #114](https://github.com/jremick/myskills/pull/114) merged as
`128850058b5939fa34e39e602eb2dbe9546db89a` through integration head
`12f1952778de7a876ec21b5b4941879b212a695f`.
Integration includes PR #116 GitHub authentication changes. Main later advanced
with PR #117 team Library changes. The frozen beta.16 release excludes both.

## Verification

[Candidate CI](https://github.com/jremick/myskills/actions/runs/36493093833),
[candidate CodeQL](https://github.com/jremick/myskills/actions/runs/36493093813),
[integration CI](https://github.com/jremick/myskills/actions/runs/36494128479),
and [merged-main CI](https://github.com/jremick/myskills/actions/runs/36494948297)
passed. These are separate source identities; integration success does not
change the frozen release content.

The Windows-hosted Linux canonical gate used Node 24.20 and npm 11.12.1:
1,220 repository tests, 107 mocked browser cases, eight full-stack journeys,
and 246 PostgreSQL tests passed, plus CLI package smoke and release artifacts.
One branding browser case passed on retry. Forced architecture-retry evidence
records seven passes and one controlled case that passed on retry.

Scope coverage passed 8/8; configuration profiles passed five journeys. The
PostgreSQL workflow used two users and a separate reviewer, with 20 denial checks.
An actual macOS beta.8-to-candidate archive upgrade preserved default config,
native Keychain session, scope bytes, and target IDs. A named profile could not
reuse default credentials. Explicit legacy acknowledgment of two active global
roots preserved target IDs, generation, and consent, with exact-byte private
backups. Local-file fingerprints matched before and after the checks.
Subsequent Codex and Claude observation uploads succeeded. They legitimately
refreshed cached target update timestamps; post-upload scope bytes are not
claimed identical. Remote observation digests matched and target IDs/generations
were preserved. Structural comparison confirmed only cached update timestamps
changed. Both inventories remain incomplete; accepted upload is not completeness.
Production CLI doctor passed all nine checks with the existing MFA-verified
Keychain session at `2026-09-28T23:19Z`.

## Artifacts and publication

All five downloaded GitHub release assets match local bytes and checksums.
Tagged workflow metadata identifies the frozen source; its source archive
matches the canonical archive byte-for-byte.

| Archive | Bytes | SHA-256 |
| --- | --- | --- |
| Source | 11,089,920 | `c1b0bf6126e32a47cebc09e0943a8d6688e844ee22099e6fce39e4d31e0968af` |
| CLI | 325,804 | `dcca9c0d31aa8a87ec2ee030b6a7d54af9ec279e95421e05b56144e10562a3b1` |

- [Tagged workflow](https://github.com/jremick/myskills/actions/runs/36495005150): completed successfully on the frozen candidate. Downloaded metadata, source archive, and checksums were verified; source matches the canonical artifact.
- [GitHub prerelease](https://github.com/jremick/myskills/releases/tag/v0.1.0-beta.16): published `2026-09-28T23:15:46Z`; tag and all five downloaded assets verified.
- npm: registry version `0.1.0-beta.16` and beta selector verified. Registry tarball bytes, SHA-1, and SHA-512 integrity match the candidate. Fresh-cache exact-version and beta-selector installs passed validation and scanning. Latest and alpha remain `0.1.0-alpha.3`. This registry smoke used Node 24.21 and npm 11.19.1, separately from the canonical gate.

## Production acceptance

API `96e7dc80-b1c4-43ad-a9c1-6d8465f55b30` and web
`ca6d4399-0cae-4f72-af9e-943ef43ebfc5` report SUCCESS, beta.16, and the frozen
candidate. API readiness includes observation privacy. All 21 HTTP checks passed,
including same-origin identity, anonymous denial, and HTML revalidation.
The log sample covered 73 API and 80 web lines with zero fault matches;
54 web lines were nginx notices. No failed deployment was reported.
Desktop browser acceptance at 1280 × 900 preserved the existing owner/MFA session.
Both global inventories showed incomplete status and bounded findings. Claude
global/project setup commands included the work profile and quoted paths. The
existing private exact release showed its Approved/Passed status, export command,
and four-file text preview. No browser error was sampled; no application data was
changed by these browser checks.

## Staging acceptance

API `70461dc1-e6b7-4146-9633-07bc5ccdb73f` and web
`88d64e2b-ad6e-403a-a38c-5998dfc4b7d1` were accepted for the candidate.
Evidence includes 21 HTTP checks; owner login, private package access, and
logout; and public browser catalog/detail rendering. The log sample covered
79 API and 103 web lines with zero fault matches; 54 were nginx notices.
Staging acceptance does not establish production delivery.

## Recovery and limits

Retain migration `0034_observation_slug_privacy`; do not rewrite applied history.
Use forward migrations and a tested forward fix. A completed backup captured at
`2026-09-28T16:02:16.488Z` passed the 26-hour freshness policy. No restore is claimed.
Device-plus-inode checks do not prove against same-device inode reuse.

The work pilot uses a separate future work-hosted instance and macOS clients
with Codex and Claude Code. Work infrastructure setup has not been completed.
Global/Claude targets are inventory-only; provider runtime recognition remains
separate evidence. Project de-scoping changes MySkills ownership only.
