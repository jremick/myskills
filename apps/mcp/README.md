# MCP App

MCP transport surface for AI Skills Share.

## Current Slice

Implemented:

- SDK-backed stdio MCP server
- authenticated read-only skill discovery through `search_skills`
- safe metadata for authorized skills through `get_skill_info`
- install/export guidance through `get_install_instructions`
- API-token-only auth check through `GET /v1/mcp/session`
- `skills:read` API token scope for MCP registry reads

Run locally:

```bash
npm run docker:up
npm run db:migrate
npm run db:seed
npm run dev:api
AI_SKILLS_TOKEN=<api-token-with-skills-read> npm run dev:mcp
```

The MCP server defaults to `http://localhost:3001` and reads `AI_SKILLS_API_URL` for another API base URL.

## Security Rules

MCP clients should authenticate with scoped API tokens, not interactive sessions. Tool handlers must enforce both the local user role and token scope through the API auth boundary.

Package contents should not be returned by MCP tools in the first production surface. Delivery should remain an API/CLI path with explicit authorization and audit.

Tool inputs must not carry tokens or API base URLs. Configure `AI_SKILLS_TOKEN` and `AI_SKILLS_API_URL` in the MCP server process environment.

## Planned Workflows

- role-gated read-only maintainer/admin tools
- Streamable HTTP transport
- MCP audit events for allow/deny decisions
- client compatibility notes
