# Compatibility

Version: 0.1.0-alpha.0
Last updated: 2026-06-30

This document states the expected support surface for the public beta track. MySkills is still prerelease software, so compatibility is narrower than a stable `v1.0` release.

## Supported Development Environment

- Node.js 20.x.
- npm from the repo-declared `packageManager` field.
- macOS and Linux developer environments.
- Docker or an equivalent local Postgres/object-storage setup for full local development.

Windows may work through WSL2, but it is not part of the beta verification matrix yet.

## Runtime Services

The self-hosted application expects:

- Postgres 17 for the documented local and CI path.
- S3-compatible object storage for production package artifacts.
- HTTPS reverse proxy in front of web/API services for production-like deployment.
- SMTP or Resend for production auth notifications.

Local development may use Docker Compose for Postgres, MinIO, API, web, and MCP HTTP services.

## Public Interfaces

Beta compatibility covers these surfaces on a best-effort prerelease basis:

- HTTP API routes documented or used by the web, CLI, and MCP adapters.
- Skill package manifests accepted by `packages/skill-package`.
- CLI commands documented in `README.md` and `docs/API_MCP_CLI_PLAN.md`.
- Stdio and stateless Streamable HTTP MCP discovery/install-guidance tools.
- Database migrations applied from this repository in order.

## Known Unsupported Cases

- Business-critical production operation.
- Multi-region or multi-tenant hosted-service guarantees.
- Provider login/linking beyond the currently implemented provider metadata and mapping administration.
- Browser/device-code CLI login.
- Platform-specific install adapters beyond the current filesystem install/export flow.
- Backward-compatible migration from every prerelease database shape.
- Unsupported MCP clients or custom transports not covered by the current stdio/HTTP adapters.

## Version Expectations

- `0.x` releases may include breaking changes.
- Alpha releases are for inspection, demos, and early self-hosting feedback.
- Beta releases are intended for real external trial use with documented support boundaries.
- Stable compatibility guarantees will be defined before `v1.0`.

When a breaking prerelease change is known, it should be listed in [CHANGELOG.md](../CHANGELOG.md) or the release notes.
