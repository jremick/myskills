# Beta.13 release delivery

Status: GitHub prerelease and production delivery verified on 28 September 2026.

## Scope

The owner authorized the MFA enrollment QR change, then push, deployment and release.
The browser renders the exact API enrollment URI with `qrcode.react` after password
verification. The manual secret and URL remain available. API behavior, six-digit
confirmation and one-time recovery-code display are unchanged. No schema migration
is included. GitHub and hosted delivery are in scope; npm remains beta.8.

## Acceptance and checks

The immutable candidate is `48273d5ff401ddcfd9046c448b1b38a58ee12337`.
[PR #103](https://github.com/jremick/myskills/pull/103) merged through protected
checks as `0f689bda9f325e5107aa2b5de25d607aecfdeb53`. The merged tree is identical
to the candidate, which is an ancestor of main.

The clean Windows-hosted Linux canonical gate passed: 1,196 repository tests,
92 mocked browser cases, eight production-like full-stack journeys, 243 Postgres
tests, CLI package smoke, dependency audit and release artifact creation.
One existing account-login browser case passed on retry in that local run.
Both supported Node versions passed all 92 mocked and eight full-stack cases
without retries in [candidate CI](https://github.com/jremick/myskills/actions/runs/36372380170)
and [merged-source CI](https://github.com/jremick/myskills/actions/runs/36372904958).
CodeQL passed on both revisions. The tagged
[Verify Release](https://github.com/jremick/myskills/actions/runs/36374114075)
workflow passed the canonical gate, all six container builds and backup image
smokes. Its 92 mocked and eight full-stack browser cases passed without retries.

Desktop and mobile tests independently decoded rendered QR pixels with `jsqr`,
checked manual fallbacks, invalid-password and code retries, persisted enabled
state, one-time recovery display, and request/console/storage privacy.

The tests failed when the QR was absent and when the payload was deliberately
changed to the bare secret. Both controls were removed before delivery. Screenshots
mask the QR, secret, setup URL, password, setup code and recovery codes. Automatic
MFA traces, videos and failure screenshots are disabled.

Earlier macOS checks passed 1,194 repository tests with two Linux-only skips.
The browser suite passed 91 of 92 cases; the release-history keyboard failure
also reproduced against unchanged application source. The clean Linux gate and
protected CI above supersede that platform-limited result for delivery.

## Publication

The [GitHub prerelease](https://github.com/jremick/myskills/releases/tag/v0.1.0-beta.13)
was published at `2026-09-28T03:49:35Z`. Tag `v0.1.0-beta.13` points to the immutable
candidate above. npm remains beta.8.
The verified CLI archive installs as `0.1.0-beta.13` and passes package validation
and scanning. All five remote assets match their local sizes and SHA-256 digests.
The tagged source archive is byte-identical to the clean local canonical artifact.

| Archive | Bytes | SHA-256 |
| --- | --- | --- |
| Source | 10,639,360 | `f9715727b8e8d685d4221392421420c840c7cb939ce344b9353d3d04cbdd6621` |
| CLI | 306,997 | `69c7a40ddad1e5dbc9addb266d5b788c7cf7c0b6c02a6c8f4f7a7617934b0980` |

## Deployment evidence

Staging and production use the candidate above. Each API reached SUCCESS and
passed direct readiness before its matching web deployment was started.

| Environment | API deployment | Web deployment |
| --- | --- | --- |
| Staging | `6cabe522-353b-462c-9a41-5c8edcf6a7c9` | `eef82722-a4fa-486e-8773-53f3d2f401ed` |
| Production | `89cc870c-a3bb-4f2f-a2b0-d1defa931a98` | `2d47a504-8b65-4d5d-b38f-2a96db71842d` |

All four report SUCCESS. Direct API, same-origin API and web version endpoints
return beta.13 and the same source revision. Each environment passed 14 identity,
health/readiness, catalog and anonymous-denial checks. Fresh CLI doctor and
anonymous catalog checks passed on the supported Node runtime.

Live Comet checks verified fresh staging login, private package inspection,
settings and logout. The existing production owner session survived reload,
rendered the selected private package's four files and SKILL.md contents, and
retained enabled MFA with an MFA-verified session. No account MFA settings changed.
The authenticated 17,300-byte private package response matched SHA-256
`946f089187f096b7f8e48828b1a0a4e139402e489e29d3fa750002f17ce4c119`;
anonymous access to that exact release returned 404. The temporary payload was
removed after recording the checksum.
HTML routes revalidated with ETags and `no-cache`, including conditional 304s;
version responses used `no-store`. Sampled production logs had no application
fault matches across 67 API and 96 web lines.

## Promotion and recovery

There is no migration or writer-coordination change. The pre-promotion production
pair is source `d8775d6b07e2de06b7af4cbdc6bee1a33455902d`, API
`49a2bc94-2db8-432f-8611-4339c2cdd124`, web
`77bf8274-c816-4095-ba14-38ad3c061f9b`. The completed recovery point from
`2026-09-27T16:01:29.347Z` passed the 26-hour freshness policy before promotion.
This was a freshness check, not a restore. Roll back to the matching API/web pair
if a material regression occurs;
retain the existing database and artifact data.

The task's disposable verification containers were removed after retaining
summaries, source artifacts and masked screenshots. Unrelated containers and the
primary checkout were preserved. Documentation-only closeout commits do not
change the immutable tag or deployed source.

## Remaining acceptance

Physical scans with 1Password, Google Authenticator and Microsoft Authenticator
have not been performed. Automated QR decoding and an independent TOTP calculation
prove the encoded URI and API confirmation path, not those clients' scan behavior.
Issue #49 remains open for that acceptance work.
