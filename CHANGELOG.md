# Changelog

All notable user-facing changes will be tracked here. MySkills is still prerelease software; breaking changes may happen between beta releases and will be called out in this file.

## Unreleased

No unreleased changes yet.

## 0.1.0-beta.1 - 2026-06-30

### Fixed

- Updated hosted web, support, security, and contribution copy from public-alpha wording to public-beta wording while keeping hosted signups owner-gated.

## 0.1.0-beta.0 - 2026-06-30

### Added

- Public beta readiness docs for support, contribution, compatibility, and upgrade expectations.
- GitHub issue and pull request templates for public triage.
- Dependabot configuration for npm, GitHub Actions, and Docker manifests.
- Refreshed beta web console UI and design-system components.

### Fixed

- Demo seed data now publishes and repairs `release-notes-helper@0.1.0` so it is visible through public registry reads after `db:seed`.
- SMTP auth notifications disable Nodemailer file and URL access for generated messages.

### Security

- Updated Nodemailer to the patched `9.0.1` line.

## 0.1.0-alpha.3

### Added

- Published the `@jarel/myskills` CLI alpha package with local-first API URL config, keyring-backed credential storage, auth status, doctor diagnostics, and registry workflow commands.

## 0.1.0-alpha.0

### Added

- Initial public alpha repository with API, web, CLI, MCP, package validation/scanning, Postgres migrations, Docker Compose dependencies, release artifact generation, and a public-safe example skill package.
