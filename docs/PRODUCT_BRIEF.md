# Product Brief

Version: 0.1.0
Last updated: 2026-06-04

## Intent

MySkills helps teams and individual users package, review, publish, discover, install, and maintain reusable AI skills across agent runtimes and AI tools.

The product should feel like a real software registry, not a folder browser:

- skills have owners, semantic versions, lifecycle states, compatibility data, validation evidence, eval evidence, and security status
- users can discover and install only what they are authorized to use
- contributors can submit packages without needing write access to backend storage
- maintainers can review, approve, deprecate, revoke, and audit skills
- API, web, CLI, and MCP surfaces use the same backend decisions

## Primary Users

- Individual users browsing and installing skills.
- Skill authors creating and submitting reusable packages.
- Maintainers reviewing package quality, safety, and compatibility.
- Instance admins managing users, registration, roles, provider integrations, audit, and settings.
- AI clients using MCP tools to discover authorized skills and receive installation guidance.

## Product Capabilities

### Registry

- Skill search, browse, detail, and related-skill discovery.
- Lifecycle states: draft, private, submitted, review, approved, deprecated, revoked, archived.
- Visibility scopes: public, authenticated users, organization, team/group, private owner, explicit users.
- Package artifact storage and immutable release snapshots.

### Skill Versioning

- Semantic skill versions with unique release records per skill.
- Versioned skill packages with manifest, readme, payload files, examples, changelog, and platform adapters.
- Immutable artifact checksums and release metadata for each approved version.
- Install, update, rollback, deprecate, and revoke workflows that operate on specific skill versions.

### Evals

- Skill eval suites for expected behavior, installability, compatibility, safety, and regression checks.
- Eval runs tied to skill versions, package artifacts, target platforms, and reviewer decisions.
- Public-safe eval summaries on approved releases, with detailed evidence available to authorized maintainers.

### Review And Governance

- Submission queue with automated validation and security scan results.
- Maintainer review states and required reasons for approval, rejection, requested changes, deprecation, revocation, and deletion.
- Admin analytics for adoption, downloads, installs, submissions, review time, failures, and stale packages.
- Audit events for auth, authorization, package access, moderation, admin actions, and MCP tool calls.

### Web

- Browse/search/filter interface.
- Skill detail pages with supported platforms, examples, install/export guidance, and review/security status.
- Submission flow for authors.
- Review dashboard for maintainers.
- Admin console for users, roles, settings, provider integrations, audit, and reports.

### API

- Public metadata endpoints where instance policy allows it.
- Authenticated registry endpoints for search, detail, package delivery, submissions, and user workspace.
- Role-gated maintainer and admin endpoints.
- Stable API tokens for CLI and automation.

### CLI

- Login/logout/whoami.
- Init, validate, scan, package, submit.
- Search, info, install, export, list, update, rollback.
- Private workspace commands for draft packages.
- Admin and maintainer commands for queue inspection and reports.

### MCP

- Read-only default tools: search skills, get skill info, get install instructions.
- Role-gated read tools for maintainers and admins.
- Write tools only after explicit approval flows, scopes, and audit controls exist.

## Non-Goals For The First Public Milestone

- A marketplace or paid listing system.
- Executing uploaded code on the server.
- Trusting client-provided claims for authorization.
- Treating source-control hosting as the registry's authorization, review, or artifact boundary.
- Supporting every AI client package format in the first release.
