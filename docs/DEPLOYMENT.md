# Deployment

AI Skills Share is a Node/Postgres application with object storage for package artifacts. The production path is container-first:

- `api`: Fastify API and auth boundary.
- `web`: static Vite build served by nginx.
- `mcp-http`: optional stateless Streamable HTTP MCP adapter.
- `postgres`: system of record.
- S3-compatible object storage: managed S3/R2/etc. or the single-host MinIO service in the example Compose file.

## Local Docker Dependencies

For development, use the root `docker-compose.yml` only for dependencies:

```bash
npm install
cp .env.example .env
npm run docker:up
npm run db:migrate
npm run db:seed
npm run dev:api
npm run dev:web
```

That flow uses development defaults and is not a production deployment.

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

After the first successful owner bootstrap, rotate the owner password from the application and remove `SEED_OWNER_PASSWORD` from the production env file or secret store. Do not keep bootstrap credentials around as an operational login path.

To run the optional HTTP MCP adapter:

```bash
docker compose --env-file .env.production -f docker-compose.production.example.yml --profile mcp up -d mcp-http
```

The MCP HTTP service requires explicit `AI_SKILLS_MCP_ALLOWED_HOSTS` when bound to `0.0.0.0`.

## Reverse Proxy And TLS

Terminate TLS in front of the `web`, `api`, and optional `mcp-http` services. The example Compose file exposes local host ports for that reverse proxy to consume; it does not publish TLS itself.

Required public values:

- `APP_BASE_URL`: HTTPS web origin used in email verification and password-reset links.
- `VITE_API_BASE_URL`: HTTPS API origin baked into the web image at build time.
- `ALLOWED_WEB_ORIGINS`: comma-separated browser origins allowed to call the API.

If `VITE_API_BASE_URL` changes, rebuild the `web` image because Vite embeds that value during the build.

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
- console or disabled auth notification delivery
- unsafe SMTP TLS settings
- DB-backed artifact storage in production
- incomplete object-storage credentials
- placeholder/example secrets or domains
- public MCP bind without allowed hosts

The API also enforces critical production checks at runtime. The preflight exists so operators fail before a container enters a restart loop.

## Managed Container Targets

For a managed target, use the same images and split services:

- Run `api` as a private or public Node container with `PORT=3001`.
- Run `web` as a static container or upload `apps/web/dist` to a static host/CDN.
- Run `node apps/api/dist/db/migrate.js` as a release job before API rollout.
- Run `node apps/api/dist/db/seed.js` only once for first-owner bootstrap.
- Use managed Postgres for `DATABASE_URL`.
- Use managed S3-compatible object storage for artifacts.
- Use a transactional SMTP provider for auth action delivery.
- Put TLS and request logging at the platform ingress layer.

Minimum smoke checks after deployment:

```bash
curl https://api.example.com/health
curl https://api.example.com/v1/skills
curl https://skills.example.com/health
```

Then sign in as the seeded owner, enable MFA, rotate the bootstrap password, create an API token with `skills:read`, and verify the CLI and MCP surfaces against the deployed API.
