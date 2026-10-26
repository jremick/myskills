# Beta.21 security release delivery

Prepared: 27 October 2026. Target release: `v0.1.0-beta.21`.
Status: source and release-metadata preparation. This record does not claim
publication or hosted deployment.

## Scope

Publish the security patches and updates already merged after published beta.20
(`69db44a92c365cea6c816cf9210564ad7bb641b5`). The release includes the merged
skill content preview, CI repairs, MCP SDK 2.3.1, Hono 4.13.13 and Vite 8.3.5
updates. It patches Zod to 4.6.7, Fastify to 5.12.7, Nodemailer to 10.2.1, and
the two fast-uri dependency lines to 3.1.9 and 4.2.3. No dependency is added.

Workspace versions move together to retain release coherence. Node 22/24 support
and the npm workspace layout remain. No database migration is added since
beta.20. Unmerged feature pull requests, Node-major upgrades, Railway recovery,
hosted deployment and the EXP migration are outside this release.

## Evidence and remaining gates

- The published beta.20 GitHub source and CLI asset checksums were verified.
  The npm beta.20 tarball matched the published CLI asset byte for byte.
- The patched lockfile passes full and production-only npm audits with zero
  vulnerabilities. Dependency manifests and lockfile changes were reviewed.
- Exact-candidate Node 22/24 checks, PostgreSQL integration, mocked and full-stack
  browser tests, container builds and CodeQL remain pending.
- Merge, immutable tagging, tagged canonical release verification, GitHub asset
  checksums and npm beta publication/readback remain pending.

Retain the exact source identity, CI receipts, release metadata and asset
checksums with publication evidence. Publish only after the required checks
pass. Native host, provider consent and deployed acceptance limits from earlier
release records remain; local checks do not establish hosted deployment.

## Upgrade and rollback

Use the checksummed source artifact and matching CLI package. Operators must
retain database, artifact-storage and configuration backups and upgrade the
API and web together. The hosted rollout is handled by separate migration work.
The beta.20 artifacts remain available for rollback; do not move or replace
published tags. A rollback restores earlier vulnerable dependency versions,
so assess that exposure before reverting an installed instance.
