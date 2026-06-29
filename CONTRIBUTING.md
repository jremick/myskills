# Contributing

MySkills is currently in public beta. Contributions are welcome when they are small, reviewable, and aligned with the current roadmap, but this is still a maintainer-led project.

## Before Opening A PR

- Open or comment on an issue first for non-trivial behavior changes.
- Keep pull requests focused on one bug fix, doc improvement, or narrow feature.
- Do not include secrets, real `.env` files, private package contents, local logs, screenshots with private data, or machine-specific paths.
- Keep changes compatible with the npm workspace layout in `package.json`.

## Local Setup

Use the repo-declared npm version and mirror CI:

```bash
npm install -g "$(node -p 'require("./package.json").packageManager')"
npm ci
```

For local API/web development:

```bash
cp .env.example .env
npm run docker:up
npm run db:migrate
npm run db:seed
npm run dev:api
npm run dev:web
```

## Verification

Run the narrowest check that proves your change:

```bash
npm run check
```

Run the Postgres integration gate when touching migrations, DB-backed API behavior, auth, submissions, review, artifacts, audit, tokens, sessions, or seed data:

```bash
TEST_DATABASE_URL=postgres://myskills_test:myskills_test@localhost:5432/myskills_test npm run test:postgres
```

`TEST_DATABASE_URL` must point at a disposable database whose name includes `test` or `ci`; the test resets that schema.

## Pull Request Expectations

Every PR should include:

- What changed.
- Why it matters.
- Verification commands run.
- Any migration, compatibility, security, or deployment impact.
- Screenshots for user-facing web changes when practical.

Security reports must not be opened as public PRs or issues. Use the private reporting path in [SECURITY.md](SECURITY.md).
