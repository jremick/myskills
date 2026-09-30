# Beta.17 release delivery

Published on GitHub: 29 September 2026. Publication and hosted-state
reconciliation: 30 September 2026. npm remains beta.16; no hosted beta.17
deployment is claimed.

## Scope and immutable source

Tag `v0.1.0-beta.17` points to
`9c0511e90a4c0b2fe7c54c4e5f11a1b320e8db7b`.

The release includes:

- One Skills workspace for browsing and management, preserving the selected
  skill and exact version across All skills / Can manage and Overview /
  Versions / Manage.
- Library references selected through skill and release pickers, with exact
  entry/source-candidate links, reload and browser-history behavior.
- Authorized management views for archived and unpublished skills; archived
  parent skills are excluded from Library adoption choices.
- A full-page architecture Workbench with canvas/outline views, draft
  protection, and Overview, Skills, History and Access tabs.
- GitHub source authentication and retry scheduling, plus team-owned Library
  sourcing and tracking.

The [published release notes](https://github.com/jremick/myskills/releases/tag/v0.1.0-beta.17)
are the source for this scope. Later CLI/MCP capability parity, real
ChatGPT/Claude acceptance, tracked Collections, Group membership and local-CI
parallel execution remain work in progress; this record does not claim their
delivery.

## Verification

GitHub readback on 30 September confirms completed, successful workflows on
the exact tagged source:

| Gate | Recorded result |
| --- | --- |
| [Required CI](https://github.com/jremick/myskills/actions/runs/36499630550) | Check, PostgreSQL and Web E2E passed on Node 22 and 24; Railway image checks and required aggregate contexts passed. |
| [CodeQL](https://github.com/jremick/myskills/actions/runs/36499630681) | Passed. |
| [Tagged release verification](https://github.com/jremick/myskills/actions/runs/36500696530) | Canonical release verification and image builds passed. |

These are the recorded release checks, not new test runs. The published notes
record that downloaded source, metadata and checksums matched the canonical
workflow artifacts.

## Artifacts and publication

The [GitHub prerelease](https://github.com/jremick/myskills/releases/tag/v0.1.0-beta.17)
was published at `2026-09-29T00:21:04Z`. It is not a draft. All five assets were
downloaded again on 30 September; the source archive and metadata match
`SHA256SUMS`, and the CLI archive matches `CLI_SHA256SUMS`. The release metadata
records the tag, version and immutable source above, with `dirty: false`.

| Asset | Bytes | SHA-256 |
| --- | --- | --- |
| `myskills-app-0.1.0-beta.17-source.tar` | 11,724,800 | `46a2c58ce2a48bf39e952bf2f899f4e63f28be61591940eb3a48afc0496a204c` |
| `jarel-myskills-0.1.0-beta.17.tgz` | 325,804 | `45e2979d59106e28a765e528c0bbc74b717c6f31990400b44d48c4e233b15d67` |
| `release-metadata.json` | 532 | `1fcd7404e5cd6f964b08f4f740d11e131f2e80c9935ed5982886430273113acd` |
| `SHA256SUMS` | 192 | `fbff69ddbb85b02db2ba4416bee380d3375203d53da165f770d8d4bb5879e46d` |
| `CLI_SHA256SUMS` | 99 | `13a2de5c2877031531ba52ad6fff6313fcf367a7c517ecbafddb0d598356835c` |

npm publication was intentionally excluded. Registry readback on 30 September
returns `beta: 0.1.0-beta.16`, `latest: 0.1.0-alpha.3` and
`alpha: 0.1.0-alpha.3`. The beta.17 CLI archive is a GitHub release asset.

## Hosted state and operator upgrade

On 30 September, the public [version endpoint](https://myskills.sh/version.json)
reports beta.16 at `acfb7c8c7f8bc560f6fdba13cf0414033ab6d00e`. The corresponding
Railway pair is API `96e7dc80-b1c4-43ad-a9c1-6d8465f55b30` and web
`ca6d4399-0cae-4f72-af9e-943ef43ebfc5`, consistent with
[Beta.16 release delivery](BETA16_RELEASE_DELIVERY.md). Existing beta.16
acceptance does not prove beta.17 deployment. Other independently operated
instances were not verified in this reconciliation.

GitHub publication does not update an instance automatically. Operators must
back up the database and artifact storage, retain existing configuration, run
forward migrations, and upgrade API and web together. Since beta.16 this adds:

- `0034_github_integration.sql`
- `0034_team_library_ownership.sql`
- `0035_github_source_cooldown.sql`

Configure GitHub integration as described in the
[tagged integration guide](https://github.com/jremick/myskills/blob/v0.1.0-beta.17/docs/GITHUB_INTEGRATION.md).
Use the [Railway deployment runbook](RAILWAY_DEPLOYMENT.md) for deployment and
live acceptance. A successful source gate or image build is not runtime proof.
