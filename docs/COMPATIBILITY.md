# Compatibility

Version: 0.1.0-beta.4
Last updated: 2026-07-13

This is the supported public-beta evaluation surface. MySkills remains prerelease software, so compatibility is intentionally narrower than a stable `v1.0` contract.

## Development And CLI Runtime

- Node.js `>=22.13 <23 || >=24 <25` (Node 22 and Node 24 LTS lines only).
- The exact npm version in the root `packageManager` field. CI installs this version before `npm ci`.
- macOS and Linux developer environments.
- Docker with Compose for the documented Postgres 17 and MinIO dependency path.

CI runs the repo gate on Node 22 and 24, while browser/Postgres/release jobs use Node 22 LTS. Node 20 is EOL and unsupported. Odd-numbered/EOL Node releases are outside the beta matrix. Windows may work through WSL2 but is not currently verified.

The published CLI uses the same Node range. Its bundle is self-contained except for the public optional keyring runtime dependency; no private `@myskills-app/*` package is required after installation.

## Runtime Services

The documented self-hosted path expects:

- Postgres 17 for local, CI, and production examples.
- S3-compatible object storage for production artifact bytes.
- HTTPS reverse proxy in front of web/API services for authenticated production-like browser use.
- SMTP or Resend for production auth notifications.

The root Dockerfile builds with and runs API/MCP on Node 22 LTS. The web target serves Vite output through nginx. Local development uses Docker only for Postgres/MinIO dependencies and runs app processes through npm.

## Public Interfaces

Beta compatibility is best-effort across:

- implemented HTTP routes used by the web, CLI, and MCP adapters;
- skill manifests accepted by `packages/skill-package`;
- documented `myskills` CLI commands;
- stdio and stateless Streamable HTTP MCP discovery/install-guidance tools;
- ordered Postgres migrations shipped in this repository;
- root `.env.example` keys used by the canonical local setup.

Within one beta tag, API capability version, root/workspace versions, CLI version, changelog target, and release tag must agree. Breaking prerelease changes must be called out in [CHANGELOG](../CHANGELOG.md) and release notes.

## Unsupported Or Planned

- Business-critical production operation or support/SLA guarantees.
- Multi-region hosted operation.
- General hosted signup; the maintained live instance remains owner-controlled.
- Provider login/linking beyond non-secret provider metadata and role-mapping administration.
- Browser/device-code CLI login.
- Platform-specific install adapters beyond filesystem install/export.
- Background scan/eval workers and durable eval evidence.
- Backward-compatible migration from every historical prerelease database shape.
- Production backup/restore and incident-response coverage.
- MCP clients/transports outside the tested stdio and Streamable HTTP paths.

## Version Expectations

- `0.x` releases may make breaking API, CLI, manifest, config, and schema changes.
- Beta releases are intended for external trial use with documented limitations, not stable production dependence.
- Migrations are forward-only unless a release explicitly documents a tested alternative.
- Stable compatibility/deprecation guarantees will be defined before `v1.0`.

See [Upgrade Policy](UPGRADE_POLICY.md), [Getting Started](GETTING_STARTED.md), and [Release Process](RELEASE.md).
