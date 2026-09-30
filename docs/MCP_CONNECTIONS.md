# Remote MCP connections (ChatGPT, Claude and other hosts)

Status: opt-in source feature. It is **not deployed** to the hosted beta, and
no ChatGPT or Claude acceptance has been performed. See
[MCP Connections Delivery](MCP_CONNECTIONS_DELIVERY.md) for evidence and gates.

The UI is the baseline for authorized user outcomes. Coverage is maintained in
**API → CLI → MCP** order in the [capability matrix](CAPABILITY_PARITY.md).
The original read-only connector has been expanded in source to named
application actions. Follow the [implementation ledger](CAPABILITY_PARITY_IMPLEMENTATION.md)
for the exact local checks and remaining host/deployment gates.

A remote MCP connection lets a hosted AI app use the application actions a
MySkills account can perform and has explicitly granted to that connection.
The user signs in through trusted MySkills controls, completes any required
MFA and approves the requested scopes. The host uses a short-lived OAuth token;
API services check current user permissions and resource policy on every call.

## Capabilities and permission boundaries

- The canonical [action policy](../packages/core/src/delegated-actions.ts)
  maps 168 named application/public operations to fixed methods, routes,
  scopes and assurance requirements. The MCP adapter creates one named tool
  per action; it does not accept an arbitrary HTTP method or URL.
- OAuth supports 31 application scopes. Existing grants gain no new scopes
  when the server upgrades. API tokens use those same application scopes and
  a separate `targets:execute` scope for enrolled local executors. The token
  chooser initially selects only `skills:read`.
- Tool discovery lists an action and its required scope; this is not permission
  to run it. Missing scope requires reconnection and explicit consent. Live
  role, membership, ownership, sharing, lifecycle and account status still
  control access. Safe metadata remains distinct from secret material.
- Privileged OAuth actions require valid assurance from the approving session's
  actual MFA verification. Its window ends **15 minutes after verification**.
  Access-token exchange or refresh never renews that window. Complete MFA and
  consent in the trusted browser flow and reconnect when assurance expires.
  Original read-only grants retain their old role ceiling.
- Account metadata, authorized settings and token/connection revocation can
  use named actions. Passwords, credential issuance, MFA enrollment and
  recovery material remain in trusted browser or private CLI controls.
  `application_handoff` covers 27 trusted/local guidance actions, including
  five local CLI workflows. It returns guidance and suggested readback with
  `performed: false` and unconfirmed completion; it does not execute the flow.
- Local package authoring, installation, observation, improvement execution
  and target receipts require an actual local CLI/producer/executor. MCP may
  schedule and inspect an authorized target operation; it cannot fabricate
  local state, lease/fencing tokens, model evaluation or execution receipts.
- Existing search, bundle and architecture tools remain available. Native MCP
  Skills methods (`skills/list`, `skills/get`, `resources/read`) remain a
  separate client capability. Reading a file does not install, enable or run
  it in the host.

The matrix records direct coverage, constrained producer workflows, trusted
handoffs and missing product capabilities separately. A source tool mapping
or a successful local test does not establish real ChatGPT/Claude acceptance.

MCP accepts application API request bodies up to 14 MiB, with 64 KiB reserved
for the HTTP JSON-RPC envelope. Metadata responses are bounded to 512 KiB and
exports to 10 MiB. Reviewed exports preserve the API response digest and
verify the returned bytes; ordinary exports use a computed digest.

## Protocol profile

MySkills acts as its own authorization server. This is a documented subset of
the [MCP authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization),
not a full conformance claim:

| Area | Behavior |
| --- | --- |
| Discovery | RFC 9728 protected resource metadata at `/.well-known/oauth-protected-resource/mcp` (and the root form); RFC 8414 metadata at `/.well-known/oauth-authorization-server`; `WWW-Authenticate: Bearer resource_metadata=...` on 401 |
| Grant | Authorization code with S256 PKCE only; `plain`, implicit, password and client-credentials grants are not supported |
| Redirects | Exact string match against registered URIs; no wildcards, fragments or credentials; HTTPS (HTTP only on loopback) |
| Responses | `state` returned verbatim; RFC 9207 `iss` on every authorization response |
| Audience | RFC 8707 `resource` must equal the configured MCP URL; tokens are bound to it and rejected by any other MCP adapter |
| Tokens | Opaque; access 15 minutes; refresh 30 days with rotation and reuse detection; connection lifetime 90 days |
| Privileged assurance | Actual approving-session MFA timestamp is persisted in the code/grant; assurance ends 15 minutes after verification and cannot be extended by refresh |
| Registration | RFC 7591 dynamic registration restricted to allowlisted redirect hosts, and/or operator-configured clients. Client ID metadata documents (CIMD) and RFC 7592 management are **not** implemented |
| Revocation | RFC 7009 endpoint, per-connection revocation in Settings, and automatic revocation on password change, email change, MFA removal, role change and account disable |

