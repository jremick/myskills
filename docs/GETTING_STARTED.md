# Getting Started

Version: 0.1.0-beta.3
Last updated: 2026-07-13

This is the canonical local first-run path for the MySkills public beta source tree.

## Prerequisites

- Node.js `>=22.13 <23 || >=24 <25` (the supported Node 22 and 24 LTS lines).
- The exact npm release declared in the root `packageManager` field.
- Docker with Compose support for local Postgres and MinIO dependencies.
- macOS or Linux. Windows is not in the beta verification matrix; WSL2 may work but is not currently tested.

Install the declared npm release, then install the locked workspace dependencies:

```bash
npm install -g "$(node -p 'require("./package.json").packageManager')"
npm ci
```

## Configure Local Development

Create the untracked local environment file from the public-safe template:

```bash
cp .env.example .env
```

Review the local-only seed credentials before use. Do not reuse them in production and do not commit `.env`.

The normal `db:migrate`, `db:seed`, `dev:api`, `dev:web`, `dev:mcp`, and `dev:mcp:http` npm paths read this repository-root `.env` automatically through Node's env-file support. Existing process variables take precedence, and production container start commands continue to use platform-injected variables rather than a copied env file. No shell-specific `source`, `set -a`, or exported secret values are required.

## Start Dependencies And Seed Data

```bash
npm run docker:up
npm run db:migrate
npm run db:seed
```

`docker:up` starts Postgres, MinIO, and the one-shot bucket initializer. The migration and seed commands use `DATABASE_URL`, `SEED_OWNER_EMAIL`, and `SEED_OWNER_PASSWORD` from `.env`.

## Start The App

Run the API and web app in separate terminals:

```bash
npm run dev:api
```

```bash
npm run dev:web
```

Open `http://localhost:3000`. The API is available at `http://localhost:3001`.

## Verify The First Run

```bash
curl http://localhost:3001/health
curl http://localhost:3001/ready
curl http://localhost:3001/v1/capabilities
curl http://localhost:3001/v1/skills
curl http://localhost:3001/v1/skills/release-notes-helper
```

Validate the public example with the built CLI:

```bash
npm run build
node apps/cli/dist/index.js --version
node apps/cli/dist/index.js validate --path examples/skills/release-notes-helper
node apps/cli/dist/index.js scan --path examples/skills/release-notes-helper
```

The prerelease gate also packs the public CLI, checks the exact tarball allowlist, installs it in a clean temporary directory with public dependencies resolved from npm, and repeats `--version`, `validate`, and `scan` through the installed `myskills` binary.

## Optional MCP Servers

Create an API token with `skills:read`, add it to the untracked `.env` as `MYSKILLS_TOKEN`, then run the stdio adapter:

```bash
npm run dev:mcp
```

The HTTP adapter authenticates each client request instead of using a shared server token:

```bash
npm run dev:mcp:http
curl http://127.0.0.1:3002/health
```

See [API, MCP, and CLI](API_MCP_CLI_PLAN.md) for the implemented and planned client surfaces.

## Stop Local Dependencies

Stop the API and web processes, then run:

```bash
npm run docker:down
```

For production-like self-hosting, use [Deployment](DEPLOYMENT.md). For the maintained live Railway shape, use [Railway Deployment](RAILWAY_DEPLOYMENT.md). Neither production path should copy the local `.env` into an image.
