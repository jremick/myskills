# Codex Cloud Setup

Version: 1.0.0
Last updated: 2026-06-19

This runbook makes MySkills ready for subscription-based Codex cloud/web tasks while keeping implementation work on GitHub pull requests and avoiding API-billed GitHub Actions agents for now.

## Current Repo Contract

Codex cloud should mirror the existing GitHub CI contract:

- CI installs dependencies with `npm ci`.
- CI runs `npm run check` for the general gate.
- CI runs `npm run test:postgres` in a separate job with disposable Postgres.
- Release verification runs `npm run check`, builds release artifacts, and builds production Docker targets.

Do not add a GitHub Actions workflow that invokes a coding agent yet. Use Codex cloud/web to create branches and pull requests, then let the existing CI and human review gates decide whether to merge.

## Codex Environment

Create or update the Codex cloud environment for `jremick/myskills` with:

- Branch: `main` by default.
- Runtime: Node.js 20.
- Setup script:

```bash
npm install -g "$(node -p 'require("./package.json").packageManager')"
npm ci
```

- Agent internet access: off by default. Enable limited access only when a task explicitly needs current external documentation or package metadata.
- Secrets: none for the default environment.
- Environment variables: none for the default environment.

OpenAI's current Codex cloud environment docs say the setup script runs before the agent, setup has internet access, agent internet access is off by default, and `AGENTS.md` is used to find project-specific lint and test commands. Keep this repository aligned with that model.

## Standard Agent Prompt

Use this as the first low-risk cloud-agent task:

```text
Inspect the MySkills repository instructions and CI. Do not change runtime behavior. Make one documentation-only improvement that clarifies how to run an existing verification command, then run the relevant documentation-safe checks. Open a pull request for human review.
```

Expected behavior:

- The agent reads `AGENTS.md`, `README.md`, `package.json`, and `.github/workflows/ci.yml`.
- The diff is documentation-only.
- No secrets, deployment variables, GitHub Actions agent workflows, or production deploy changes are added.
- The PR waits for existing GitHub CI and human approval before merge.

## Verification Commands For Agents

Use the smallest applicable command:

```bash
npm run check:structure
npm run check:privacy
npm run scan:secrets
npm run build
npm run test
```

Use the full CI-equivalent gate when the change touches runtime code, shared contracts, package metadata, scripts, or release behavior:

```bash
npm run check
```

Use the Postgres integration gate only when the task touches migrations, DB-backed API behavior, auth flows, submissions/reviews, artifacts, audit, or token/session behavior:

```bash
TEST_DATABASE_URL=postgres://myskills_test:myskills_test@localhost:5432/myskills_test npm run test:postgres
```

Use production/deployment checks only with explicit approval:

```bash
npm run check:prod-env -- --env-file .env.production
curl https://api.myskills.sh/health
curl https://api.myskills.sh/v1/skills
curl https://myskills.sh/health
curl https://myskills.sh/api/health
```

Do not read, print, or create production `.env` files in Codex cloud. Production variables stay in the deployment provider or local approved secret stores.

## Approval Boundaries

Codex cloud agents may:

- Create implementation branches.
- Edit source, tests, and docs within the repo.
- Run local checks available from the checkout.
- Open pull requests for review.

Codex cloud agents must not do these without explicit user approval:

- Merge pull requests.
- Push tags.
- Publish npm packages.
- Create GitHub Releases.
- Deploy or redeploy Railway services.
- Modify GitHub Actions to run coding agents.
- Add, rotate, or print secrets.
- Change production Railway variables or object-storage settings.

## PR Checklist

Every cloud-agent PR should state:

- What changed.
- Which verification commands ran.
- Whether `npm run check` was run or intentionally skipped.
- Whether `npm run test:postgres` was needed.
- Whether deploy/release actions were intentionally left unperformed.
