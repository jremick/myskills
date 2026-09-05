# MySkills

MySkills is an open-source beta platform for publishing, reviewing, discovering, installing, and using AI agent skills across web, API, CLI, and MCP interfaces.

<p>
  <a href="https://github.com/jremick/myskills/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/jremick/myskills/actions/workflows/ci.yml/badge.svg"/></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache_2.0-blue.svg"/></a>
  <img alt="Node" src="https://img.shields.io/badge/node-22_LTS_%7C_24_LTS-brightgreen.svg"/>
  <a href="docs/"><img alt="Docs" src="https://img.shields.io/badge/docs-available-orange.svg"/></a>
  <img alt="Status" src="https://img.shields.io/badge/status-public_beta-yellow.svg"/>
</p>

## Preview

![MySkills registry browser populated with approved skills](artifacts/screenshots/myskills-populated-skills-2026-06-04.png)

## Release Status

Current target: **v0.1.0-beta.6**.

Published release: **[v0.1.0-beta.5](https://github.com/jremick/myskills/releases/tag/v0.1.0-beta.5)**.

The beta.6 candidate adds a dry-run-only work/team Codex bootstrap planner to
the beta.5 operational baseline. It does not add an apply or implicit discovery
path. The hosted beta at [myskills.sh](https://myskills.sh) remains on its
separately verified operational release; this CLI-only candidate does not
require a Railway promotion.

This beta is intended for real external trial use with documented compatibility, support, and upgrade expectations. It is still prerelease software and not yet the business-safe production release: API contracts, package formats, deployment defaults, and operational guidance may still change before `v1.0`.

Operational beta acceptance is tracked in [docs/OPERATIONAL_BETA_DELIVERY.md](docs/OPERATIONAL_BETA_DELIVERY.md); the one executable candidate gate is `npm run release:verify`.

## Name

Current name: **MySkills**.

Repository slug: **myskills**.

Hosted beta: **[myskills.sh](https://myskills.sh)**. Hosted registration remains owner-controlled; self-hosting is the documented evaluation path.

## Product Goal

Build a production-ready, self-hostable registry for AI skills that supports:

- A web interface for browsing, submitting, reviewing, and managing skills.
- A backend API for search, metadata, submissions, packages, users, roles, audit, and admin operations.
- Skill versioning with semantic releases, lifecycle state, compatibility metadata, install, update, and rollback support.
- MCP tools for agent/client discovery and guided installation.
- A CLI for package authoring, validation, submission, install, export, update, and rollback.
- First-party user accounts with admin-controlled registration, MFA, and optional external identity-provider integrations.
- A proper backend with Postgres as system of record and object storage for package artifacts.

## Repo Shape

```text
apps/
  api/      Backend API service and auth boundary.
  web/      Browser UI.
  cli/      User and maintainer command line.
  mcp/      MCP gateway or standalone transport adapter.
packages/
  auth/           Shared auth and authorization contracts.
  core/           Domain types, policy, errors, and shared utilities.
  skill-package/  Package manifest, validation, scanning, bundling, and install logic.
docs/
  adr/            Architecture decision records.
examples/
  skills/         Public-safe example skill packages.
scripts/
  check-*.mjs     Repo hygiene checks.
```

## Registry Principle

MySkills is compatible with Git-hosted skill workflows, but it treats registry state, review decisions, permissions, package artifacts, and audit history as application data. That keeps it useful for individuals who publish skills from a repository and for teams that need governed workflows beyond source-control permissions.

## Local Setup

Prerequisites: Node.js `>=22.13 <23 || >=24 <25`, the repo-declared npm version, and Docker.

```bash
npm install -g "$(node -p 'require("./package.json").packageManager')"
npm ci
cp .env.example .env
npm run docker:up
npm run db:migrate
npm run db:seed
```

Then run `npm run dev:api` and `npm run dev:web` in separate terminals. These normal npm scripts load the repository-root `.env` automatically; no shell-specific `source` or exported secret values are required. The API defaults to `http://localhost:3001`; the web app defaults to `http://localhost:3000`.

The complete first-run, smoke, and shutdown path lives in [Getting Started](docs/GETTING_STARTED.md).

```bash
curl http://localhost:3001/health
curl http://localhost:3001/ready
curl http://localhost:3001/v1/skills
curl http://localhost:3001/v1/skills/release-notes-helper
```

The seeded owner account uses `SEED_OWNER_EMAIL` and `SEED_OWNER_PASSWORD` from `.env`.

Open `http://localhost:3000` to browse approved skills, inspect release notes and export guidance, and sign in with the seeded owner account. The browser UI supports MFA challenge completion when the account requires it, authenticated author `.zip` package submission and withdrawal, maintainer artifact download with hash-attested approval/request-changes/rejection/publication, connected-target install/update/rollback review and progress, target and organization upgrade policy, immutable architecture upgrade revisions, and owner/admin lifecycle and console workflows.

Local auth verification and password-reset notifications default to `AUTH_NOTIFICATION_MODE=console`; development action links appear in the API process output. Production deployments use `AUTH_NOTIFICATION_MODE=resend` or `AUTH_NOTIFICATION_MODE=smtp` and must set `APP_BASE_URL` to an HTTPS web origin plus provider settings in the environment or secret store.

After creating an API token with `skills:read` for registry tools or `architectures:read` for architecture projection tools, place it in the untracked root `.env` as `MYSKILLS_TOKEN` and run `npm run dev:mcp`. A token with both scopes can use both tool groups. The stdio MCP dev script reads the same local env file automatically.

To run the stateless Streamable HTTP MCP server, start the HTTP adapter and configure MCP clients to send `Authorization: Bearer <scoped-api-token>` to `POST /mcp`. The API-owned `/v1/mcp/session` check accepts either `skills:read` or `architectures:read`; registry tools require `skills:read`, and architecture projection tools require `architectures:read`:

```bash
npm run dev:mcp:http
curl http://127.0.0.1:3002/health
```

The current CLI can validate and scan local package directories and `.zip` archives, search and inspect approved releases, submit package directories or server-extracted archive uploads, withdraw author submissions, run maintainer review actions, manage skill/release lifecycle state, manage scoped API tokens, and export verified approved bundles:

```bash
npm run build
node apps/cli/dist/index.js login
node apps/cli/dist/index.js whoami
node apps/cli/dist/index.js search release
node apps/cli/dist/index.js info release-notes-helper
node apps/cli/dist/index.js export release-notes-helper --version 0.1.0 --platform codex --output ./tmp/release-notes-helper
node apps/cli/dist/index.js submit --path ./path-to-skill
node apps/cli/dist/index.js review submissions
node apps/cli/dist/index.js submissions list
node apps/cli/dist/index.js releases list release-notes-helper
node apps/cli/dist/index.js token create --name "Local CLI" --scope profile:read --scope skills:read --scope skills:submit
node apps/cli/dist/index.js logout
```

The `0.1.0-beta.6` CLI uses npm's `beta` dist-tag. The `latest` and `alpha` tags remain on `0.1.0-alpha.3`, so prerelease users must select the beta channel explicitly:

```bash
npm install -g @jarel/myskills@beta
myskills --version
```

CLI bearer resolution is `--token`, then `MYSKILLS_TOKEN`, then the stored login token scoped to the normalized API URL.

## Example Skill

A public-safe example package lives at [examples/skills/release-notes-helper](examples/skills/release-notes-helper). It mirrors the seeded demo skill and can be used for CLI validation, local submission tests, and package-format examples:

```bash
npm run build
node apps/cli/dist/index.js validate --path examples/skills/release-notes-helper
node apps/cli/dist/index.js scan --path examples/skills/release-notes-helper
```

## Verification

```bash
npm run check
TEST_DATABASE_URL=postgres://myskills_test:myskills_test@localhost:5432/myskills_test npm run test:postgres
```

`npm run check` includes ESLint, builds, web typechecking, unit tests, prerelease policy/link/version checks, and a clean temporary install of the exact CLI tarball. `npm run test:postgres` requires `TEST_DATABASE_URL` to point at a disposable Postgres database whose name includes `test` or `ci`; it resets that database schema before applying migrations.

## Support And Security

Use [GitHub Issues](https://github.com/jremick/myskills/issues) for beta bugs, setup problems, and feature requests.

Do not report suspected vulnerabilities, exposed secrets, access-control bypasses, or package-safety escapes in public issues. Use GitHub private vulnerability reporting as described in [SECURITY.md](SECURITY.md).

See [SUPPORT.md](SUPPORT.md) for support boundaries and [CONTRIBUTING.md](CONTRIBUTING.md) for contribution expectations.

## Deployment

Container packaging is available for production API, web, and optional HTTP MCP services:

```bash
npm run check:prod-env -- --env-file .env.production --require-seed
docker compose --env-file .env.production -f docker-compose.production.example.yml config
docker compose --env-file .env.production -f docker-compose.production.example.yml build
```

The production Compose example publishes only the web port for browser/API traffic. The API remains private on the Docker network and is reached through the web container's same-origin `/api` proxy; do not add a direct API host port while using numeric `TRUST_PROXY` hop counts.

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for production Compose, migration/seed order, reverse proxy requirements, and managed-container deployment guidance.

## Compatibility And Upgrades

The public beta compatibility surface is documented in [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md). Prerelease upgrade and migration expectations are documented in [docs/UPGRADE_POLICY.md](docs/UPGRADE_POLICY.md).

Known prerelease limitations include provider login/linking, background scan jobs, durable eval runs, browser/device CLI login, platform-specific install adapters, and fully rehearsed production backup/restore runbooks.

## Release

Release artifacts can be generated from a clean git checkout:

```bash
TEST_DATABASE_URL=postgres://myskills_test:myskills_test@localhost:5432/myskills_test npm run release:verify
```

See [docs/RELEASE.md](docs/RELEASE.md) for staging, user-test evidence, approval boundaries, tag protection/ancestry, artifact contents, and rollback.

The archived alpha goal is tracked in [docs/ALPHA_RELEASE_GOAL.md](docs/ALPHA_RELEASE_GOAL.md). The current public beta goal is tracked in [docs/BETA_RELEASE_GOAL.md](docs/BETA_RELEASE_GOAL.md). The later business-safe production release goal is tracked in [docs/BUSINESS_SAFE_RELEASE_GOAL.md](docs/BUSINESS_SAFE_RELEASE_GOAL.md).

See [CHANGELOG.md](CHANGELOG.md) for release notes and user-facing changes.

## License

[Apache License 2.0](LICENSE) - Copyright 2026 Jarel Remick.

## Current Status

This is the public beta foundation slice. It has workspace packages, a Fastify API, first-party email/password login with token-free HttpOnly SameSite browser session responses, hash-only email verification and password-reset action tokens, Resend/SMTP/dev auth notification delivery, MFA challenge flow, browser login/logout with session-aware API calls, CLI login/logout with API-URL-scoped stored bearer sessions, hashed scoped API tokens, MFA-verified admin provider config and claim-to-role mapping management, public skill search/detail/release/bundle endpoints, skill versioning with release metadata and artifact checksums, MCP token introspection with `skills:read` and session decision audit events, authenticated package intake with server-side archive extraction and scan evidence, maintainer artifact download plus hash-attested approve/publish actions, a Vite/React web browser for public registry metadata, author `.zip` package submission, maintainer review, and admin workflows including safe local role editing, read-only stdio and stateless Streamable HTTP MCP servers, a starter CLI with verified export, local install/list/update/rollback, and token management, Drizzle/Postgres schema and migrations, Docker Compose for Postgres plus S3-compatible object storage, production container targets and preflight env validation, seed data, a public-safe example skill package, package manifest validation, local package risk scanning, deterministic prerelease checks, and reproducible release artifacts.
