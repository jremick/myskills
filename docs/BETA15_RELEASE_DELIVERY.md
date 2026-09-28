# Beta.15 release delivery

Status: GitHub prerelease and production delivery verified on 28 September 2026.

## Scope

Saved brand text now becomes the browser tab title, including when visible text
is hidden. The saved PNG, JPEG or WebP logo becomes the favicon after successful
image decoding. Drafts and failed saves do not change tab branding. Logo removal
restores the default icons; resetting restores the original MySkills title.
Other open tabs pick up saved changes on reload.

The owner authorized implementation, push, deployment and release. This builds
on beta.14 branding controls and beta.13 authenticator QR enrollment. No API,
schema, dependency or authentication change is included. GitHub and hosted
publication are in scope; npm remains beta.8.

## Verification

Immutable source: `0415a160b56dac79900a698c8d378e7083ecd194`.
[PR #107](https://github.com/jremick/myskills/pull/107) merged through protected
checks as `ba159b506429e2a286eed4082a527b94ee6ac79b`. Its tree matches the
candidate, which is an ancestor of main.

The clean Windows-hosted Linux canonical gate passed 1,206 repository tests,
93 browser tests, eight full-stack journeys and 243 PostgreSQL tests, plus
CLI package smoke, dependency audit and source artifact creation.
[Candidate CI](https://github.com/jremick/myskills/actions/runs/36403493052)
passed on Node 22 and 24; all 101 browser/full-stack cases passed without retries
on each version. [Merged-source CI](https://github.com/jremick/myskills/actions/runs/36404354612)
and CodeQL passed. [Tagged verification](https://github.com/jremick/myskills/actions/runs/36404594880)
passed the canonical gate, all six image builds and backup-image smokes.

The extended real-API branding journey covers save during navigation, reload,
public pages, hidden text, PNG/JPEG/WebP decoding, wide logos, replacement,
removal, reset, failed saves and read outages. It fails on unchanged source at
the title assertion and with a title-only implementation at the favicon assertion.
The final implementation passes. Existing desktop/mobile QR checks remain.

## Publication

The [GitHub prerelease](https://github.com/jremick/myskills/releases/tag/v0.1.0-beta.15)
was published at `2026-09-28T09:50:52Z`. The immutable tag points to the
candidate above. All five downloaded assets match their local bytes and SHA-256
checksums. The tagged source archive is byte-identical to the canonical artifact.
The CLI archive installs as beta.15 and passes package validation and scanning.

| Archive | Bytes | SHA-256 |
| --- | --- | --- |
| Source | 10,741,760 | `edd532fa162c65aebc4015515e8b4848e06e831669130693c282729eba766b6d` |
| CLI | 307,102 | `e816a5bec0238890fc0b3143419fc5767da6f87372d60d858887b1b55f0b2d88` |

## Deployment

Each API reached SUCCESS and passed direct readiness before the matching web
upload. All four services serve beta.15 and the immutable source above.

| Environment | API deployment | Web deployment |
| --- | --- | --- |
| Staging | `9caf12a6-70f3-46d6-905d-53c11744bb33` | `9626c294-ca19-44d4-960f-a95149bf99cd` |
| Production | `f6ee1ba4-7af7-4dae-91dc-2f9e4fb97d70` | `1d62e0c0-0616-4c0a-8bf8-79c741d0cbe0` |

Staging and production each passed 19 HTTP checks for direct/proxied identity,
health, readiness, catalog views, branding, private-resource denial and HTML
revalidation. Fresh candidate CLI doctor and catalog checks passed on each.
Staging passed fresh owner login, library/architecture reads, package delivery
and logout. The Codex browser rendered sign-in, registry and package contents
with the default MySkills title and four default icon links.

Production's existing owner session survived reload and retained MFA verification.
The private package rendered its four files and SKILL.md contents. The browser
title now matches the saved custom brand text. The existing branding
record was preserved: visible text and no custom logo. The default favicon
therefore remains. No live branding or MFA settings were changed for testing;
saved custom-image behavior was verified through the isolated real-API journey.
The sampled 125 API and 117 web log lines contained no application fault matches;
54 web lines were normal nginx startup notices written to stderr.
The three task-owned disposable containers were removed after evidence retention.

Railway initially rejected the staging web source snapshot. Remote readback
confirmed FAILED before one successful retry; production uses the verified pair
above. Documentation-only closeout commits do not change the tag or deployment.

## Recovery and limits

Rollback uses beta.14 source `5647be19f15a8f9bb2c6b0ecfb067478b7528ed0`, API
`2ced5023-8288-4864-b9c5-87b550cb7362` and web
`be0c3cc6-037e-4e91-813f-b1347745d678`. Retain database, artifact and branding
data. No migration or reseeding is required. The completed recovery point from
`2026-09-27T16:01:29.347Z` passed the 26-hour freshness policy before promotion;
no restore is claimed.

New documents start with the static default title/icons until saved branding
loads. Read/decode failures retain defaults. Browser/bookmark caches can retain
older icons. Social metadata, Apple touch icons, installed-app manifests, email
and CLI/MCP identity are unchanged. Physical authenticator scans remain tracked
in [issue #49](https://github.com/jremick/myskills/issues/49).
