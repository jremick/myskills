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

## Initial Commands

```bash
npm run check
```

## Current Status

This is the initial private scaffold. The next milestone is the first implementation slice: database schema, auth baseline, package model, and a minimal API plus CLI smoke path.

