# Railway Deployment

Version: 0.1.0-beta.19
Last updated: 2026-09-30

This is the deployment runbook for the owner-controlled public beta at `myskills.sh`.
Production remains beta.16; its delivery is tracked in [Beta.16 Release Delivery](BETA16_RELEASE_DELIVERY.md).
The historical operational beta evidence remains in [Operational Beta Delivery](OPERATIONAL_BETA_DELIVERY.md).

## Phase-1 beta.18 staging

On 30 September 2026, `beta2-staging` API, web and MCP were deployed from
`14970ba10a67f7372b713a3c29a17b8b72d91a24`. Matching API/web identity,
156 compiled MCP files, the OAuth schema and six routing checks were verified.
The web build was redeployed after final API readiness to recover from stale
nginx upstream resolution. See [Beta.18 staging evidence](BETA18_RELEASE_DELIVERY.md#phase-1-staging-evidence)
for exact deployments, the failed first check and successful recovery.

Collections and migration `0036_library_selections` are absent from that
staging deployment. Final-candidate staging and real ChatGPT/Claude acceptance
remain pending. Production was not changed by this rollout.

<a id="current-beta16-deployment"></a>

## Current beta.16 production and prior staging

On 29 September 2026, staging and production were promoted from frozen source
`acfb7c8c7f8bc560f6fdba13cf0414033ab6d00e` in API-ready-then-web order.
Later GitHub authentication and team Library changes on main are excluded.

| Environment | API deployment | Web deployment |
| --- | --- | --- |
| Staging on 29 September (superseded above) | `70461dc1-e6b7-4146-9633-07bc5ccdb73f` | `88d64e2b-ad6e-403a-a38c-5998dfc4b7d1` |
| Production | `96e7dc80-b1c4-43ad-a9c1-6d8465f55b30` | `ca6d4399-0cae-4f72-af9e-943ef43ebfc5` |

All four reported SUCCESS, beta.16, and the frozen source revision. Each environment
passed 21 HTTP checks. Production CLI doctor passed nine checks with the existing
MFA-verified Keychain session. Desktop browser acceptance preserved owner/MFA
authentication and verified inventory details, setup commands, and an existing
private exact-release package preview. The production log sample contained
73 API and 80 web lines, including 54 nginx notices, with zero application fault matches.

The completed recovery point from `2026-09-28T16:02:16.488Z` passed the 26-hour
freshness policy. No restore is claimed. Retain forward migration
`0034_observation_slug_privacy` and applied history; use a tested forward fix.
The beta.15 deployment pair below remains a historical recovery reference,
not verified downgrade compatibility with the migrated schema.

## Historical beta.15 deployment

On 28 September 2026, staging and production were promoted from
`0415a160b56dac79900a698c8d378e7083ecd194` in API-ready-then-web order.
Saved branding now updates the browser tab title and favicon. No migration is required.

| Environment | API deployment | Web deployment |
| --- | --- | --- |
| Staging | `9caf12a6-70f3-46d6-905d-53c11744bb33` | `9626c294-ca19-44d4-960f-a95149bf99cd` |
| Production | `f6ee1ba4-7af7-4dae-91dc-2f9e4fb97d70` | `1d62e0c0-0616-4c0a-8bf8-79c741d0cbe0` |

All four report SUCCESS, beta.15 and the same source revision. Each environment
passed 19 HTTP checks and fresh CLI doctor/catalog checks. Production retained
the owner/MFA session and rendered private package contents. Its browser title
matches the preserved saved custom text; the default favicon remains
because no custom logo is saved. The recovery point from
`2026-09-27T16:01:29.347Z` passed the 26-hour freshness policy before promotion.
Rollback uses the matching beta.14 pair below while retaining all application data.
See the delivery record for verification, archive checksums and cache limitations.

## Historical beta.14 deployment

On 28 September 2026, staging and production were promoted from
`5647be19f15a8f9bb2c6b0ecfb067478b7528ed0` in API-ready-then-web order.
The release adds owner/admin branding controls and includes beta.13 QR enrollment.
No schema migration is required.

| Environment | API deployment | Web deployment |
| --- | --- | --- |
| Staging | `04ce1ef7-dfa9-4196-a7d4-c4a3d3e02340` | `7a449630-fd97-4ad1-befb-5dacb63084ee` |
| Production | `2ced5023-8288-4864-b9c5-87b550cb7362` | `be0c3cc6-037e-4e91-813f-b1347745d678` |

All four report SUCCESS, beta.14 and the same source revision. Each environment
passed 19 HTTP checks and fresh CLI doctor/catalog checks. Production retained
the owner/MFA session and rendered private package contents. Live branding
preview/discard passed; saved settings remained at their existing defaults.
The completed recovery point from `2026-09-27T16:01:29.347Z` passed the 26-hour
freshness policy before promotion. Rollback uses the matching beta.13 API/web
pair below, retaining database and artifact data. See the delivery record for
canonical, tagged, browser and publication evidence and remaining limitations.

## Historical beta.13 deployment

On 28 September 2026, staging and production were promoted from
`48273d5ff401ddcfd9046c448b1b38a58ee12337` in API-ready-then-web order.
The release adds local authenticator enrollment QR codes without a schema change.

| Environment | API deployment | Web deployment |
| --- | --- | --- |
| Staging | `6cabe522-353b-462c-9a41-5c8edcf6a7c9` | `eef82722-a4fa-486e-8773-53f3d2f401ed` |
| Production | `89cc870c-a3bb-4f2f-a2b0-d1defa931a98` | `2d47a504-8b65-4d5d-b38f-2a96db71842d` |

All four deployments report SUCCESS, beta.13 and the same revision. Direct and
same-origin API checks, HTML revalidation, fresh CLI checks and live Comet
authentication/package inspection passed. Production's existing owner session
and enabled MFA were preserved. The completed recovery point from
`2026-09-27T16:01:29.347Z` passed the 26-hour policy before promotion.

Rollback uses the matching maintenance pair below at source
`d8775d6b07e2de06b7af4cbdc6bee1a33455902d`: API
`49a2bc94-2db8-432f-8611-4339c2cdd124`, web
`77bf8274-c816-4095-ba14-38ad3c061f9b`. Retain database and artifact data.
Physical authenticator-app scans remain unverified in issue #49; no live account
MFA enrollment was performed. See the delivery record for checks and limitations.

## Historical beta.12 maintenance deployment

On 28 September 2026, staging and production were promoted from
`d8775d6b07e2de06b7af4cbdc6bee1a33455902d` in API-ready-then-web order.
This includes [PR #96](https://github.com/jremick/myskills/pull/96), the
auth-outbox timing repair in [PR #100](https://github.com/jremick/myskills/pull/100),
and Nodemailer 10 with bundled types in
[PR #68](https://github.com/jremick/myskills/pull/68). All 11 merged-source check
runs passed, including both supported Node versions and Railway image builds.

| Environment | API deployment | Web deployment |
| --- | --- | --- |
| Staging | `c6c4e18a-c51f-498e-b2fb-e4858c0c8b53` | `f179931b-616e-4c94-99e2-87b812c77eaf` |
| Production | `49a2bc94-2db8-432f-8611-4339c2cdd124` | `77bf8274-c816-4095-ba14-38ad3c061f9b` |

All four deployments report SUCCESS and beta.12 with the source revision above.
Each environment passed 14 direct API, same-origin API and web checks, fresh CLI
doctor and catalog checks, and rendered package inspection. Staging authenticated
login, library reads, package delivery and logout passed. Its private Mailpit
service captured the password-reset notification with the expected staging link
and fragment token. This verifies SMTP capture, not external inbox delivery;
no password was changed.

The existing production owner session survived reload. Its private package export
downloaded four files in a 17,300-byte bundle whose SHA-256 matched the prior
verified package. Anonymous access to that exact release returned 404. Sampled
runtime logs contained no application fault patterns: 45 API and 83 web lines.

The completed recovery point from `2026-09-27T16:01:29.347Z` passed the 26-hour
freshness policy before promotion. This was a freshness check, not a restore.
The matching rollback source is `3834acedf495d16bd54a3562ba214953dc212069`,
previously served by API `1d946f1b-4716-49d0-98ce-629d860603aa` and web
`e06e9ced-ac88-41f5-a358-4a5d7c29e5d1`. No migration changed between these sources.
Retain data, schema and credentials when rolling back. The beta.12 tag and release
assets are unchanged; npm remains beta.8. Documentation-only commits do not
change the deployed source revision.

## Original beta.12 production promotion

On 27 September 2026, production API `9cf1264b-6903-4806-abed-23a446d580ee`
and web `fb7a2b03-ea8c-4698-84f5-396d5b5c6ccc` succeeded from
`c280795e6f0bd54533514ab6c58af7a584cbd3a4` in API-ready-then-web order.
Both serve beta.12. No schema change or owner seeding was required.

Direct API, web and same-origin identity, health/readiness, catalog views,
existing owner/MFA session, exact private package response and anonymous denial
passed. Live Admin keyboard navigation and account sections passed with no
browser console errors. The fresh CLI passed doctor and anonymous browsing.
The tagged workflow and release-asset checksum checks passed; npm remains beta.8.

The existing completed recovery point passed the 26-hour policy before
promotion. Rollback uses the matching beta.10 API/web source while retaining
its bundle-aware schema and readers. Do not downgrade the database or reseed.
See the delivery record for exact evidence, the superseded beta.11 candidate,
and verification limits. Documentation-only commits do not alter live identity.

## Historical beta.10 production status

On 27 September 2026, production API `a73367e7-94c5-4f31-a6aa-917f8002e5f0`
and web `77cdfa45-cd97-4564-8f34-f4487edfc499` succeeded from
`084b48e4bce0e8693357f7a4f89d7aabf8ff89f4` in API-ready-then-web order.
The additive `0033_skill_bundles.sql` migration ran through normal API startup.
Direct API, web and same-origin identity, health/readiness, catalog views,
preserved owner session, private export response and anonymous denial passed.
The fresh beta.10 CLI passed doctor and anonymous bundle browsing. GitHub assets
are published with verified checksums; npm remains beta.8.

The existing recovery point passed the 26-hour freshness policy before
promotion. No new capture or restore is claimed. After bundle references exist,
retain the beta.10 Library reader: disable bundle discovery/writes with
`MYSKILLS_BUNDLES_ENABLED=false` and fix forward. Do not downgrade to beta.9 or
remove bundle tables. See the delivery record for exact evidence and limits.

## Historical beta.9 production status

On 27 September 2026, production API `7ccb9f32-10bf-4efa-8f24-fcad805e6476`
and web `d8e6fc04-d028-4579-aaaa-c69af7758394` succeeded from
`4e728b16cc04f11faa7e23ad0657913b67f50577` in API-ready-then-web order.
Direct API, web, same-origin API and www version responses matched beta.9 and
that revision. Health, readiness, cache headers, preserved owner/MFA session,
private export, anonymous denial and CLI doctor checks passed. The new homepage
and enabled admin setting rendered correctly. No migration was required.

The existing 26 September recovery point passed the 26-hour freshness policy
before promotion. No new capture or restore is claimed. The beta.8 pair below
remains the application rollback target. GitHub release assets are published
with verified checksums; npm remains beta.8. Documentation-only follow-up commits
do not change the deployed source revision.

## Historical beta.8 production status

On 26 September 2026, production API `fca21294-e5ee-414f-91b8-cc612e4e6203`
and web `a53c83e5-33e3-45b4-98f2-b8d8828b221a` succeeded from
`55849876639fbb55167496051bd8d573b5a6a6af` in API-ready-then-web order.
Direct, web and same-origin version readbacks matched beta.8 and that revision.
Readiness, both additive 0032 migrations, preserved owner session, private
export, anonymous access boundaries and fresh CLI archive checks passed.
Private import self-review remains disabled. Staging passed all three deployed
browser/API/CLI journeys on the same candidate. See the delivery ledger for
backup, artifact, test, log and residual-risk evidence. GitHub archives are
published. npm beta.8 is also published, with matching archive bytes and fresh
exact-version and `@beta` installs verified; `latest` and `alpha` are unchanged.

## Historical beta.7 baseline

Beta.7 staging API `fabeef83-d999-4c46-aac8-1b026a88e52f` and web
`af63dfdc-54a0-40fe-ab6c-a48d3f6866ce` both succeeded from candidate
`6912d3f9490c6f002431f3064e8a9db417df3d7f`; direct, web, and same-origin
version readbacks matched that revision. The beta.7 candidate was promoted to
production after a clean beta.5 preflight. Beta.7 production API `0b190296-e8ce-4d55-ac51-b4ea63e7b3b6` and
web `6478cfac-ca56-4610-8618-e23494dae5a8` both succeeded in API-ready-then-web
order from the same candidate.

## Historical beta.5 production baseline

Final beta.5 application source is `d8c7179789bdbf0930fe0e496081377f6c63cd20`,
including the HTML cache fix from [PR #57](https://github.com/jremick/myskills/pull/57).
Required main CI, final staging deployment, and its complete acceptance journey
passed. Final production deployments, readiness, browser checks, HTML cache
behavior, and log review passed. The operational beta is live with the limits
recorded in the delivery ledger.
A later documentation-only commit does not change the deployed application's
embedded source revision.

## Beta.7 staging status

The beta.7 staging readback on 25 September 2026 returned HTTP 200 for API
readiness, API and web version identity, web health, same-origin readiness,
capabilities, and the public root and registry pages. The API, web, and
same-origin version responses all reported version `0.1.0-beta.7` and revision
`6912d3f9490c6f002431f3064e8a9db417df3d7f`.

Public catalogue rendering, a version selector showing one visible version,
literal package text rendering, and Windows CLI `doctor`, `export`, `validate`,
and `scan` checks passed. Historical-version selection was not tested.
Anonymous `/v1/mcp/session` returned the expected `401 AUTHENTICATION_REQUIRED`
response. Owner recovery through normal private Mailpit succeeded, and only the
replacement Keychain was used. Fresh API password login, native Comet owner
login, and temporary owner MFA acceptance login and cleanup passed. The final
Windows API/CLI acceptance passed 20 real checks with zero supplied-session
cleanup failures. Separate native Comet proof covered owner login,
temporary-MFA session invalidation, exact release/version notes, literal
`SKILL.md`, and revoked-version denial. The stale continuation marker means no
continuous role-browser suite is claimed. The beta.5 production deployments
and source listed below are historical; the beta.7 production readback follows.

## Beta.7 production status

The readback at `2026-09-25T07:35:45Z` reported version `0.1.0-beta.7` and
revision `6912d3f9490c6f002431f3064e8a9db417df3d7f` through the API, web, and
same-origin identity responses. Readiness and health passed; HTML returned
`no-cache` and version responses returned `no-store`.

Native production browser checks passed: the existing signed-in owner
session survived reload, private exact-version selection showed literal package
files, anonymous public version selection and files were available, and private
exact-version denial did not fall back. A separate authenticated Export action
from My submitted skills downloaded the existing private release as a JSON
bundle. The saved 17,300-byte bundle contained four files; its manifest matched
the selected name, version, and private visibility. Its SHA-256 was recorded in
the private evidence. The browser download-event wait timed out, so completion
was verified from the native saved file. Production audit
checks for migrations, error logs, and CLI also passed. The audit recorded API
`SUCCESS`/`RUNNING` on schema 32 with migrations `0029`-`0031` applied, 43
runtime log lines, and zero error lines. The Windows CLI readback verified the
beta.7 TGZ with `doctor`, exported `release-notes-helper` 0.1.0, and passed
`validate` and `scan` on two files totaling 428 bytes with no findings.

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
- `registry-backup`: private daily backup job built from `Dockerfile.backup`,
  with `RAILWAY_DOCKERFILE_PATH` set explicitly; schedule 16:00 UTC after a
  successful stored-set recovery drill.
- `registry-backups`: separate private Storage Bucket for coordinated database
  and artifact recovery sets. See [Coordinated registry backups](BACKUPS.md).

The optional HTTP MCP service is deployed only in `beta2-staging`, built from
`Dockerfile.mcp`, with OAuth enabled for the phase-1 revision above. Production
remains on the beta.16 service set. Real ChatGPT/Claude acceptance is pending.
The enablement, verification and rollback steps are in
[Remote MCP connections](MCP_CONNECTIONS.md#railway-runbook).
Web images now read `MCP_PROXY_TARGET` (default `http://127.0.0.1:3002`); leave
it unset until the MCP service exists, because nginx resolves it at startup.

`Dockerfile.api` and `Dockerfile.web` are the current Railway image sources. CI and release verification build those exact files in addition to the root multi-target `Dockerfile` used by the production Compose example. The root, API, and web Dockerfiles default to Node 22; the backup Dockerfile pins Node 24. CI verifies both supported Node lines. Production starts use injected variables and do not copy the local `.env` into images. These source defaults do not establish the runtime version of an earlier deployment.

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
follow-up then captured and restored an exact retained remote set and passed
recovered API checks. Daily scheduling is enabled. Deployment
`1309565e-756e-4efc-ae47-13a373da239f` is `SUCCESS`/`cronReady`; the first
clock-triggered run remains pending. See [the backup record](BACKUPS.md#live-beta-record-5-september-2026)
for timings, image identity, monitoring, and remaining limits. API/web were not redeployed.

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

1. Keep feature work on a branch and require the protected checks (`local-ci/check`, `local-ci/web-e2e` and `local-ci/postgres-integration` after cutover) to pass; see [Local CI](LOCAL_CI.md).
2. Merge or fast-forward the Railway-connected branch after the rendered checks pass. Verify the required checks for the exact merged source before promotion, and capture a current database-and-artifact recovery point.
3. When changing artifact publication or cleanup coordination, remove incompatible API writers and cleanup workers before starting the replacement. For Libraries beta.8, drain beta.7 API instances and workers before accepting library writes; older code does not enforce private-attestation and library-binding guards. Follow the [Libraries rollback boundary](RELEASE.md#libraries-beta8-compatibility-boundary). Account for the resulting API interruption in the rollout plan.
4. Deploy `api` from the approved commit and wait for Railway success and direct `/ready` before uploading `web` from the same commit. The web proxy must start after the healthy API so it does not retain an address for a retiring private instance.
5. Compare direct API, web, and proxy `/version.json` with the approved source. Verify web health and same-origin `/api/health` and `/api/ready`.
6. Complete staging's real browser/CLI journey before production. After production promotion, verify HTML revalidation in an existing browser cache, existing-session auth, authorized private package delivery, anonymous denial, rendered package text and navigation, and recent logs. Use a fresh context for anonymous checks and preserve existing user sessions during verification. Use read requests for production checks; package access still writes its normal audit events.

Release verification (`scripts/local-ci.sh release-check`, and the tag workflow while it remains) is intentionally verification-only and does not deploy Railway. Follow the staging, production approval, and rollback boundary in [Release Process](RELEASE.md). Any future deploy automation must use scoped project credentials, preserve a separate staging/user-test step, require explicit production approval, deploy API and web from the same commit in API-ready-then-web order, and report resulting deployment IDs plus direct and same-origin health/browser readback.
