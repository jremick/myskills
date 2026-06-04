# API, MCP, And CLI Plan

Version: 0.1.0
Last updated: 2026-06-04

## Shared Rule

API, web, CLI, and MCP must ask the same backend for authorization. No client surface may reimplement access rules as a substitute for server-side decisions.

## API Surface

Initial REST-style endpoints:

- `GET /health`
- `GET /v1/me`
- `GET /v1/skills`
- `GET /v1/skills/:slug`
- `GET /v1/skills/:slug/releases/:version`
- `GET /v1/skills/:slug/releases/:version/bundle?platform=...`
- `POST /v1/drafts`
- `GET /v1/drafts`
- `POST /v1/submissions`
- `GET /v1/submissions/mine`
- `GET /v1/review/submissions`
- `POST /v1/review/submissions/:id/actions`
- `GET /v1/admin/users`
- `POST /v1/admin/users/:id/actions`
- `GET /v1/admin/audit`

Use OpenAPI once the first implementation slice stabilizes.

## MCP Surface

Use the official TypeScript MCP SDK for production implementation if runtime constraints allow it. Current SDK docs support MCP servers with tools and Streamable HTTP transports over common Node frameworks.

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
```

Later maintainer/admin commands:

```text
ai-skills review submissions
ai-skills review action <submission-id> --action <action> --reason <reason>
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

