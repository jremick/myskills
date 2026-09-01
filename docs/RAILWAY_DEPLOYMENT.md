# Railway Deployment

Version: 0.1.0-beta.4
Last updated: 2026-08-30

This is the maintained deployment runbook for the owner-controlled public beta at `myskills.sh`. Live Railway readback on 2026-07-13 showed beta.2 commit `b69dd5e`: API deployment `ef995431-ae75-461b-b05c-b1a486cc03c9` and web deployment `97ae81a3-dcf9-42b1-b120-9b62d2cd9b79`. Re-check deployment IDs and commit IDs before making a current-state claim.

## Railway Project

- Workspace: `Jarel Remick`
- Project: `myskills-app`
- Project ID: `ab397602-ce54-43e4-9b96-2bc5217d24fe`
- Environment: `production`

Do not deploy this project into any team or work Railway workspace.

## Services

- `web`: Vite browser assets served by nginx with an `/api` proxy. The live service builds `Dockerfile.web`.
- `api`: Fastify API deployed separately from the same project source/commit. The live service builds `Dockerfile.api`.
- `Postgres`: managed Railway Postgres.
- `artifacts`: Railway Storage Bucket for S3-compatible package artifact storage.

The optional HTTP MCP service is not part of the maintained live beta service set.

`Dockerfile.api` and `Dockerfile.web` are the current Railway image sources. CI and release verification build those exact files in addition to the root multi-target `Dockerfile` used by the production Compose example. All three build app workspaces with Node 22 LTS; production starts use injected variables and do not copy the local `.env` into images.

## Live Production Readback

As of the 2026-07-13 readback:

- The API service uses `/ready` with a 300-second deployment timeout; the web service uses `/health` with the same timeout.
- The API used `TRUST_PROXY=1` at this readback. Fastify 5.12.1 later disabled numeric hop-count trust; migrate this value to the address-aware setting below before deploying that upgrade.
- API and web run the same approved beta.2 release commit and report successful deployment status.
- A locked manual Postgres volume backup named `pre-v0.1.0-beta.2-2026-07-13` is the database rollback point for this promotion.

The previous beta.1 API deployment `accf248a-6a1d-432d-b3cd-710430fb9c75` and web deployment `ba82d0c3-629b-480e-b436-fa4054b0866e` remain redeployable application rollback targets. Database migrations are forward-only unless the explicit backup-restore path and accepted data-loss boundary are approved.

## Domains

- `myskills.sh` -> `web`
- `www.myskills.sh` -> `web`
- `api.myskills.sh` -> `api`

