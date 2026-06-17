# API, MCP, And CLI Plan

Version: 0.1.1
Last updated: 2026-06-17

## Shared Rule

API, web, CLI, and MCP must ask the same backend for authorization. No client surface may reimplement access rules as a substitute for server-side decisions.

The current web slice consumes backend API decisions for login, current-user refresh, public skill search, skill detail, release metadata, export guidance, author archive submission, maintainer review actions, and owner/admin console operations. It forwards the active bearer token when present, but it must not fetch bundle payloads during metadata browsing/review or reimplement authorization policy in client code.

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
- `PUT /v1/admin/users/:id/roles`
- `GET /v1/admin/registration`
- `PUT /v1/admin/registration`
- `GET /v1/admin/providers`
- `PUT /v1/admin/providers/:key`
- `GET /v1/admin/audit`

Later eval endpoints:

- `GET /v1/skills/:slug/releases/:version/evals`
- `POST /v1/evals/runs`
- `GET /v1/evals/runs/:id`
- `GET /v1/review/submissions/:id/evals`

Current admin API slice implements MFA-verified session-only registration mode read/update, MFA-verified registration invitations, non-secret provider config and claim-to-role mapping management, safe user listing, user status actions, role editing with owner-only privileged-role safeguards, sanitized mutation audit events, and bounded audit listing. Provider login/linking and external identity lifecycle remain planned.

Use OpenAPI once the first implementation slice stabilizes.

## MCP Surface

Use the official TypeScript MCP SDK for production implementation if runtime constraints allow it. Current SDK docs support MCP servers with tools and Streamable HTTP transports over common Node frameworks.

Current implementation uses the stable TypeScript MCP SDK with stdio and stateless Streamable HTTP transports. MCP calls require an API token with `skills:read` scope through `GET /v1/mcp/session`; interactive session tokens are rejected for the MCP surface. Every MCP session authorization branch writes a sanitized API-owned `mcp.session` audit event with the allow/deny decision, credential kind, required scope, and reason code. The stdio adapter reads `MYSKILLS_TOKEN`; the HTTP adapter validates each request bearer through `/v1/mcp/session` before MCP protocol handling, requires each client request to send its own `Authorization: Bearer ...` header, applies host/origin guardrails, and does not fall back to a shared server token.

Initial tools:

- `search_skills`: search approved skills visible to the authenticated user.
- `get_skill_info`: return safe metadata for one authorized skill.
- `get_install_instructions`: return CLI install/export guidance without package contents.

Maintainer/admin read-only tools:

- `list_submissions`
- `get_submission`
- `run_stale_skill_checks`
- `get_registry_analytics`

Write tools and per-tool MCP audit events are deferred until the review workflow and an authoritative tool-execution audit model are stable.

MCP responses must not return package contents by default. Package delivery should go through API or CLI flows with explicit authorization and audit.

## CLI Surface

Initial commands:

```text
myskills login
myskills logout
myskills whoami
myskills init <skill-slug>
myskills validate --path <dir-or-zip>
myskills scan --path <dir-or-zip>
myskills package --path <dir> --output <file.zip>
myskills search [query]
myskills info <skill>
myskills install <skill> --platform <platform>
myskills export <skill> --platform <platform> --output <dir>
myskills list
myskills update [skill]
myskills rollback <skill>
myskills submit --path <dir-or-zip>
myskills review submissions
myskills review action <submission-id> --action <approve|publish> --reason <reason>
myskills token create --name <name> --scope <scope>
myskills token list
myskills token revoke <token-id>
```

Current CLI slice implements local `validate` and `scan` for manifest files, directories, and `.zip` packages, prompt-based `login`, MFA login completion, `logout`, API-URL-scoped durable session-token storage, backend-backed `search`, `info`, `whoami`, `submit` for normalized directory text-entry package intake and server-extracted `.zip` archive intake, role-gated review list/actions, verified `export` of approved bundle payloads, local `install`/`list`/`update`/`rollback` with a filesystem install registry and rollback snapshots, and server API-token create/list/revoke commands. Browser login, platform keychain storage, platform-specific install adapters, and archive creation are still planned.

Later maintainer/admin commands:

```text
myskills admin users
myskills admin audit
myskills admin analytics
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
- Eval fixture tests for pass, fail, warning, incompatible platform, and unsafe package cases.
- Denied-access tests prove restricted skills are not exposed through search, info, bundle, CLI, or MCP.
