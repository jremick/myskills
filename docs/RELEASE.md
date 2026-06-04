# Release Process

Version: 0.1.0
Last updated: 2026-06-04

This repo is not ready for a public release until the remaining Milestone 7 security, threat-model, license, contribution, and example-package checks are complete. The release workflow exists now so the first public tag can be reproduced from source once those gates are done.

## Release Gates

Before creating a release tag:

- Confirm `package.json` has the intended version.
- Confirm the worktree is clean.
- Run `npm run check`.
- Run `npm run release:artifacts`.
- Review the generated `dist/release/release-metadata.json` and `dist/release/SHA256SUMS`.
- Confirm public docs and examples contain no private-source carryover.

## Local Artifact Build

```bash
npm run check
npm run release:artifacts
```

The artifact script writes:

- `ai-skills-share-<version>-source.tar`: source archive created from `HEAD`.
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

The workflow does not publish npm packages, create a GitHub Release, or push container images yet. Those should be enabled after the first public release policy is decided.