The web build must receive `VITE_API_BASE_URL=/api` so browser auth and registry requests stay same-origin on `myskills.sh`.
The web runtime must receive `API_PROXY_TARGET=https://api.myskills.sh` so nginx forwards `/api/*` to the API service without requiring the user's browser DNS cache to resolve `api.myskills.sh`.
The API must receive `APP_BASE_URL=https://myskills.sh`, `ALLOWED_WEB_ORIGINS=https://myskills.sh,https://www.myskills.sh`, and an address-aware `TRUST_PROXY` value so auth rate limits use the forwarded client IP from Railway/nginx. Railway's current proxy guidance uses private ranges plus `100.0.0.0/8`; re-check that guidance when the platform topology changes.
The Railway nginx template sets `client_max_body_size 14m` so valid bounded package uploads reach the API; do not remove it or fall back to nginx's 1 MiB default.

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
- `TRUST_PROXY=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7,100.0.0.0/8`
- `AUTH_NOTIFICATION_MODE=resend`
- `RESEND_API_KEY`
- `RESEND_FROM=MySkills <noreply@jarel.app>`
- `ARTIFACT_STORAGE_MODE=s3`
- `S3_ENDPOINT`
- `S3_REGION`
- `S3_BUCKET`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`
- `S3_FORCE_PATH_STYLE`

`S3_ENDPOINT` must use HTTPS in production. Only set `S3_ALLOW_INSECURE_ENDPOINT=true` for an explicitly trusted private-network object store; do not use it for internet-routable endpoints.

SMTP remains supported for self-hosted deployments, but the Railway production deployment should use Resend's HTTPS API because outbound SMTP depends on Railway plan/network restrictions. The hosted beta keeps registration owner-controlled; public account email flows should not be opened until delivery and abuse controls are explicitly approved and verified.

## Resend Setup

1. Use a verified sender domain in Resend for MySkills auth email.
2. Keep `RESEND_FROM=MySkills <noreply@your-domain.example>` in the Railway API service.
3. Create a dedicated send-only Resend API key named `MySkills Railway production`.
4. Set Railway API variables: `AUTH_NOTIFICATION_MODE=resend`, `RESEND_API_KEY`, and `RESEND_FROM=MySkills <noreply@your-domain.example>`.
5. Redeploy the `api` service and request a password reset for the configured owner account to verify delivery.

## Staging Email Isolation

Never copy the production Resend key into a staging environment. Use either a dedicated staging send-only key or a private, non-forwarding SMTP capture service such as Mailpit on the staging environment's private network. A capture service can prove message content, action-link construction, token expiry/single use, and browser completion without contacting real recipients; it does not prove Resend acceptance, sender verification, inbox placement, or external deliverability.

Keep staging on `NODE_ENV=production`. Do not enable console notification delivery to work around email configuration because console delivery logs raw action links, and do not expose the capture service publicly. Remove the production `RESEND_API_KEY` and `RESEND_FROM` references from staging before applying isolated SMTP settings.

## First Owner Bootstrap

Use only for the initial seed, then remove the bootstrap password from Railway variables after the owner account is confirmed.

- `SEED_OWNER_EMAIL=owner@your-domain.example`
- `SEED_OWNER_PASSWORD=<temporary strong password>`

Run:

```bash
node apps/api/dist/db/migrate.js
node apps/api/dist/db/seed.js
```

After bootstrap:

1. Sign in as the configured `SEED_OWNER_EMAIL`.
2. Enable MFA for the owner account.
3. Rotate the bootstrap password.
4. Remove `SEED_OWNER_PASSWORD` from Railway variables after owner login is verified.
5. Keep owner account status, credential storage, and MFA progress in private operational notes, not in this public deployment guide.

## Smoke Checks

```bash
curl https://api.myskills.sh/health
curl https://api.myskills.sh/ready
curl https://api.myskills.sh/v1/skills
curl https://myskills.sh/health
curl https://myskills.sh/api/health
curl https://myskills.sh/api/ready
```

During DNS cache propagation, use a public DoH resolver for deterministic checks:

```bash
curl --doh-url https://cloudflare-dns.com/dns-query https://myskills.sh/health
curl --doh-url https://cloudflare-dns.com/dns-query https://api.myskills.sh/health
curl --doh-url https://cloudflare-dns.com/dns-query https://api.myskills.sh/ready
```

## Iteration Deployment Loop

The current live project is intentionally manual but can be made easier without changing hosting providers:

1. Keep feature work on a branch and require GitHub CI to pass.
2. Merge or fast-forward the Railway-connected branch only after the rendered local checks pass.
3. Deploy the `api` service from the approved commit and wait for Railway to report a successful deployment.
4. Verify the direct API `/ready` endpoint before deploying `web` from the same commit. Do not replace API and web concurrently: the web proxy must start after the healthy API deployment so it does not retain an address for a retiring private instance.
5. Verify the web service plus same-origin `/api/health` and `/api/ready`, then run a browser login/export check before calling the iteration live.

The release workflow is intentionally verification-only and does not deploy Railway. Follow the staging, production approval, and rollback boundary in [Release Process](RELEASE.md). Any future deploy automation must use scoped project credentials, preserve a separate staging/user-test step, require explicit production approval, deploy API and web from the same commit in API-ready-then-web order, and report resulting deployment IDs plus direct and same-origin health/browser readback.
