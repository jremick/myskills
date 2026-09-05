# Railway Deployment

Version: 0.1.0-beta.5
Last updated: 2026-09-05

This is the deployment runbook for the owner-controlled public beta at `myskills.sh`.
The operational beta candidate is tracked in [Operational Beta Delivery](OPERATIONAL_BETA_DELIVERY.md).
Final beta.5 application source is `d8c7179789bdbf0930fe0e496081377f6c63cd20`,
including the HTML cache fix from [PR #57](https://github.com/jremick/myskills/pull/57).
Required main CI, final staging deployment, and its complete acceptance journey
passed. Final production deployments, readiness, browser checks, HTML cache
behavior, and log review passed. The operational beta is live with the limits
recorded in the delivery ledger.
A later documentation-only commit does not change the deployed application's
embedded source revision.

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
- `registry-backup`: private backup job built from `Dockerfile.backup`; initial
  schedule disabled until the stored-set recovery gate passes.
- `registry-backups`: separate private Storage Bucket for coordinated database
  and artifact recovery sets. See [Coordinated registry backups](BACKUPS.md).

The optional HTTP MCP service is not part of the maintained live beta service set.

`Dockerfile.api` and `Dockerfile.web` are the current Railway image sources. CI and release verification build those exact files in addition to the root multi-target `Dockerfile` used by the production Compose example. All three build app workspaces with Node 22 LTS; production starts use injected variables and do not copy the local `.env` into images.

## Deployment and Recovery Readback

Final deployments from `d8c7179789bdbf0930fe0e496081377f6c63cd20`,
read back on 5 September 2026:

| Environment | API deployment | Web deployment |
| --- | --- | --- |
| Staging | `f69f826e-f71b-4baa-9dcf-3e414be69658` | `1154add2-b701-4bbc-8d40-be52e123f910` |
| Production | `0e8af8f9-c385-4fbd-a236-a05912a59793` | `07c178e6-81d7-4fe6-a239-8a8c9ab16598` |

Staging API/web succeeded at 00:28:06/00:29:22 UTC. Preflight, all 29 migrations,
database instance identity, eight direct API/web/proxy HTTP checks, and the
seven-check HTML header probe passed. The full Comet journey passed 20 checks
in 135 seconds; separate Codex recognition and temporary MFA cleanup passed.
Production API/web succeeded at 00:35:01/00:36:37 UTC; final preflight, headers,
eight identity/health HTTP readbacks, seven HTML/header checks, and all 12
Comet/API checks using read requests passed. The browser checks included private
delivery, literal package text, loaded anonymous mobile registry/skill detail
without horizontal overflow, and preservation of the existing owner session.
There were no browser page errors. The checks sent no fixture or administrative
change requests. Allowed and denied package downloads create normal
`artifact.bundle` audit events in production. Sampled API/nginx logs through
00:37:54 UTC had no actual errors or 5xx. The 54 Railway error-level nginx startup
records were `[notice]` messages.

The API uses `/ready` with a 300-second deployment timeout; web uses `/health`
with the same timeout. Both environments use address-aware `TRUST_PROXY`.
Staging retains its private API proxy upstream; production retains
`https://api.myskills.sh`. Prior deployments were removed. The initial artifact
protocol rollout drained the old production API at 23:41:23 UTC before creating
its replacement at 23:42:05 UTC on 4 September. The compatible cache follow-up
used normal API-ready-then-web order.

Final logical recovery captured at 2026-09-05 00:31:16 UTC verified all 50 tables
at migration 29 and all 87 artifacts in new isolated destinations, with no source
writes. The earlier 32-table copy preceded the first promotion. Earlier isolated
API recovery verified migrations, auth, and package delivery; the final copy did
not repeat that runtime check. A Railway manual Postgres snapshot created at
2026-09-04 23:38:10 UTC was not restored by this work. The recurring backup
follow-up is configured separately and must pass the stored-set recovery gate
before its schedule is enabled. Its operation does not require API/web changes.

Previous deployment IDs:

| Environment and baseline | API deployment | Web deployment |
| --- | --- | --- |
| Staging beta.5, `0d8df1d` | `d0658ae7-4bb8-4c1d-8e31-a03bedc7246a` | `5296a9b9-7ab8-4f52-8d79-71006ea493f0` |
| Production beta.5, `0d8df1d` | `88a5d998-5050-4091-9382-6500585252f2` | `a902f9ee-f403-495a-872a-998308fce7f8` |
| Production beta.2, source unidentified | `5a7470b5-d13d-412f-afec-9cb001bfc45f` | `18f6388a-7aa0-459f-8a6e-9e6b19ca08d2` |

Keep previous deployment IDs for incident investigation. A Railway redeploy
button does not prove that an old application can safely use the current schema
and artifacts. Prefer a tested fix-forward candidate. Before reverting an
application, test that exact application against a copy of the migrated database,
drain incompatible writers and cleanup workers, and verify its required flows.
Database migrations are forward-only; a production restore requires an explicit
recovery point and accepted data-loss boundary. Never use production as a restore
rehearsal destination.

## Domains

- `myskills.sh` -> `web`
- `www.myskills.sh` -> `web`
- `api.myskills.sh` -> `api`

The existing `beta2-staging` environment uses
`web-beta2-staging.up.railway.app` and `api-beta2-staging.up.railway.app`.
Its database, artifact bucket, credentials, and auth secret must remain separate
from production. Keep its private Mailpit capture service off public ingress.

## Deployed Source Identity

Set the non-secret build variable `MYSKILLS_BUILD_REVISION` to the complete
40-character source commit SHA on API and web before uploading a clean checkout.
Use the same source for both deployments. The Docker builds embed the revision
and package version in `/version.json`; the API also serves it through the web
proxy at `/api/version.json`. These responses use `Cache-Control: no-store`.
Changing a runtime variable alone does not change the embedded revision.

Compare all three responses with the approved commit before calling a deployment
verified. A null revision means an unidentified local build and cannot pass live
promotion. `/v1/capabilities` also exposes `instanceId`, a stable database-owned
registry identity used by the CLI to prevent accidental cross-registry updates.
Preserve it when restoring the same registry; it is independent of build revision.

Also verify HTML cache behavior at `/` and a deep link such as `/registry`.
The first beta.5 rollout exposed stale HTML in an existing browser cache despite
current `/version.json` responses. Existing browser sessions must obtain current
HTML through revalidation before the deployment can pass its rendered check.
HTML cached before the fix needs one reload to obtain the new policy; later
navigation must revalidate it. The existing authenticated Codex browser check
passed: one reload loaded the current interface, and subsequent Registry
navigation preserved it and the session without errors.
The cache candidate passed 30 baseline/30 fixed
HTTP response checks, 168 security-header value checks, official entrypoint and
environment substitution, and nginx syntax validation. Static JavaScript/CSS and
API proxy behavior remain unchanged. Final staging and production confirmed
`Cache-Control: no-cache` on HTML 200 and 304 responses and `no-store` on
`/version.json`, with the existing security headers preserved.

The web build must receive `VITE_API_BASE_URL=/api` so browser auth and registry requests stay same-origin on `myskills.sh`.
The web runtime must receive an `API_PROXY_TARGET` that resolves to the API in the same environment. Either a verified private-network upstream or the verified public API URL is supported. Production currently uses `https://api.myskills.sh`; staging uses its own private upstream. Nginx forwards `/api/*` so browser requests remain same-origin. Preserve the verified route during rollout unless an upstream change is separately planned and checked.
The API must receive `APP_BASE_URL=https://myskills.sh`, `ALLOWED_WEB_ORIGINS=https://myskills.sh,https://www.myskills.sh`, and an address-aware `TRUST_PROXY` value so auth rate limits use the forwarded client IP from Railway/nginx. Railway's current proxy guidance uses private ranges plus `100.0.0.0/8`; re-check that guidance when the platform topology changes.
The Railway nginx template sets `client_max_body_size 14m` so valid bounded package uploads reach the API; do not remove it or fall back to nginx's 1 MiB default.

## Required Web Variables

- `VITE_API_BASE_URL=/api`
- `API_PROXY_TARGET` set to this environment's verified API URL; production currently uses `https://api.myskills.sh`.

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

The beta.5 staging readback confirmed private Mailpit delivery and removal of
unused Resend values. The live journey completed captured invitations and
temporary MFA cleanup. It did not send email to external recipients.

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
2. Merge or fast-forward the Railway-connected branch after the rendered checks pass. Verify required CI for the exact merged source before promotion, and capture a current database-and-artifact recovery point.
3. When changing artifact publication or cleanup coordination, remove incompatible API writers and cleanup workers before starting the replacement. Account for the resulting API interruption in the rollout plan.
4. Deploy `api` from the approved commit and wait for Railway success and direct `/ready` before uploading `web` from the same commit. The web proxy must start after the healthy API so it does not retain an address for a retiring private instance.
5. Compare direct API, web, and proxy `/version.json` with the approved source. Verify web health and same-origin `/api/health` and `/api/ready`.
6. Complete staging's real browser/CLI journey before production. After production promotion, verify HTML revalidation in an existing browser cache, existing-session auth, authorized private package delivery, anonymous denial, rendered package text and navigation, and recent logs. Use a fresh context for anonymous checks and preserve existing user sessions during verification. Use read requests for production checks; package access still writes its normal audit events.

The release workflow is intentionally verification-only and does not deploy Railway. Follow the staging, production approval, and rollback boundary in [Release Process](RELEASE.md). Any future deploy automation must use scoped project credentials, preserve a separate staging/user-test step, require explicit production approval, deploy API and web from the same commit in API-ready-then-web order, and report resulting deployment IDs plus direct and same-origin health/browser readback.
