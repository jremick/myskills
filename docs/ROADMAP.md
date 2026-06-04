# Roadmap

Version: 0.1.0
Last updated: 2026-06-04

## Milestone 0: Private Project Setup

Goal: create a clean product repo and public-ready plan.

Acceptance:

- Private personal repo exists.
- Public-safe README, architecture, auth, data, API/MCP/CLI, security, and roadmap docs exist.
- Privacy and structure checks pass.
- Prior prototype reviewed without copying private source into this repo.

## Milestone 1: Backend Foundation Vertical Slice

Goal: prove the proper backend with a thin, runnable vertical slice.

Deliverables:

- TypeScript workspace packages under `apps/api`, `packages/core`, `packages/auth`, and `packages/skill-package`.
- Fastify API scaffold.
- Postgres migrations for users, roles, settings, skills, versions, platform variants, artifacts, scan runs/findings, jobs, and audit events.
- Seed data and local Docker Compose.
- Package manifest validation and basic package risk scanning.
- API tests for health, auth-required `/v1/me`, and public approved skill search.

Acceptance:

- `npm run check` passes.
- A skill package can be created as a DB record with an artifact reference.
- No Git repository is required for registry operation.
- Local setup can run Postgres plus object storage through Docker Compose.

Current status: in progress. The first API and schema slice exists with email/password session auth, public search/detail endpoints, and a starter CLI for validation, scanning, search, info, and token-based whoami. Artifact delivery, package intake, and scan jobs are still future work.

## Milestone 2: Auth And User Management Foundation

Goal: replace external identity assumptions with direct user management.

Deliverables:

- Email/password auth.
- Email verification and password reset.
- Registration modes: closed, request, open.
- Admin user bootstrap.
- Roles and scoped permissions.
- MFA with TOTP and recovery codes.
- Optional provider mapping spike.
- Hashed scoped API tokens for CLI and MCP.

Acceptance:

- Admin can enable/disable registration.
- Users can register only according to instance policy.
- MFA-protected user flows pass.
- API, web, CLI, and MCP use the same user/role decisions.
- Disabled users and revoked tokens fail immediately.

## Milestone 3: Package Validation, Submission, And Registry MVP

Goal: make skills safe and useful enough to publish privately.

Deliverables:

- Manifest schema.
- Package archive parser with traversal, symlink, size, and file-count defenses.
- Skill payload validation.
- Secret scanning and risky-content scanning.
- Drafts, submissions, review queue, approval, publish, deprecate, revoke.
- Search, detail, and authorized bundle delivery.
- Background scan jobs and immutable artifact records.

Acceptance:

- Invalid, unreviewed, failed-security, deprecated, and revoked packages are handled correctly.
- Authorized users can install approved packages.
- Unauthorized users cannot infer restricted packages.

## Milestone 4: CLI MVP

Goal: support author and user workflows from the terminal.

Deliverables:

- `ai-skills` CLI package.
- Login, whoami, logout, token storage.
- Init, validate, scan, package, submit.
- Search, info, install, export, list, update, rollback.
- CLI integration tests against local API.

Acceptance:

- A new user can login, search, install, list, update, and rollback.
- An author can create, validate, scan, package, and submit a draft.

## Milestone 5: Web App MVP

Goal: make the registry useful without the CLI.

Deliverables:

- Browse/search/filter UI.
- Skill detail pages.
- Submit flow.
- Maintainer review dashboard.
- Admin user/settings console.
- Accessible responsive design.

Acceptance:

- Common user, author, maintainer, and admin workflows work in browser tests.
- Text and controls fit on mobile and desktop.

## Milestone 6: MCP Production Surface

Goal: expose safe agent-facing registry discovery.

Deliverables:

- SDK-backed MCP endpoint.
- Read-only skill discovery and install-instruction tools.
- Role-gated maintainer/admin read tools.
- Client compatibility notes.
- MCP audit events.

Acceptance:

- MCP clients can discover authorized skills.
- MCP cannot return unauthorized metadata or package contents.
- Tool results align with API and CLI authorization tests.

## Milestone 7: Public Release Hardening

Goal: make the repo public-ready.

Deliverables:

- Installation docs.
- Deployment docs for Docker Compose and at least one managed target.
- Security review.
- Threat model update.
- License and contribution policy review.
- Release workflow.
- Example package set with no private content.

Acceptance:

- Fresh clone can run checks and local demo.
- Secret scan passes.
- Public docs contain no private-source carryover.
- First public release tag is reproducible.
