# MCP App

MCP transport surface for MySkills.

## Current Slice

Implemented:

- SDK v2 stdio MCP server with legacy and `2026-07-28` protocol negotiation
- stateless Streamable HTTP MCP server with legacy and `2026-07-28` request handling
- authenticated read-only skill discovery through `search_skills`
- safe metadata for authorized skills through `get_skill_info`
- install/export guidance through `get_install_instructions`
- API-token-only auth check through `GET /v1/mcp/session` (accepts either `skills:read` or `architectures:read`)
- `skills:read` for MCP registry tools and `architectures:read` for architecture projection tools
- native `skills/list`, `skills/get`, and verified `resources/read` delivery for extension-aware clients

## Protocol compatibility

The stdio entrypoint uses `serveStdio` to select the protocol for each connection.
The HTTP entrypoint uses `createMcpHandler` for modern requests and the SDK's
request classifier to preserve legacy stateless JSON responses. Both paths expose
the same six metadata tools. Modern clients can use `server/discover`, `tools/list`,
and `tools/call`; the SDK supplies the required protocol envelope and server identity
metadata. Legacy clients continue to use `initialize` and the existing tools.

The adapter keeps its scoped API-token authentication. HTTP validates the bearer
on every request before protocol handling, including modern discovery, and creates
each request's server with that request's token. Modern client metadata does not
establish identity or grant access. The HTTP endpoint accepts only `POST`; `/health`
remains a separate `GET`, and `OPTIONS` remains unsupported. Browser hosts still need
an appropriate same-origin or trusted proxy arrangement.

Native Skills delivery implements the current extension's server contract. Full
modern authorization and a host's on-demand activation path remain separate
[MCP-1](../../docs/ROADMAP.md) acceptance work. Existing tools retain their metadata
and CLI guidance responses; skill file bytes use `resources/read`.

## Native Skills delivery

The server declares `resources: {}` and
`extensions: { "io.modelcontextprotocol/skills": {} }`. A client must also declare
the extension before calling `skills/list` or `skills/get`. On protocol
`2026-07-28`, declare it in each request's client-capabilities metadata. Legacy
stdio clients declare it in `initialize`. The stateless legacy HTTP adapter does
not retain initialization capabilities; native Skills clients should select
`2026-07-28` over HTTP. A missing declaration returns an actionable capability
error. Optional `resources/directory/read` is not advertised or implemented.

`skills/list` processes five registry candidates per page, in the API's stable
slug order. It lists only each skill's latest stable approved default and skips
packages with incompatible root `SKILL.md` frontmatter or package structure. A
page can be empty while still containing `nextCursor`; continue paging in that
case. The cursor retains API actor scoping and is bound to the configured registry
origin. It is not an authorization grant. `skills/get` supports direct lookup of
an exact approved release, including a known URI omitted from current discovery.

Each entry includes all parsed YAML frontmatter fields and the complete package
file manifest with SHA-256 digests and byte lengths. YAML duplicate keys, aliases,
custom tags, complex keys and non-JSON values fail closed. Frontmatter is limited
to 32 KiB, 20 levels and 4,096 values. Package limits retain the registry's 500
text files and 1 MiB total UTF-8 content; native delivery currently supports text
packages only. BOM and non-ASCII bytes remain unchanged in resources and digests.

Resource identities use this structure:

```text
skill://myskills-<registry-origin-sha256>/<slug>/<exact-version>/<artifact-sha256>/<frontmatter-name>/SKILL.md
```

Every segment is canonically URI-encoded; build metadata remains part of the
exact version. The origin digest derives from the configured API base URL. The
frontmatter name may differ from the registry slug: the slug identifies the API
record, and the final directory matches the authored skill name. Every supporting
file appears below that directory. Changing the API base URL changes this
namespace; aliases of one registry do not share identities. A host must still
preserve its own server identity together with each URI.

Each native list/get/read performs a fresh scoped API session check, then uses
the API's current release and bundle authorization. The adapter verifies the raw
bundle's byte size and digest, exact manifest/release identity, supported platform,
portable paths, and text limits before returning any content. Native responses
are private with `ttlMs: 0`; the adapter has no content or authorization cache.
Upstream bodies are streamed within explicit byte limits and a ten-second
operation deadline. Requests do not follow redirects. A stale or revoked URI,
missing file, malformed path or changed artifact fails without returning content.

The `x-myskills-mcp-method` header on the session check identifies the native
operation for API audit records. It is caller-declared authorization intent, not
proof that content delivery completed. Bundle authorization has its own existing
artifact-access audit. Neither audit stores file contents or bearer values.

Use the official Skills server conformance scenarios and Inspector's
`skills/list --verify` for protocol and content verification. These checks do not
prove host activation. The available fast-agent integration is a draft-compatible
local-copy importer that downloads the complete manifest; an import proof must
not be described as current-spec on-demand skill activation. Host-side reading,
approval, execution permissions and nested skill activation remain host decisions.

References: [Skills specification](https://github.com/modelcontextprotocol/ext-skills/blob/main/specification/stable/skills.mdx),
[conformance scenarios](https://github.com/modelcontextprotocol/conformance/tree/main/src/scenarios/server/skills),
[fast-agent compatibility](https://github.com/evalstate/fast-agent/blob/main/docs/docs/mcp/skills-over-mcp.md).

SDK references: [v2 migration](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md)
and [2026-07-28 serving](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md).

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

The six existing tools do not return package contents. Native resources use the
API's authorized immutable bundle path with explicit integrity checks and audit.
Reading resources never executes code or grants host tools additional permissions.

Tool inputs must not carry tokens or API base URLs. For stdio, configure `MYSKILLS_TOKEN` and `MYSKILLS_API_URL` in the MCP server process environment. For HTTP, configure only the API base URL and host/origin allowlists on the server, then send client credentials through the HTTP `Authorization` header.

## Planned Workflows

- role-gated read-only maintainer/admin tools
- authoritative per-tool MCP audit events for future maintainer/admin tools
- client compatibility notes
