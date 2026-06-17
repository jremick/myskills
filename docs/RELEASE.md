# Release Process

Version: 0.1.0-alpha.0
Last updated: 2026-06-17

This repo is prepared for a responsible public alpha once the checklist in [ALPHA_RELEASE_GOAL.md](ALPHA_RELEASE_GOAL.md) passes. Alpha releases are for evaluation and early self-hosting feedback, not business-critical production use.

## Release Gates

Before creating a release tag:

- Confirm `package.json` has the intended version.
- Confirm the worktree is clean.
- Run `npm run check`.
- Run `npm run test:postgres` against a disposable Postgres database.
- Run `npm run release:artifacts`.
- Review the generated `dist/release/release-metadata.json` and `dist/release/SHA256SUMS`.
- Confirm public docs and examples contain no private-source carryover.
- Confirm GitHub private vulnerability reporting is enabled before announcing the public alpha or pushing the public alpha tag.

## Local Artifact Build

```bash
npm run check
TEST_DATABASE_URL=postgres://myskills_test:myskills_test@localhost:5432/myskills_test npm run test:postgres
npm run release:artifacts
```

The artifact script writes:

- `myskills-app-<version>-source.tar`: source archive created from `HEAD`.
- `release-metadata.json`: package name, version, expected tag, commit SHA, commit time, Node/npm metadata, and artifact sizes/checksums.
- `SHA256SUMS`: checksums for the source archive and metadata file.

By default the script refuses to run on a dirty worktree. It also only writes inside a non-hidden `dist/` subdirectory so release artifact generation cannot clean source-controlled paths. Use `--allow-dirty` only for local script testing, because dirty files are not included in the source archive.

## Tagging

Create the release tag only after the gates pass:

```bash
VERSION=$(node -p "require('./package.json').version")
git tag "v${VERSION}"
git push origin "v${VERSION}"
```

The GitHub release workflow runs on `v*.*.*` tags. It installs the repo-declared npm version, checks that the pushed tag matches `package.json`, runs `npm run check`, creates artifacts with `--require-tag`, builds the API, web, and HTTP MCP Docker targets, and uploads the release artifact bundle.

The workflow does not publish npm packages, create a GitHub Release, or push container images yet. Those should be enabled after the business-safe release publishing policy is decided.