Secrets (codes, access and refresh tokens, client secrets and consent request
handles) are stored only as SHA-256 digests. Authorization codes appear only
in the final redirect to the client. The consent request handle travels in the
URL fragment, not in server-visible query strings.

## Configuration

Set these on the **API** service. Remote connections stay off unless
`MYSKILLS_OAUTH_ENABLED=true`, and the API refuses to start when an enabled
configuration is incomplete or unsafe.

| Key | Purpose |
| --- | --- |
| `MYSKILLS_OAUTH_ENABLED` | `true` to enable; default off |
| `MYSKILLS_OAUTH_ISSUER` | Public HTTPS origin that serves `/.well-known/oauth-authorization-server` and `/oauth/*` |
| `MYSKILLS_OAUTH_CONSENT_ORIGIN` | Public web origin that serves `/connect/authorize`; defaults to `APP_BASE_URL` |
| `MYSKILLS_MCP_PUBLIC_URL` | Exact public MCP URL, such as `https://skills.example.com/mcp` |
| `MYSKILLS_OAUTH_DYNAMIC_REGISTRATION` | `true` to allow RFC 7591 registration |
| `MYSKILLS_OAUTH_REDIRECT_HOSTS` | Required with dynamic registration: exact redirect hostnames, comma separated |
| `MYSKILLS_OAUTH_CLIENTS` | Optional JSON array of configured clients (see below) |

Set these on the **MCP HTTP** service (both or neither):
`MYSKILLS_OAUTH_ISSUER` and `MYSKILLS_MCP_PUBLIC_URL` with the same values as
the API. The public URL path must equal `MYSKILLS_MCP_PATH`. Optional:
`MYSKILLS_MCP_RATE_LIMIT_MAX_REQUESTS` (default 120 per minute per client
address). Hosted AI apps call from shared cloud egress addresses, so size the
limit and `MYSKILLS_MCP_TRUST_PROXY_HOPS` for your verified proxy chain.

Public URLs are read only from this configuration, never from `Host` or
forwarded headers. Plain HTTP is accepted only for loopback test stacks, and
the production preflight rejects it.

### Configured clients

Use configured clients when dynamic registration is off, or when a provider's
advanced settings ask for a client ID and secret:

```json
[{"client_id":"claude-connector","client_name":"Claude","redirect_uris":["<exact redirect URI from the provider>"],"client_secret_sha256":"<sha256 hex of the secret>"}]
```

Generate the client secret with your approved secret manager (at least 256
bits of randomness), keep it there, and configure only its lowercase
hexadecimal SHA-256 digest as `client_secret_sha256`. Do not print the secret
to a terminal, shell history, CI log, ticket or chat. Enter the secret only in
the provider's connector settings, directly from the secret manager. Rotate it
by adding a second configured client, moving the connector, then removing the
old entry; removing a client ends its connections. Omit
`client_secret_sha256` for a public PKCE client. Redirect URIs are exact: use
the value the provider's connector management page shows.

## Topology

Recommended: one public origin through the existing web service.

```text
https://skills.example.com/                      web SPA (consent at /connect/authorize)
https://skills.example.com/api/*                 -> API (existing same-origin proxy)
https://skills.example.com/.well-known/oauth-authorization-server -> API
https://skills.example.com/oauth/*               -> API
https://skills.example.com/.well-known/oauth-protected-resource/* -> MCP
https://skills.example.com/mcp                   -> MCP
```

`deploy/nginx.railway.conf.template` contains these routes. Set the web
service's `MCP_PROXY_TARGET` to the MCP service's verified private or public
URL (an origin, no path); it defaults to `http://127.0.0.1:3002`, so without an
MCP service `/mcp` answers 502. nginx resolves the target at startup: do not
point it at a service that does not exist. The MCP service must allow the Host
value nginx forwards (`MYSKILLS_MCP_ALLOWED_HOSTS`).

For this topology use `MYSKILLS_OAUTH_ISSUER=https://skills.example.com` and
`MYSKILLS_MCP_PUBLIC_URL=https://skills.example.com/mcp`. Separate hosts also
work (for example the API as issuer and a dedicated MCP host) when each host
routes the paths above to the right service and the consent origin carries
the MySkills session cookie.

## Railway runbook (not executed)

These steps describe a future change; they were not performed. Follow
[Railway Deployment](RAILWAY_DEPLOYMENT.md) and [Release](RELEASE.md) for
staging-first promotion, backups and API-ready-then-web order.

1. Apply migrations `0034_oauth_connections.sql` and `0035_oauth_assurance.sql`
   through the normal API start. These add connection storage and nullable
   assurance provenance; legacy rows do not gain new authority. Keep
   `MYSKILLS_OAUTH_ENABLED` unset for this step.
