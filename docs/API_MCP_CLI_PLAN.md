# API, MCP, And CLI Plan

Version: 0.1.0
Last updated: 2026-06-04

## Shared Rule

API, web, CLI, and MCP must ask the same backend for authorization. No client surface may reimplement access rules as a substitute for server-side decisions.

The current web slice consumes backend API decisions for login, current-user refresh, public skill search, skill detail, release metadata, and export guidance. It forwards the active bearer token when present, but it must not fetch bundle payloads during metadata browsing or reimplement authorization policy in client code.

## API Surface

Milestone 1 REST endpoints:

- `GET /health`
- `GET /v1/me`
- `POST /v1/auth/email-verification/request`
- `POST /v1/auth/email-verification/confirm`
- `POST /v1/auth/password-reset/request`
- `POST /v1/auth/password-reset/confirm`
- `GET /v1/auth/api-tokens`
- `POST /v1/auth/api-tokens`
- `DELETE /v1/auth/api-tokens/:id`
- `GET /v1/skills`
- `GET /v1/skills/:slug`
- `GET /v1/skills/:slug/releases/:version`
- `GET /v1/skills/:slug/releases/:version/bundle?platform=...`
- `POST /v1/submissions`
- `GET /v1/review/submissions`
- `POST /v1/review/submissions/:id/actions`

Milestone 2-3 REST endpoints:

- `POST /v1/drafts`
- `GET /v1/drafts`
- `GET /v1/submissions/mine`
- `GET /v1/admin/users`
- `POST /v1/admin/users/:id/actions`
- `GET /v1/admin/registration`
- `PUT /v1/admin/registration`
- `GET /v1/admin/audit`

Current admin API slice implements MFA-verified session-only registration mode read/update, safe user listing, user status actions, sanitized mutation audit events, and bounded audit listing. Role editing, invite flows, and provider mapping remain planned.

Use OpenAPI once the first implementation slice stabilizes.

## MCP Surface

Use the official TypeScript MCP SDK for production implementation if runtime constraints allow it. Current SDK docs support MCP servers with tools and Streamable HTTP transports over common Node frameworks.

Current implementation uses the stable TypeScript MCP SDK with stdio transport. MCP calls require an API token with `skills:read` scope through `GET /v1/mcp/session`; interactive session tokens are rejected for the MCP surface.

Initial tools:

- `search_skills`: search approved skills visible to the authenticated user.
- `get_skill_info`: return safe metadata for one authorized skill.
- `get_install_instructions`: return CLI install/export guidance without package contents.

Maintainer/admin read-only tools:

- `list_submissions`
- `get_submission`
- `run_stale_skill_checks`
- `get_registry_analytics`

Write tools are deferred until the review workflow and audit model are stable.

MCP responses must not return package contents by default. Package delivery should go through API or CLI flows with explicit authorization and audit.

## CLI Surface

Initial commands:

```text
ai-skills login
ai-skills logout
ai-skills whoami
ai-skills init <skill-slug>
ai-skills validate --path <dir-or-zip>
ai-skills scan --path <dir-or-zip>
ai-skills package --path <dir> --output <file.zip>
ai-skills search [query]
ai-skills info <skill>
ai-skills install <skill> --platform <platform>
ai-skills export <skill> --platform <platform> --output <dir>
ai-skills list
ai-skills update [skill]
ai-skills rollback <skill>
ai-skills submit --path <dir-or-zip>
ai-skills review submissions
ai-skills review action <submission-id> --action <approve|publish> --reason <reason>
ai-skills token create --name <name> --scope <scope>
ai-skills token list
ai-skills token revoke <token-id>
```

Current CLI slice implements local `validate` and `scan` for manifest files, directories, and `.zip` packages, prompt-based `login`, MFA login completion, `logout`, API-URL-scoped durable session-token storage, backend-backed `search`, `info`, `whoami`, `submit` for normalized directory text-entry package intake and server-extracted `.zip` archive intake, role-gated review list/actions, verified `export` of approved bundle payloads, local `install`/`list`/`update`/`rollback` with a filesystem install registry and rollback snapshots, and server API-token create/list/revoke commands. Browser login, platform keychain storage, platform-specific install adapters, and archive creation are still planned.

Later maintainer/admin commands:

```text
ai-skills admin users
ai-skills admin audit
ai-skills admin analytics
```

## Compatibility Targets

Start with a platform-neutral manifest plus one practical payload target:

- Codex Agent Skills package support first.
- Generic prompt/workflow bundle second.
- Claude, ChatGPT, and other target adapters after package and review rules are stable.

## Verification

- API contract tests for every authorization path.
- CLI smoke tests against a local API and fixture data.
- MCP initialize, tools/list, and tools/call tests.
- Denied-access tests prove restricted skills are not exposed through search, info, bundle, CLI, or MCP.
