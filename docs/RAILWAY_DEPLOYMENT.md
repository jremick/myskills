# Railway Deployment

Version: 0.1.0-alpha.0
Last updated: 2026-06-14

This is the first live deployment shape for `myskills.sh`.

## Railway Project

- Workspace: `Jarel Remick`
- Project: `myskills-app`
- Project ID: `ab397602-ce54-43e4-9b96-2bc5217d24fe`
- Environment: `production`

Do not deploy this project into any team or work Railway workspace.

## Services

- `web`: static Vite landing page and owner-gated registry shell. The current live service builds from the root `Dockerfile` web stage.
- `api`: Fastify API. The current live service is deployed separately from the same project source.
- `Postgres`: managed Railway Postgres.
- `artifacts`: Railway Storage Bucket for S3-compatible package artifact storage.

The optional HTTP MCP service is intentionally not part of the first public private-development launch.

`Dockerfile.web` and `Dockerfile.api` are dedicated service variants kept in the repo for a future split-Dockerfile Railway configuration. Keep the root `Dockerfile` web stage aligned with `Dockerfile.web` while Railway reports `/Dockerfile` as the active web build path.

## Domains

- `myskills.sh` -> `web`
- `www.myskills.sh` -> `web`
- `api.myskills.sh` -> `api`

The web build must receive `VITE_API_BASE_URL=/api` so browser auth and registry requests stay same-origin on `myskills.sh`.
The web runtime must receive `API_PROXY_TARGET=https://api.myskills.sh` so nginx forwards `/api/*` to the API service without requiring the user's browser DNS cache to resolve `api.myskills.sh`.
The API must receive `APP_BASE_URL=https://myskills.sh` and `ALLOWED_WEB_ORIGINS=https://myskills.sh,https://www.myskills.sh`.

## Required Web Variables

- `VITE_API_BASE_URL=/api`
- `API_PROXY_TARGET=https://api.myskills.sh`

Optional privacy-preserving analytics:

- `VITE_ANALYTICS_DOMAIN=myskills.sh`
- `VITE_ANALYTICS_SCRIPT_URL=https://plausible.io/js/script.js`

Leave analytics variables unset when the deployment should not load a third-party analytics script. The web app only injects the script in production builds when `VITE_ANALYTICS_DOMAIN` is present.

## Required API Variables

Set these in Railway secret/config variables, not in repo files:

- `NODE_ENV=production`
- `HOST=::`
- `PORT=3001`
- `DATABASE_URL=${{Postgres.DATABASE_URL}}`
- `AUTH_SECRET`
- `TOTP_ISSUER=MySkills`
- `APP_BASE_URL=https://myskills.sh`
- `ALLOWED_WEB_ORIGINS=https://myskills.sh,https://www.myskills.sh`
- `AUTH_NOTIFICATION_MODE=resend`
- `RESEND_API_KEY`
- `RESEND_FROM=MySkills <noreply@myskills.sh>`
- `ARTIFACT_STORAGE_MODE=s3`
- `S3_ENDPOINT`
- `S3_REGION`
- `S3_BUCKET`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`
- `S3_FORCE_PATH_STYLE`

SMTP remains supported for self-hosted deployments, but the Railway production deployment should use Resend's HTTPS API because outbound SMTP depends on Railway plan/network restrictions. The private-development deployment currently keeps registration closed; public account email flows should not be opened until Resend delivery is fully configured and verified.

## Resend Setup

1. Add and verify the `myskills.sh` domain in Resend.
2. Add the DNS records Resend returns to the `myskills.sh` DNS provider.
3. Create a dedicated send-only Resend API key named `MySkills Railway production`.
4. Set Railway API variables: `AUTH_NOTIFICATION_MODE=resend`, `RESEND_API_KEY`, and `RESEND_FROM=MySkills <noreply@myskills.sh>`.
5. Redeploy the `api` service and request a password reset for `jremick@jremick.com` to verify delivery.

## First Owner Bootstrap

Use only for the initial seed, then remove the bootstrap password from Railway variables after the owner account is confirmed.

- `SEED_OWNER_EMAIL=jremick@jremick.com`
- `SEED_OWNER_PASSWORD=<temporary strong password>`

Run:

```bash
node apps/api/dist/db/migrate.js
node apps/api/dist/db/seed.js
```

After bootstrap:

1. Sign in as `jremick@jremick.com`.
2. Enable MFA.
3. Rotate the bootstrap password.
4. Keep `SEED_OWNER_PASSWORD` out of the Railway API service.

Current status:

- `jremick@jremick.com` is seeded as the active owner.
- The bootstrap password is stored in macOS Keychain under service `myskills.sh/seed-owner-password`.
- `SEED_OWNER_PASSWORD` has been removed from Railway variables after owner login was verified.
- Admin endpoints require MFA, so MFA enrollment is the next owner-account hardening step.

## Smoke Checks

```bash
curl https://api.myskills.sh/health
curl https://api.myskills.sh/v1/skills
curl https://myskills.sh/health
curl https://myskills.sh/api/health
```

During DNS cache propagation, use a public DoH resolver for deterministic checks:

```bash
curl --doh-url https://cloudflare-dns.com/dns-query https://myskills.sh/health
curl --doh-url https://cloudflare-dns.com/dns-query https://api.myskills.sh/health
```

## Iteration Deployment Loop

The current live project is intentionally manual but can be made easier without changing hosting providers:

1. Keep feature work on a branch and require GitHub CI to pass.
2. Merge or fast-forward the Railway-connected branch only after the rendered local checks pass.
3. Redeploy the `api` and `web` Railway services from the same commit.
4. Run the smoke checks above and a browser login/export check before calling the iteration live.

Next automation target: a GitHub Actions workflow that runs `npm run check`, deploys the Railway services with scoped Railway project tokens, and reports the resulting deployment URLs and health checks back to the pull request.