2. Add an MCP HTTP service built from `Dockerfile.mcp` (set Railway's
   `RAILWAY_DOCKERFILE_PATH=Dockerfile.mcp`)
   with `MYSKILLS_API_URL` (private API URL), `MYSKILLS_MCP_HOST=0.0.0.0`,
   `MYSKILLS_MCP_ALLOWED_HOSTS`, `MYSKILLS_MCP_TRUST_PROXY_HOPS`,
   `MYSKILLS_OAUTH_ISSUER` and `MYSKILLS_MCP_PUBLIC_URL`. Leave
   `MYSKILLS_MCP_PORT` unset so the server uses Railway's `PORT`; its standalone
   default is 3002. Verify `/health`. The local CI and release image gates start
   this image's default command with network disabled and a non-default `PORT`,
   then check health and rejection of anonymous MCP requests.
3. Set the web service's `MCP_PROXY_TARGET` to that MCP service and redeploy
   web from the same commit.
4. On the API set `MYSKILLS_OAUTH_ENABLED=true`, the issuer, MCP public URL,
   consent origin (or rely on `APP_BASE_URL`), and a registration path:
   dynamic registration with `MYSKILLS_OAUTH_REDIRECT_HOSTS` limited to the
   provider hosts you intend to support, and/or `MYSKILLS_OAUTH_CLIENTS`.
   Run `npm run check:prod-env -- --env-file <file>` against the planned values.
5. Verify routing and public URL consistency from outside the platform:
   `node scripts/check-mcp-oauth-routing.mjs --origin https://skills.example.com`.
   It must pass all six checks. Then sign in, open Settings and confirm the
   Remote connections row shows the configured MCP URL.
6. Complete staging provider acceptance (below) before production.

Disable: set `MYSKILLS_OAUTH_ENABLED=false` (or unset) and restart the API.
Discovery, authorization and consent routes disappear, and existing connector
tokens stop working immediately because they are no longer recognized. Unset
the MCP service's OAuth variables to return it to API-token-only mode.
Rollback of the application keeps the additive tables; the previous release
ignores them. Do not drop them while connections might be re-enabled.

## Connecting ChatGPT

Custom connectors depend on the ChatGPT plan and workspace settings. Add a
connector (app) that uses the MCP server URL with OAuth. ChatGPT discovers the
metadata and registers itself when dynamic registration is enabled; otherwise
enter the configured client ID and secret. Register the exact redirect URI
shown on ChatGPT's connector management page. With issuer identification in
place ChatGPT may use `https://chatgpt.com/connector_platform_oauth_redirect`;
otherwise it shows a connection-specific `/connector/oauth/{callback_id}` URI.
Do not assume either value. See OpenAI's
[authentication guide](https://developers.openai.com/plugins/build/auth).

## Connecting Claude

Open Customize, then Connectors, and choose Add custom connector. Enter the
MCP server URL and, if your administrator configured one, the client ID and
secret under advanced settings. Then connect and approve access in MySkills.
Claude connectors are brokered from Anthropic's cloud even in the desktop app,
so the endpoint must be publicly reachable. On Team and Enterprise plans an
owner adds the connector and each member connects. See Anthropic's
[custom connector guide](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

Never paste MySkills passwords, API keys or tokens into a chat.

## Verification

| Layer | Command | Proves |
| --- | --- | --- |
| API contract | `npm test -w @myskills-app/api` (`oauth-connector-routes.test.ts`, `delegated-actions.e2e.test.ts`, `oauth-assurance.e2e.test.ts`) | Named action scopes, live policy, assurance provenance/expiry, authorization server behavior and revocation |
| Postgres | `TEST_DATABASE_URL=... npm run test:postgres` (`postgres-oauth-connector.pgtest.ts`) | Persistence, digests, single-use under concurrency, account revocation ordering |
| MCP | `npm test -w @myskills-app/mcp` (`oauth-connector.e2e.test.ts`) | Real sockets: API + MCP adapter + SDK client, two users, content reads, refresh, revocation, legacy tokens |
| Browser | `npm run test:e2e -w @myskills-app/web` (`remote-connections.spec.ts`) | Consent, sign-in and MFA return, errors, settings setup and revocation (mocked API) |
| Full stack | `npm run test:e2e:fullstack` (or `-- mcp-oauth-connector.spec.ts` for the connector journey only) | Production nginx template routing to real API and MCP containers on one origin, plus the routing check. Without filters, existing journeys and the connector journey run on separate fresh stacks so the unchanged login rate limit does not span them |
| Deployment | `node scripts/check-mcp-oauth-routing.mjs --origin <origin>` | Discovery, authorization, token, MCP challenge and consent routing on a live origin |

None of these establishes ChatGPT or Claude acceptance. Provider acceptance
requires a publicly reachable HTTPS deployment, a real connector setup in each
product, authorization/consent, private reads, a permitted write with API state readback,
insufficient scope, expired assurance, revocation and reconnect, recorded with
dates, product plan and deployed revision in the delivery record.
