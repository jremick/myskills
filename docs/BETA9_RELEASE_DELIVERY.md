# Beta.9 release delivery

Status: GitHub prerelease published and production promotion verified on
27 September 2026. npm publication is outside this release.

## Scope

The owner authorized pushing the approved homepage implementation to GitHub,
updating the release and deploying myskills.sh on 27 September 2026. Scope is the
responsive marketing homepage and optional instance-wide landing setting.
App-wide styling and email/outbox work run in separate project chats.

The setting defaults on. Owners and administrators with MFA can save it off,
which sends root visitors to login. Public registry access, existing authentication
flows and package access remain independent. The existing instance_settings table
holds the boolean; setting and audit writes are atomic. No migration is required.

## Initial local verification

The implementation passed the repository check (1,189 passed, two skipped),
all 198 web tests and focused Postgres setting/audit rollback checks. Real local
browser journeys covered responsive layouts, keyboard controls, save/discard,
failed audit rollback, denied non-MFA editing, disabled routing and loading errors.
Opus 5.5 reviewed the design through the personal Claude subscription; runtime
records confirmed xhigh effort. Its final admin-header finding was corrected
and verified at desktop and 390px widths.

The wider local Postgres run had 235 passes, four failures and one cancellation
in notification-outbox tests. The original HEAD store reproduced the same class
of empty-claim/timing failures. That local run was not a passing release gate.
The required CI and clean Linux canonical gates subsequently passed as recorded
below. The dedicated email/outbox chat owns the timing diagnosis and repair;
its changes are not included in beta.9.

## Delivery and recovery

Use an immutable candidate on protected main, pass required CI and the canonical
`npm run release:verify`, then verify it on dedicated Railway staging. Deploy the
API and await readiness before the web app. Compare direct API, web and proxy
version responses with the exact candidate and perform rendered browser checks.

Verify a current database-and-artifact recovery point before production. The
beta.8 rollback source is 55849876639fbb55167496051bd8d573b5a6a6af; production API
fca21294-e5ee-414f-91b8-cc612e4e6203 and web
a53c83e5-33e3-45b4-98f2-b8d8828b221a are the pre-promotion pair. The beta.9
setting row is ignored by beta.8. Retain all beta.8 Libraries security guards;
no data restore or downgrade below beta.8 is part of this rollout.

Create a new immutable v0.1.0-beta.9 tag and GitHub prerelease only after the
documented gates. Do not move beta.8. npm publication is not part of this website
release; its beta selector remains beta.8.

## Verified candidate and staging

- Source/tag: `4e728b16cc04f11faa7e23ad0657913b67f50577`, `v0.1.0-beta.9`.
  [PR #90](https://github.com/jremick/myskills/pull/90) merged as
  `10fad8c1c25f494fad74a201b9c62e9a8bb6ba5d`; the merged tree matched the candidate.
- All 12 PR checks passed. [Main CI](https://github.com/jremick/myskills/actions/runs/36287819756)
  also passed on the merge commit.
- The clean Windows-hosted Linux canonical gate passed 1,191 repository tests,
  20 browser journeys, seven full-stack journeys and all 240 PostgreSQL tests.
  None were skipped. The earlier macOS outbox failures remain valid observations,
  but did not reproduce in these Linux or GitHub candidate checks.
- Staging API `8bde08a3-bb4d-4314-bed7-ea6a334d8da4` was ready before web
  `e7ae4f4a-777b-4bc5-9245-001b4e02a3f0` deployed. Direct API, web and proxy
  version responses matched the candidate. Readiness, default setting, health
  and HTML cache checks passed.
- Native Codex browser checks confirmed the new homepage, disabled root routing
  to login without public-site links, and continued anonymous registry access.
  The existing staging owner completed temporary MFA to write the setting;
  the original enabled value was restored, temporary MFA was removed, and all
  supplied sessions were cleaned up with zero failures. No external email was sent.
- Source archive SHA-256 is
  `5fc5a8766424596a4cf75f9cfc3aad612cd80e9e123b40396f3c74adcadba10a`.
  Tag-enforced artifact generation produced the same source bytes.
- CLI archive SHA-256 is
  `4070a093358ac24f610fdd3ba9b13a88d3acd169d75dac4f742f34b7dc352146`.
  A fresh installation of that exact archive reported beta.9 and passed package
  validation and scan. This is GitHub archive evidence, not npm publication.

## Published release and production

- [Tagged release workflow](https://github.com/jremick/myskills/actions/runs/36288168999)
  passed the canonical gate, API/MCP/web/Railway image builds and backup image
  build with credential-free entrypoint smoke checks.
- [GitHub prerelease](https://github.com/jremick/myskills/releases/tag/v0.1.0-beta.9)
  is published. All five uploaded assets matched their local byte sizes and
  SHA-256 digests: source archive, CLI archive, metadata and both checksum files.
- Production API `7ccb9f32-10bf-4efa-8f24-fcad805e6476` reached readiness before
  web `d8e6fc04-d028-4579-aaaa-c69af7758394` deployed. Both report `SUCCESS` and
  use source `4e728b16cc04f11faa7e23ad0657913b67f50577`.
- Eleven HTTP checks passed across direct API, web, same-origin API and www:
  version/revision identity, readiness, health, enabled landing setting and
  cache behavior. Fresh installed beta.9 CLI `doctor` passed all eight checks
  against production.
- Native Codex browser checks confirmed the new homepage, the checked admin
  setting and the existing owner/MFA session after reload. Authenticated export
  saved a 17,300-byte private bundle with four files and the selected manifest.
  Anonymous access to that exact bundle returned 404. The browser download-event
  wait timed out; completion was verified from the newly saved native file.
  No production setting, credential or access policy was changed.
- The production homepage was captured at 1440 × 900 and visually inspected.
  No browser console warnings or errors were recorded. Sampled deployment logs
  contained zero application errors across 45 API and 86 web entries.
- Pre-promotion backup validation passed for capture
  `2026-09-26T16-00-54.119Z_525b18d1a2ca4cad`, captured at
  `2026-09-26T16:00:54.194Z`. Its manifest SHA-256 was
  `172c83c83d6d31cc3521d4fc97c99ab55e747a6d8aedcfce73d9bcd1fd3eb4dd`.
  Its age was 38,002 seconds, within the existing 26-hour policy. Redeploying
  the existing backup image left the scheduled job cron-ready; it did not
  produce a new capture. No restore was performed.

## Remaining boundaries

Hosted registration remains owner-controlled, and MySkills remains public-beta
software. npm `beta` still resolves to beta.8. The separate email/outbox fix and
app-wide design framework are not part of this release. Local screenshots,
private exports and operational logs are retained outside tracked source.
