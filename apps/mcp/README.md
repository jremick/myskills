# MCP App

MCP transport surface for MySkills.

## Current Slice

Implemented:

- SDK-backed stdio MCP server
- stateless Streamable HTTP MCP server
- authenticated read-only skill discovery through `search_skills`
- safe metadata for authorized skills through `get_skill_info`
- install/export guidance through `get_install_instructions`
- API-token-only auth check through `GET /v1/mcp/session` (accepts either `skills:read` or `architectures:read`)
- `skills:read` for MCP registry tools and `architectures:read` for architecture projection tools

## Beta.3 breaking MCP/security changes

Beta.3 contains an MCP contract change that was not part of the published
`0.1.0-beta.2` surface.
`get_install_instructions` no longer returns `apiBundleEndpoint`, any bundle
URL, or package contents. It returns authorized release metadata and generated
`myskills install ...` and `myskills export ... --output ...` commands. MCP
clients must execute the authenticated CLI flow or use the separately
authenticated API/CLI delivery path; they must not construct a bundle URL from
metadata. Generated CLI commands do not embed an API URL or bearer token;
configure the CLI with `myskills config set api-url ...` or `MYSKILLS_API_URL`,
then authenticate separately.

The MCP server remains read-only and does not perform team or sharing
mutations. Those API/CLI mutations now require the session/MFA boundary
documented in the API and CLI guides. Before upgrading to beta.3, enroll TOTP with
`POST /v1/auth/mfa/totp/enroll`, confirm with
`POST /v1/auth/mfa/totp/confirm`, retain the recovery codes, and complete the
login challenge through `POST /v1/auth/mfa/verify` or `myskills login` before
using a session-based mutation flow.

`MYSKILLS_API_URL` and the MCP API base URL accept only an absolute
`http://` or `https://` URL without credentials, query strings, or fragments.
Bearer credentials stay in request headers. Beta.3 publishes the corresponding
migration guidance; hosted deployment state remains a separate live read-back.

Run locally:

```bash
npm run docker:up
npm run db:migrate
npm run db:seed
npm run dev:api
npm run dev:mcp
```

Add an API token with `skills:read` for registry tools or `architectures:read` for architecture tools to the untracked root `.env` as `MYSKILLS_TOKEN` before starting the stdio adapter. A token with both scopes can use both tool groups. The normal MCP dev scripts load that file automatically. The stdio MCP server defaults to `http://localhost:3001` and reads `MYSKILLS_API_URL` for another API base URL.

For Streamable HTTP, start the HTTP adapter and configure clients to call `POST /mcp` with a bearer API token:

```bash
npm run dev:mcp:http
curl http://127.0.0.1:3002/health
```

The HTTP adapter defaults to `127.0.0.1:3002/mcp` and reads `MYSKILLS_MCP_HOST`, `MYSKILLS_MCP_PORT`, `MYSKILLS_MCP_PATH`, `MYSKILLS_MCP_ALLOWED_HOSTS`, `MYSKILLS_MCP_ALLOWED_ORIGINS`, `MYSKILLS_MCP_TRUST_PROXY_HOPS`, and `MYSKILLS_API_URL`. `MYSKILLS_API_URL` must be an absolute HTTP(S) URL without credentials, query strings, or fragments. Unlike stdio, HTTP clients authenticate per request with `Authorization: Bearer <scoped-api-token>`; the server validates that token through `/v1/mcp/session` before protocol handling, which accepts either `skills:read` or `architectures:read`, and each tool group then enforces its own scope. The server does not use a shared `MYSKILLS_TOKEN` fallback for HTTP clients. Non-loopback binds must set `MYSKILLS_MCP_ALLOWED_HOSTS`.

The HTTP boundary defaults to a bounded 120 requests per minute per socket IP, a 256 KiB request-body limit, bounded header/bucket/connection counts, and finite header/request/upstream/socket lifetimes. `MYSKILLS_MCP_TRUST_PROXY_HOPS` defaults to `0`, so `X-Forwarded-For` is ignored. Set a positive hop count only behind a known, fixed proxy chain; an incorrect value lets clients influence rate-limit identity.

## Security Rules

MCP clients should authenticate with scoped API tokens, not interactive sessions. Tool handlers must enforce both the local user role and token scope through the API auth boundary.

Every `/v1/mcp/session` authorization decision is recorded by the API as a sanitized `mcp.session` audit event. The event records the allow/deny decision, safe credential kind, required scope, and reason code without bearer values, token hashes, package contents, or MCP tool arguments.

Package contents should not be returned by MCP tools in the first production surface. Delivery should remain an API/CLI path with explicit authorization and audit.

Tool inputs must not carry tokens or API base URLs. For stdio, configure `MYSKILLS_TOKEN` and `MYSKILLS_API_URL` in the MCP server process environment. For HTTP, configure only the API base URL and host/origin allowlists on the server, then send client credentials through the HTTP `Authorization` header.

## Planned Workflows

- role-gated read-only maintainer/admin tools
- authoritative per-tool MCP audit events for future maintainer/admin tools
- client compatibility notes
