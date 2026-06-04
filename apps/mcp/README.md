# MCP App

MCP transport surface for MySkills.

## Current Slice

Implemented:

- SDK-backed stdio MCP server
- stateless Streamable HTTP MCP server
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
MYSKILLS_TOKEN=<api-token-with-skills-read> npm run dev:mcp
```

The stdio MCP server defaults to `http://localhost:3001` and reads `MYSKILLS_API_URL` for another API base URL.

For Streamable HTTP, start the HTTP adapter and configure clients to call `POST /mcp` with a bearer API token:

```bash
npm run dev:mcp:http
curl http://127.0.0.1:3002/health
```

The HTTP adapter defaults to `127.0.0.1:3002/mcp` and reads `MYSKILLS_MCP_HOST`, `MYSKILLS_MCP_PORT`, `MYSKILLS_MCP_PATH`, `MYSKILLS_MCP_ALLOWED_HOSTS`, `MYSKILLS_MCP_ALLOWED_ORIGINS`, and `MYSKILLS_API_URL`. Unlike stdio, HTTP clients authenticate per request with `Authorization: Bearer <api-token-with-skills-read>`; the server validates that token through `/v1/mcp/session` before protocol handling and does not use a shared `MYSKILLS_TOKEN` fallback for HTTP clients. Non-loopback binds must set `MYSKILLS_MCP_ALLOWED_HOSTS`.

## Security Rules

MCP clients should authenticate with scoped API tokens, not interactive sessions. Tool handlers must enforce both the local user role and token scope through the API auth boundary.

Every `/v1/mcp/session` authorization decision is recorded by the API as a sanitized `mcp.session` audit event. The event records the allow/deny decision, safe credential kind, required scope, and reason code without bearer values, token hashes, package contents, or MCP tool arguments.

Package contents should not be returned by MCP tools in the first production surface. Delivery should remain an API/CLI path with explicit authorization and audit.

Tool inputs must not carry tokens or API base URLs. For stdio, configure `MYSKILLS_TOKEN` and `MYSKILLS_API_URL` in the MCP server process environment. For HTTP, configure only the API base URL and host/origin allowlists on the server, then send client credentials through the HTTP `Authorization` header.

## Planned Workflows

- role-gated read-only maintainer/admin tools
- authoritative per-tool MCP audit events for future maintainer/admin tools
- client compatibility notes
