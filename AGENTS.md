# MySkills Agent Instructions

Version: 1.0.0
Last updated: 2026-06-19

## Source Of Truth

- GitHub is the source of truth for code, issues, pull requests, and review state.
- Preserve the existing npm workspace layout in `package.json`; do not introduce another package manager.
- Keep MySkills public-alpha safe: do not add private-source carryover, secrets, personal credentials, or machine-specific state.
- Treat registry state, review decisions, permissions, package artifacts, and audit history as application data owned by the MySkills API, not as Git-only state.

## Repository Shape

- `apps/api`: Fastify API, auth boundary, Postgres migrations, seeds, and API tests.
- `apps/web`: Vite/React browser UI.
- `apps/cli`: CLI package published as `@jarel/myskills`.
- `apps/mcp`: stdio and HTTP MCP adapters.
- `packages/core`: shared domain contracts and utilities.
- `packages/auth`: shared auth and authorization contracts.
- `packages/skill-package`: package manifest validation, scanning, bundling, and install logic.
- `docs`: architecture, security, release, deployment, and roadmap records.
- `examples/skills`: public-safe example skill packages.
- `scripts`: deterministic repo checks and release helpers.

## Setup

Use the repo-declared Node/npm path and mirror CI:

```bash
npm install -g "$(node -p 'require("./package.json").packageManager')"
npm ci
```

For Codex cloud environment setup, prefer the maintained runbook in `docs/CODEX_CLOUD.md`.

## Verification

Run the narrowest check that proves the change, then broaden when touching shared contracts or user workflows.

- General repo gate: `npm run check`
- Disposable Postgres integration gate: `TEST_DATABASE_URL=postgres://localhost:5432/myskills_test npm run test:postgres`
- Release artifact gate: `npm run release:artifacts`
- Production env preflight: `npm run check:prod-env -- --env-file .env.production`

`npm run test:postgres` must use a disposable database whose name includes `test` or `ci`; it resets that schema.

## Change Rules

- Make surgical, style-matching changes and avoid unrelated refactors.
- Before changing code, inspect relevant callers, tests, shared types, and docs.
- Keep generated output out of source control unless the repo already tracks that artifact type.
- Do not commit or print `.env` contents, API tokens, database URLs with real credentials, npm tokens, Railway variables, object-storage keys, or seeded owner credentials.
- Keep merge, release, npm publish, and Railway deploy steps approval-gated unless the user explicitly asks for them.
- Do not add GitHub Copilot coding-agent workflows or API-billed Codex GitHub Actions automation unless explicitly requested.

## Deployment Notes

- Local development uses Docker only for optional dependency containers; the Postgres integration gate can use local Homebrew Postgres.
- Railway production details live in `docs/RAILWAY_DEPLOYMENT.md`; do not infer live deployment state from local files alone.
- Keep API and web deploys on the same commit, and verify with the documented health checks plus browser-level auth/export checks before calling a change live.
