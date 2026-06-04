# AI Skills Share

AI Skills Share is a planned open-source platform for publishing, reviewing, discovering, installing, and using AI agent skills across web, API, CLI, and MCP interfaces.

The project starts from the useful product lessons of a prior internal prototype, but this repository is a clean public-ready product. It does not use that prototype's identity model, company-specific terminology, or Git-repo-as-database backend.

## Working Name

Current name: **AI Skills Share**

Alternates worth considering before public launch:

- **Skillforge**: stronger product name, less literal, but may be harder to find.
- **Agent Skill Registry**: clearer for developers, more technical.
- **Skill Garden**: friendly, but less precise.
- **Open Skill Hub**: clear, but generic and likely crowded.

Recommendation for now: keep **AI Skills Share** until the product shape is visible, then decide whether the public repo should use the more descriptive `ai-skills-share` slug or a more distinctive brand.

## Product Goal

Build a production-ready, self-hostable registry for AI skills that supports:

- A web interface for browsing, submitting, reviewing, and managing skills.
- A backend API for search, metadata, submissions, packages, users, roles, audit, and admin operations.
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
scripts/
  check-*.mjs     Repo hygiene checks.
```

## Backend Principle

The backend is not a Git repository. GitHub can be integrated later for importing skill packages, opening review PRs, syncing examples, or publishing releases, but the canonical product state belongs in the application database and artifact store.

## Local Setup

```bash
npm install
cp .env.example .env
npm run docker:up
npm run db:migrate
npm run db:seed
npm run dev:api
npm run dev:web
```

The API defaults to `http://localhost:3001`; the web app defaults to `http://localhost:3000`.

```bash
curl http://localhost:3001/health
curl http://localhost:3001/v1/skills
curl http://localhost:3001/v1/skills/release-notes-helper
```

The seeded owner account uses `SEED_OWNER_EMAIL` and `SEED_OWNER_PASSWORD` from `.env`.

Open `http://localhost:3000` to browse approved skills, inspect release export guidance, and sign in with the seeded owner account. The browser UI supports MFA challenge completion when the account requires it, authenticated author `.zip` package submission, maintainer review approval/publication, and owner/admin console workflows for registration mode, user status actions, role updates, provider metadata/mapping management, and audit review.

Local auth verification and password-reset notifications default to `AUTH_NOTIFICATION_MODE=console`; development action links appear in the API process output. Production deployments use `AUTH_NOTIFICATION_MODE=smtp` and must set `APP_BASE_URL` to an HTTPS web origin plus SMTP settings in the environment or secret store.

To run the stdio MCP server, create an API token with `skills:read` scope and start:

```bash
AI_SKILLS_TOKEN=<api-token-with-skills-read> npm run dev:mcp
```

To run the stateless Streamable HTTP MCP server, start the HTTP adapter and configure MCP clients to send `Authorization: Bearer <api-token-with-skills-read>` to `POST /mcp`:

```bash
npm run dev:mcp:http
curl http://127.0.0.1:3002/health
```

The current CLI can validate and scan local package directories and `.zip` archives, search and inspect approved releases, submit package directories or server-extracted archive uploads, run maintainer review actions, manage scoped API tokens, and export verified approved bundles:

```bash
npm run build
node apps/cli/dist/index.js login --email "$SEED_OWNER_EMAIL"
node apps/cli/dist/index.js whoami
node apps/cli/dist/index.js search release
node apps/cli/dist/index.js info release-notes-helper
node apps/cli/dist/index.js export release-notes-helper --version 0.1.0 --platform codex --output ./tmp/release-notes-helper
node apps/cli/dist/index.js submit --path ./path-to-skill
node apps/cli/dist/index.js review submissions
node apps/cli/dist/index.js token create --name "Local CLI" --scope profile:read --scope skills:read --scope skills:submit
node apps/cli/dist/index.js logout
```

CLI bearer resolution is `--token`, then `AI_SKILLS_TOKEN`, then the stored login token scoped to the normalized API URL.

## Verification

```bash
npm run check
```

## Current Status

This is the first backend and product-surface foundation slice. It has workspace packages, a Fastify API, first-party email/password login with bearer sessions, hash-only email verification and password-reset action tokens, SMTP/dev auth notification delivery, MFA challenge flow, browser login/logout with session-aware API calls, CLI login/logout with API-URL-scoped stored sessions, hashed scoped API tokens, MFA-verified admin provider config and claim-to-role mapping management, public skill search/detail/release/bundle endpoints, MCP token introspection with `skills:read` and session decision audit events, authenticated package intake with server-side archive extraction and scan evidence, maintainer approve/publish actions, a Vite/React web browser for public registry metadata, author `.zip` package submission, maintainer review, and admin workflows including safe local role editing, read-only stdio and stateless Streamable HTTP MCP servers, a starter CLI with verified export, local install/list/update/rollback, and token management, Drizzle/Postgres schema and migrations, Docker Compose for Postgres plus S3-compatible object storage, seed data, package manifest validation, local package risk scanning, and deterministic checks.
