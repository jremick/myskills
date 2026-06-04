# MySkills Project Instructions

Version: 0.1.0
Last updated: 2026-06-04

## Scope

These instructions apply to this repository. They extend the global Codex instructions and focus on keeping this project portable and public-ready.

## Product Boundary

- Treat this repo as a clean open-source product.
- Do not copy private source code, private skill content, internal documentation, production URLs, user identities, access policies, or organization-specific terminology into this repo.
- Keep public docs generic. If exact private-source evidence is needed during migration, keep it in `.private/`, which is ignored by git.

## Backend Direction

- The canonical backend must be a real application data model backed by a database, initially Postgres.
- Do not use a Git repository as the primary registry, database, moderation queue, access-control store, or package-content store.
- Use object storage for uploaded package archives and extracted immutable artifacts.
- GitHub integrations are allowed only as optional import, export, issue, PR, or release workflows.

## Authentication Direction

- Replace external-company identity assumptions with first-party user management.
- Support email/password accounts, verified email, admin-controlled registration policy, roles, sessions, MFA, and account recovery.
- Design provider integrations as optional adapters. Cloudflare Access, OIDC, SAML, GitHub, Google, and similar providers must map into local users and roles rather than becoming the only authorization source.
- Never store secrets in repo files, docs, examples, logs, or fixtures.

## Implementation Standards

- Keep changes surgical and tied to the product plan.
- Prefer TypeScript across web, API, CLI, MCP, and shared packages unless a documented decision changes that.
- Keep package validation, security scanning, authorization checks, and artifact delivery in shared modules where possible.
- Public API, CLI, and MCP behavior must share the same authorization model.
- Avoid dependency-heavy scaffolding until the first implementation milestone needs it.

## Verification

Before claiming setup or implementation work is ready:

- Run `npm run check`.
- Run `git status --short`.
- Confirm `npm run check:privacy` does not find internal/private carryover terms.
- For code changes, add or update tests that prove the intended behavior.
- For frontend work, run the app and verify the relevant user flow in a browser.
