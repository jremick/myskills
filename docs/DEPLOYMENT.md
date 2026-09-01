# Deployment

Version: 0.1.0-beta.4
Last updated: 2026-07-13

MySkills is a Node/Postgres application with object storage for package artifacts. The production path is container-first:

- `api`: Fastify API and auth boundary.
- `web`: static Vite build served by nginx.
- `mcp-http`: optional stateless Streamable HTTP MCP adapter.
- `postgres`: system of record.
- S3-compatible object storage: managed S3/R2/etc. or the single-host MinIO service in the example Compose file.

## Local Docker Dependencies

For development, use the root `docker-compose.yml` only for dependencies. The normal migrate, seed, API, web, and MCP dev scripts load the root `.env` automatically:

```bash
npm install
cp .env.example .env
npm run docker:up
npm run db:migrate
npm run db:seed
```

Then run `npm run dev:api` and `npm run dev:web` in separate terminals. That flow uses development defaults and is not a production deployment. See [Getting Started](GETTING_STARTED.md) for the complete first-run smoke.

## Production Compose

The production example builds app images from this repo and runs API, web, Postgres, MinIO, migrations, and optional MCP HTTP.

```bash
cp .env.production.example .env.production
# Edit .env.production. Replace every example domain and secret.
npm run check:prod-env -- --env-file .env.production --require-seed
docker compose --env-file .env.production -f docker-compose.production.example.yml build
docker compose --env-file .env.production -f docker-compose.production.example.yml run --rm migrate
docker compose --env-file .env.production -f docker-compose.production.example.yml --profile bootstrap run --rm seed
docker compose --env-file .env.production -f docker-compose.production.example.yml up -d api web
```

Use `docker compose --env-file .env.production -f docker-compose.production.example.yml config` after editing the env file to validate Compose interpolation before building images.

After the first successful owner bootstrap, rotate the owner password from the application and remove `SEED_OWNER_PASSWORD` from the production env file or secret store. Do not keep bootstrap credentials around as an operational login path.

To run the optional HTTP MCP adapter:

```bash
docker compose --env-file .env.production -f docker-compose.production.example.yml --profile mcp up -d mcp-http
```

The MCP HTTP service requires explicit `MYSKILLS_MCP_ALLOWED_HOSTS` when bound to `0.0.0.0`.

## Reverse Proxy And TLS

Terminate TLS in front of the `web` and optional `mcp-http` services. The production Compose example deliberately does not publish the API to a host port: browser and authenticated API traffic enters through the web service's same-origin `/api` proxy, and nginx reaches `api:3001` over the private Docker network. Point the public reverse proxy at `WEB_PORT`; do not create a second public route to the API.

Required public values and routes:

- `APP_BASE_URL`: HTTPS web origin used in email verification, password-reset, and registration-invitation links.
- `VITE_API_BASE_URL`: browser API base baked into the web image at build time. The Compose example uses `/api` so browser requests stay same-origin.
- `API_PROXY_TARGET`: internal API target used by nginx for `/api/*`; the Compose example uses `http://api:3001`.
- `ALLOWED_WEB_ORIGINS`: comma-separated browser origins allowed to call the API.
- `TRUST_PROXY`: trusted proxy IP/CIDR list for forwarded client IP handling. The example trusts the private IPv4 and IPv6 source ranges used by its nginx-to-API path. Numeric hop counts and broad `true` are rejected because they do not validate the connecting proxy address. If the topology changes, re-evaluate the trusted ranges and every reachable API path before deployment.

If `VITE_API_BASE_URL` changes, rebuild the `web` image because Vite embeds that value during the build.

The nginx templates set `client_max_body_size 14m` to match the API's bounded JSON submission envelope (including base64 overhead for the decoded archive limit). Any replacement ingress/proxy must preserve an equivalent or tighter compatible limit; nginx's 1 MiB default will break valid package submission before the API can return its own bounded error.

## Production Safety Gates

Run the preflight before building or deploying:

```bash
npm run check:prod-env -- --env-file .env.production
```

Use `--require-seed` before the first owner bootstrap. The check fails for:

- non-production `NODE_ENV`
- missing or weak `AUTH_SECRET`
- local development database credentials
- non-HTTPS public web/API origins
- wildcard CORS origins
- missing or broad `TRUST_PROXY` configuration
- console or disabled auth notification delivery
- unsafe SMTP TLS settings
- DB-backed artifact storage in production
- incomplete object-storage credentials
- placeholder/example secrets or domains
- public MCP bind without allowed hosts

The API also enforces critical production checks at runtime. The preflight exists so operators fail before a container enters a restart loop.

For the production Compose example, verify the only host-published browser/API port belongs to `web`, then smoke the API through that ingress:

```bash
docker compose --env-file .env.production -f docker-compose.production.example.yml ps
curl "http://127.0.0.1:${WEB_PORT:-3000}/health"
curl "http://127.0.0.1:${WEB_PORT:-3000}/api/health"
curl "http://127.0.0.1:${WEB_PORT:-3000}/api/ready"
curl "http://127.0.0.1:${WEB_PORT:-3000}/api/v1/skills"
```

Do not use a direct `localhost:3001` smoke for this topology; that host route intentionally does not exist.

## Managed Container Targets

For a managed target, use the same images and split services:

- Run `api` as a private or public Node container with `PORT=3001`.
- Run `web` as a static container, or upload `apps/web/dist` to a static host/CDN that can proxy `/api/*` to the API while preserving `Set-Cookie`, `Cookie`, `Host`, `X-Forwarded-Host`, `X-Forwarded-For`, and `X-Forwarded-Proto` headers. Static-only hosting without that same-origin API proxy is sufficient for public browsing but not for authenticated browser flows.
- Run `node apps/api/dist/db/migrate.js` as a release job before API rollout.
- Run `node apps/api/dist/db/seed.js` only once for first-owner bootstrap.
- Use managed Postgres for `DATABASE_URL`.
- Use managed S3-compatible object storage for artifacts.
- Use a transactional email provider for auth action delivery. Resend over HTTPS is preferred on Railway; SMTP remains available for self-hosted environments that can make outbound SMTP connections.
- Put TLS and request logging at the platform ingress layer.

Minimum smoke checks after deployment:

```bash
curl https://api.example.com/health
curl https://api.example.com/ready
curl https://api.example.com/v1/skills
curl https://skills.example.com/health
curl https://skills.example.com/api/health
curl https://skills.example.com/api/ready
```

`/health` proves the process is serving. `/ready` additionally probes Postgres and required artifact storage; use `/ready` for API container/platform healthchecks and promotion decisions.

Then sign in as the seeded owner, enable MFA, rotate the bootstrap password, create an API token with `skills:read`, and verify the CLI and MCP surfaces against the deployed API.

The maintained Railway configuration is documented separately in [Railway Deployment](RAILWAY_DEPLOYMENT.md). Treat that live platform readback—not this generic example—as the source of truth for the current hosted beta.
