# Self-Hosting And Deployment Investigation

Date: 2026-09-25
Status: source investigation and delivery candidates; no implementation selected.
Roadmap: [HOST-1](ROADMAP.md#self-hosting-and-deployment-host-1).

## Recommendation For Review

Make the existing stack easier to install and operate before changing its
architecture. The strongest first candidate is a versioned container release
bundle plus a small setup and operations helper. Follow with a Railway template
that uses the same artifacts. This should remove source builds and repeated
configuration from routine installation; elapsed-time improvements remain
unmeasured.

Keep PostgreSQL, API-owned authorization, immutable S3 artifacts, and the current
web/API boundary for that first candidate. A combined application image or local
filesystem artifact backend could remove services, but each creates additional
runtime, migration, and recovery work. Decide those separately if packaging alone
does not meet the adoption targets.

## Evidence Boundary

Inspected GitHub main at
[`ce187d2`](https://github.com/jremick/myskills/commit/ce187d2b7e7f58dd0fd4dfcdd05663175e4f597f),
including setup/deployment docs, Compose, Dockerfiles, release workflow, seed and
migration code, storage/preflight contracts, and backup tooling. Official Docker
and Railway documentation was checked on the date above. The earlier
[SkillBox comparison](https://github.com/kitze/skillbox/tree/cda64ad3310abe690c6d497352791da4cfeb9a0a)
informed the onboarding questions.

This investigation did not start containers, provision services, call production,
run paid models, publish images, or measure install/build performance. The
[operational beta ledger](OPERATIONAL_BETA_DELIVERY.md) records earlier runtime
evidence; it is not a fresh verification of the current hosted instance.

## Current Friction And Reusable Foundations

| Finding | Evidence | Implication |
| --- | --- | --- |
| The default first-run guide is a developer workflow: host Node/npm, dependency installation, migrations, seed, and two application terminals. | [Getting Started](GETTING_STARTED.md) | Give evaluators and operators their own container-first entry path; preserve this contributor workflow. |
| Production Compose requires source builds and separate preflight, migration, bootstrap, and startup commands. | [Deployment](DEPLOYMENT.md), [Compose](../docker-compose.production.example.yml) | A release bundle and helper can remove repeated flags and build prerequisites. |
| The tag workflow verifies images but does not publish them. | [Release workflow](../.github/workflows/release.yml), [Release policy](RELEASE.md) | Public image publication and anonymous pull verification are prerequisites, not an existing download capability. |
| App Dockerfiles copy workspace source before `npm ci`. | [Root Dockerfile](../Dockerfile), [API Dockerfile](../Dockerfile.api), [web Dockerfile](../Dockerfile.web) | Source changes invalidate dependency-install layers. Separate workspace manifests/lockfile from source and measure cache reuse. |
| Deployment values overlap: public origin, allowed origins, browser API path, proxy target, storage references, and bootstrap settings. | [Production preflight](../scripts/check-production-env.mjs), [Compose](../docker-compose.production.example.yml) | Derive topology-specific defaults from a few operator choices; validate the resolved configuration without printing secrets. |
| The preflight script is not copied into the final API image. | [API runtime stage](../Dockerfile.api) | Container-only setup needs a deliberately packaged operations command/image; a shell wrapper alone cannot remove the Node prerequisite. |
| Compose uses a migration job; the Railway API start script runs migration and optionally seed at startup. Migration already has a PostgreSQL advisory lock. | [Start script](../deploy/start-api.sh), [migrator](../apps/api/src/db/migrate.ts) | Reuse the lock and migration ledger. Define one owner for migration execution in each deployment path. |
| Seed combines first-owner creation with demo publication and can update existing owner/demo records on rerun. | [Seed implementation](../apps/api/src/db/seed.ts) | Separate first-owner bootstrap from optional demo content before wrapping it in retryable setup. Normal restarts must not re-seed. |
| Production requires S3 artifact storage and SMTP/Resend auth delivery. Database-backed artifacts are rejected in production. | [Storage implementation](../apps/api/src/artifacts/storage.ts), [preflight](../scripts/check-production-env.mjs) | Removing MinIO or email configuration is not currently a safe configuration toggle. Offer existing external S3 explicitly or design a new mode separately. |
| Readiness and dependency ordering already exist. | [Compose](../docker-compose.production.example.yml), [Deployment](DEPLOYMENT.md) | Preserve API `/ready` and web health checks; add a bounded operator-facing completion result. |
| Coordinated database/artifact capture, status, and isolated restore helpers already exist. | [Backups](BACKUPS.md), [backup image](../Dockerfile.backup) | Package the existing recovery path rather than introduce an unrelated backup format. |

## Candidate Delivery Slices

These are candidates for the roadmap review, not committed release order. The
dependencies identify what must precede each usable outcome.

### H1: Versioned Images And Release Bundle

Publish API, web, optional HTTP MCP, and operations/backup artifacts from an
approved release. Provide one manifest that binds their versions, source identity,
platforms, and image digests. A matching Compose bundle should default to pulling
those images, with a documented source-build path for contributors.

Use the existing same-origin `/api` web build so an operator's domain does not
require a new frontend build. Keep deploy-time proxy configuration separate from
browser-exposed settings. Reconcile the root and Railway Dockerfiles around a
shared build definition where practical, while retaining explicit migration
behavior for each target.

Before calling this supported, verify anonymous pulls, image identity, required
runtime files, and actual amd64/arm64 execution. Public registry location, retention,
release signing/provenance, and supported CPU/OS matrix need delivery decisions.
Building a multi-platform image alone is not runtime proof.

### H2: Guided Setup And First Use

Depends on H1 for installation without source builds. Provide an inspectable,
versioned helper that runs packaged tools through Docker and checks required Docker
and Compose capabilities before changing anything.

Ask for the installation mode, public origin/proxy choice, owner identity, and
email configuration. Derive internal service addresses and generate unique
secrets into a protected configuration store. Refuse accidental replacement of
existing configuration; expose explicit edits and redacted validation outcomes.
Do not ask users to paste secret values into terminal command arguments.

Create the bucket, apply migrations, bootstrap the first owner, and wait for
readiness in a documented order. Separate owner bootstrap from demo import and
preserve existing account/lifecycle state on retries. Keep bootstrap material out
of normal restart configuration and never print it in status or diagnostics.

Offer two clearly labelled journeys:

- **Evaluate locally:** disposable data, loopback-only access, optional synthetic
  examples, and local mail capture. The full-stack test setup offers reusable
  components, but its temporary storage, test domains, and SMTP exceptions are
  not a production recipe. End-user browser cookies, MFA, and action links need
  their own supported local-origin/TLS design and verification.
- **Run persistently:** protected credentials, durable PostgreSQL/artifacts,
  working auth email, a known HTTPS ingress, and a documented recovery path.
  Support an existing reverse proxy first; evaluate an optional managed TLS
  proxy profile without replacing an operator's current ingress.

First use should end with owner sign-in, a reviewed sample import, package
inspection, and a guided CLI/MCP connection. Report application readiness and
actual user-journey completion separately.

Docker supports health-gated dependencies and successful one-shot dependencies;
use those existing mechanisms with a bounded startup wait. Verify restart and
partially completed setup behavior on the supported Compose versions.
[Startup ordering](https://docs.docker.com/compose/how-tos/startup-order/),
[Compose startup wait](https://docs.docker.com/reference/cli/docker/compose/up/).

### H3: Faster Builds And Predictable Operations

For source builds, copy root/workspace package manifests and the lockfile before
source, then run the existing declared npm version and `npm ci`. Inspect workspace
lifecycle requirements before moving layers. Use a supported package cache and
shared build stages where appropriate; keep mutable application outputs isolated.
Docker documents layer ordering, cache mounts, and external cache options.
[Docker cache guidance](https://docs.docker.com/build/cache/optimize/).

Package status, diagnostic, backup, update, and recovery commands around existing
services. Status should show source/image identity, database/artifact readiness,
and backup freshness without credentials. Prefer focused diagnostic checks over
raw environment or expanded Compose dumps.

An update should select an exact release set, check compatibility and the recovery
point, run migrations once, wait for API readiness, then advance web/optional MCP.
Migrations are forward-only: an old image is not automatically a valid rollback.
Reuse the coordinated recovery format and require an isolated restore drill before
claiming recovery support. Keep destructive restore explicit and target-checked.

H3 build-cache work can be evaluated independently of H2. Packaged operations
depend on H1 and the established backup/recovery contracts.

### H4: Railway Template And Release Promotion

Depends on H1 and a proven first-owner/configuration flow. Model web, API,
PostgreSQL, artifact storage, and backup resources explicitly. Prefer service
references and generated values over copying credentials. Begin from a public-safe
template definition; never export an operator's live configuration.

Railway supports templates and public image deployment. Its Compose guide says
services must be mapped individually and `depends_on` has no direct equivalent.
Prove API-ready-then-web promotion rather than assuming Compose ordering transfers.
[Templates](https://docs.railway.com/templates/create),
[image deployments](https://docs.railway.com/services),
[Compose mapping](https://docs.railway.com/guides/docker-compose).

Evaluate a bounded migration pre-deploy command with the existing database lock,
then a normal server start. Railway runs that command in a separate container,
with private networking and environment variables but without attached volumes;
failure stops deployment. Configure its timeout. Keep first-owner creation separate
and prove database readiness on a fresh project. Preserve startup migration as the
alternative until this path is validated.
[Pre-deploy behavior](https://docs.railway.com/deployments/pre-deploy-command).

Open platform questions: template provisioning of both storage buckets, secret
references, domain/origin resolution, first-owner bootstrap, backup scheduling,
and coordinated update behavior. The template documentation does not establish
all of these for MySkills. A fresh isolated-project rehearsal is required before
publishing a deploy button. Infrastructure/provider charges are operator choices;
this investigation did not provision a project or estimate a hosting price.

## Architecture Options To Decide Separately

| Option | Benefit | Additional obligation | Recommendation |
| --- | --- | --- | --- |
| Existing split app with release images and helper | Removes build and orchestration work from operators while retaining existing boundaries. | Image publication, bootstrap separation, packaging and end-to-end proof. | First candidate. |
| Same images with Railway template | Reduces repetitive managed-platform setup and avoids platform source builds. | Template provisioning and deployment-order rehearsal; provider account and operating cost. | Follow the portable path. |
| One application image/process for web, API, and possibly MCP | Could reduce service count and origin configuration. | Static serving, caching, health/shutdown, auth routing, MCP isolation, and migration of existing installs. | Measure the simpler packaging path first. |
| Filesystem artifacts or a supported small-instance database mode | Could remove the local S3 service. | New storage guarantees, volume semantics, concurrency, migration, coordinated recovery, and production policy. | Separate design; do not enable the existing development DB mode in production. |

A single container with several supervised processes is not automatically easier
to maintain. Keep PostgreSQL and durable recovery requirements explicit when
comparing service counts. Broader Kubernetes, appliance-store, and hosting-provider
support can follow evidence of demand; none is required for the first candidate.

## Proposed Verification And Measurements

No timings or improvement percentages were measured in this investigation. Before
setting a setup-time promise, record the current source-build path and candidate
image path on the same documented hardware, architecture, Docker/Compose version,
network, and storage. Keep cold-cache and warm-cache runs separate.

| Measure or proof | Record | Proposed acceptance |
| --- | --- | --- |
| Operator effort | Prerequisites, decisions, commands, manual secret copies, edits, and documentation jumps. | Persistent quick start needs Docker/Compose plus the versioned bundle; no host Node/npm or source build. Generated/derived fields need no manual duplication. |
| Time to usable instance | Download/pull, build, configuration, migration, readiness, owner sign-in, and first authorized skill delivery. | Candidate reduces measured operator effort and cold setup time; choose a time target after the baseline. Show hardware/network conditions with any published claim. |
| Build reuse | Clean build, source-only edit, dependency change, image size, cache hits, and elapsed time. | A source-only change reuses dependency installation when workspace lifecycle permits it; required artifact and runtime checks still pass. |
| Configuration and retry | Existing config, occupied port, invalid email settings, unavailable database/storage, failed migration, and interrupted bootstrap. | Clear bounded failure, no secret output, no config overwrite, no account reset, and no incomplete-success claim. |
| Fresh browser/agent journey | Owner sign-in, MFA, auth action link, import/review/publish, exact authorized package delivery, and chosen MCP/CLI client. | Actual user workflow passes; healthy containers alone do not count. |
| Update and recovery | Previous supported release, preserved data, failed update, exact image identity, coordinated backup, and isolated restore. | Known recovery boundary, verified restored package bytes and auth, no automatic schema downgrade or destructive production test. |
| Platform support | Anonymous pulls and native amd64/arm64 runtime results; a fresh Railway project if H4 is selected. | Advertise only the combinations exercised; templates and manifests alone are insufficient. |

The first implementation plan should select H1/H2 scope, decide whether local
evaluation belongs in that same slice, and set the measurement budget. Build-cache
work and the Railway template can be sequenced around those dependencies. Final
priority, owners, effort estimates, and releases belong to the
[full roadmap review](ROADMAP.md#next-roadmap-review).
