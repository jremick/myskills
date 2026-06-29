# Public Beta Release Goal

Version: 0.1.0-beta.0
Last updated: 2026-06-30

## Goal

Ship MySkills as a public beta that real external users can install, inspect, self-host experimentally, and evaluate with clear support, security, compatibility, and upgrade expectations.

The beta is still prerelease software. It is not the final business-safe production release.

Target release: `v0.1.0-beta.0`.

## Beta Gate

Before tagging a public beta:

- Worktree is clean and synced with `origin/main`.
- GitHub CI is green on `main`.
- `main` is protected by required CI checks.
- Secret scanning, push protection, Dependabot security updates, and private vulnerability reporting are enabled where available.
- `npm run check` passes.
- `TEST_DATABASE_URL=... npm run test:postgres` passes against a disposable database.
- Fresh clone rehearsal passes: install, build/check, migrate, seed, local API/web smoke, example validate/scan, CLI package smoke, and release artifact generation.
- `npm run release:artifacts` succeeds from a clean checkout.
- `CHANGELOG.md`, `SUPPORT.md`, `CONTRIBUTING.md`, `SECURITY.md`, [COMPATIBILITY.md](COMPATIBILITY.md), and [UPGRADE_POLICY.md](UPGRADE_POLICY.md) describe beta expectations.
- Issue templates and PR template exist.
- Open PRs that are superseded, stale, or security-relevant are closed, merged, or documented before release.
- Release notes clearly state beta status, known limitations, install path, upgrade expectations, and security reporting path.

## Known Beta Limitations

- Provider login/linking is not a complete external identity lifecycle yet.
- Background package scan jobs and durable eval runs are still production-hardening work.
- Browser/device-code CLI login is not implemented yet.
- Platform-specific install adapters are not complete.
- Backup/restore and production incident-response runbooks are not fully rehearsed.
- Container image publishing and npm trusted publishing are not final.

## Release Candidate Checks

```bash
npm run check
TEST_DATABASE_URL=postgres://myskills_test:myskills_test@localhost:5432/myskills_test npm run test:postgres
npm run release:artifacts
```

Production preflight:

```bash
npm run check:prod-env -- --env-file .env.production
```

Do not print or commit real production env values while running the preflight.
