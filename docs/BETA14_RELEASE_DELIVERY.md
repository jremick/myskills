# Beta.14 release delivery

Status: GitHub prerelease and production delivery verified on 28 September 2026.

## Scope

The owner authorized branding implementation, then push, deployment and release
alongside QR enrollment. QR enrollment was already released as beta.13, so this
candidate builds on that release without changing its immutable tag or assets.
GitHub and hosted delivery are in scope; npm remains beta.8.

MFA-verified owners and admins can change the logo and brand text in Admin →
Branding. The shared identity covers landing, authentication and application
pages on desktop and mobile. PNG, JPEG and WebP files are limited to 256 KB and
2048 × 2048 pixels. Preview, save, discard, removal and reset are available.
Settings and audit events commit together in the existing instance-settings
store. No schema migration, new dependency or external image service is required.

## Acceptance and checks

The immutable candidate is `5647be19f15a8f9bb2c6b0ecfb067478b7528ed0`.
[PR #105](https://github.com/jremick/myskills/pull/105) merged through protected
checks as `1dff0c2c65af3f72a62c2b92bffd024e28b4fa6b`. The merged tree is identical
to the candidate, which is an ancestor of main.

The clean Windows-hosted Linux canonical gate passed: 1,206 repository tests,
93 browser cases, eight production-like full-stack journeys, 243 Postgres tests,
CLI package smoke, dependency audit and release artifact creation. All browser
cases passed without retries. Both supported Node versions passed all 93 browser
and eight full-stack cases without retries in
[candidate CI](https://github.com/jremick/myskills/actions/runs/36381807882).
[Merged-source CI](https://github.com/jremick/myskills/actions/runs/36382800648)
and CodeQL passed. The tagged
[Verify Release](https://github.com/jremick/myskills/actions/runs/36383434067)
workflow passed the canonical gate, all six container builds and backup image
smokes.

The branding browser journey uses real API handlers and PostgreSQL. It covers
save/reload, public pages, save during navigation, failed-save draft retention,
invalid uploads, hidden text, wide images and long text, mobile save, keyboard
reset and unchanged landing-page settings. Existing desktop and mobile QR tests
remain in the same release gate.

An initial integration run found that the QR browser fixture rejected the new
public branding read. Its explicit fixture was updated to return default branding;
QR assertions were retained. All final-candidate checks above ran after that fix.
Earlier macOS browser results had a release-history keyboard failure that also
occurred on unchanged source. The clean Linux gate supersedes that result.

## Publication

The [GitHub prerelease](https://github.com/jremick/myskills/releases/tag/v0.1.0-beta.14)
was published at `2026-09-28T06:02:41Z`. Tag `v0.1.0-beta.14` points to the immutable
candidate above. npm remains beta.8. The CLI archive installs as beta.14 and passes
package validation and scanning. All five downloaded release assets match their
local byte sizes and SHA-256 digests. The tagged source archive is byte-identical
to the clean canonical artifact.

| Archive | Bytes | SHA-256 |
| --- | --- | --- |
| Source | 10,731,520 | `605f003a57a5b14dec43296e42698320f86e3742b355cf1d1b4cbba24d885130` |
| CLI | 307,105 | `e2d3dcc88b71c09bd32e8b26b9e5bf2ab417b190f5100997583bec8fd24ea2a1` |

## Deployment evidence

Staging and production use the immutable candidate above. Each API reached
SUCCESS and passed direct readiness before its matching web deployment started.

| Environment | API deployment | Web deployment |
| --- | --- | --- |
| Staging | `04ce1ef7-dfa9-4196-a7d4-c4a3d3e02340` | `7a449630-fd97-4ad1-befb-5dacb63084ee` |
| Production | `2ced5023-8288-4864-b9c5-87b550cb7362` | `be0c3cc6-037e-4e91-813f-b1347745d678` |

All four report SUCCESS. Direct API, same-origin API and web version endpoints
return beta.14 and the same source revision. Each environment passed 19 HTTP
checks covering identity, health/readiness, catalog views, branding reads,
anonymous denial and HTML revalidation. Fresh CLI doctor and anonymous bundle
catalog checks passed using the candidate's built CLI.

Staging passed fresh owner login, library and architecture reads, private package
delivery and logout. Codex browser checks rendered staging sign-in, the public
registry and package contents. The production Comet owner session survived reload,
retained MFA verification and rendered the private package's four files and
SKILL.md contents. No new production package-byte checksum is claimed.

The deployed Branding panel rendered the uploaded blue PNG and edited text in
its unsaved preview. Discard restored the defaults, and a public API read confirmed
`MySkills`, visible text and no custom logo remained saved. No live branding or
MFA settings were changed; save/persistence checks used the isolated real API and
Postgres journey. Sampled production logs contained no application fault matches
across 83 API and 111 web lines.

## Promotion and recovery

The pre-promotion production pair is beta.13 source
`48273d5ff401ddcfd9046c448b1b38a58ee12337`, API
`89cc870c-a3bb-4f2f-a2b0-d1defa931a98`, web
`2d47a504-8b65-4d5d-b38f-2a96db71842d`. The completed recovery point from
`2026-09-27T16:01:29.347Z` passed the 26-hour freshness policy before promotion.
This was a freshness check, not a restore.
Rollback uses that matching API/web pair, retaining database and artifact data.
The older app ignores the new branding row. Do not reseed or restore the database
for an application rollback. No writer-coordination change is required.

The task's four disposable verification containers were removed after retaining
logs, reports and artifacts. The primary checkout and unrelated containers were
preserved. Documentation-only closeout commits do not change the immutable tag
or deployed source.

## Remaining limitations

Branding does not change favicons, browser titles, email content, package names,
CLI/MCP identity or marketing copy. A public branding read failure retains the
built-in identity and leaves the app usable. See [branding](BRANDING.md).
Physical scans of beta.13 QR enrollment with authenticator apps remain tracked
in issue #49; automated QR decoding is distinct from those client checks.
