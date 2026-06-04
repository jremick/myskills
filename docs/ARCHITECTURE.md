# Architecture

Version: 0.1.0
Last updated: 2026-06-04

## Core Decision

AI Skills Share is a database-backed application. The API service is the trust boundary. Web, CLI, and MCP clients receive only authorized metadata, package artifacts, and workflow results.

Git hosting integrations can help with import, export, PR review, changelogs, and releases, but they are not the canonical registry.

## System View

```mermaid
flowchart LR
  User["User"] --> Web["Web app"]
  User --> CLI["CLI"]
  Agent["MCP-capable client"] --> MCP["MCP endpoint"]

  Web --> API["API service"]
  CLI --> API
  MCP --> API

  API --> Auth["Auth and authorization"]
  API --> DB["Postgres"]
  API --> Objects["Object storage"]
  API --> Queue["Job queue"]
  API --> Audit["Audit sink"]
  API --> Email["SMTP notifications"]

  Auth --> DB
  Queue --> Scanner["Validation and security scanner"]
  Scanner --> DB
  Scanner --> Objects

  API -. optional .-> Providers["OIDC/SAML/Cloudflare Access"]
  API -. optional .-> Git["Git hosting import/export"]
```

## Runtime Surfaces

- `apps/api`: backend API, auth boundary, package delivery, moderation, admin, and audit.
- `apps/web`: browser UI consuming the API and shared auth contracts.
- `apps/cli`: command-line client for authors, users, maintainers, and admins.
- `apps/mcp`: MCP transport adapter, likely backed by the same API service.
- `packages/core`: domain contracts, errors, policy decisions, shared types.
- `packages/auth`: auth/session/role contracts and provider mapping helpers.
- `packages/skill-package`: manifest schema, validation, scanning, bundling, install metadata, and package IO.

## Backend Components

### Postgres

Postgres stores canonical product state:

- users, identities, sessions, auth action tokens, roles, MFA factors
- skills, versions, releases, platform variants
- packages, artifact references, checksums, scan results
- submissions, reviews, comments, lifecycle actions
- installs, downloads, API tokens, MCP client registrations
- settings, provider mappings, audit events or audit event pointers

### Object Storage

Object storage holds immutable binary and text artifacts:

- uploaded package archives
- extracted release files
- generated validation reports
- export bundles

The database stores object keys, sizes, content types, hashes, provenance, and retention policy.

### Queue

Background jobs handle:

- package extraction and normalization
- validation and security scanning
- checksum generation
- index updates
- queued notification delivery after direct SMTP is outgrown
- optional Git import/export tasks

### Search

Start with Postgres full-text search for MVP. Add OpenSearch, Meilisearch, Typesense, or vector search only when usage proves the need.

## Trust Boundaries

- The API service is the authorization boundary.
- Clients do not receive raw package files until authorization is complete.
- MCP tools do not bypass API authorization.
- Object storage is private by default. Use short-lived signed URLs only after an authorization check, or stream artifacts through the API.
- External identity providers prove identity, not application authorization. Local roles and policies decide access.
- Uploaded packages are untrusted until validation and scanning pass.

## Package Delivery

```mermaid
sequenceDiagram
  autonumber
  participant CLI as CLI
  participant API as API
  participant DB as Postgres
  participant OBJ as Object storage
  participant Audit as Audit

  CLI->>API: GET /v1/skills/:slug/releases/:version/bundle
  API->>DB: Load user, roles, skill, release, platform, policy
  API->>API: Authorize delivery
  API->>Audit: Record allow or deny
  alt allowed
    API->>OBJ: Read artifact or create signed delivery
    API-->>CLI: Bundle metadata and files
  else denied
    API-->>CLI: Generic not found or unauthorized
  end
```

## Implementation Choices

Initial choices:

- Runtime: Node.js first, with Fastify for the API service.
- Database: Postgres with Drizzle schema and SQL migrations.
- Queue: Postgres-backed `jobs` table first; no Redis dependency until scan volume requires it.
- Storage: S3-compatible object storage interface, with MinIO in local Docker Compose.
- Search: Postgres full-text search first.
- MCP: official TypeScript MCP SDK when the API authorization model is stable.

These choices keep the open-source setup portable and avoid early vendor lock-in.

## Deployment Shape

The first production-friendly path should support:

- Docker Compose for self-hosted local and small-team deployments.
- Postgres and S3-compatible object storage.
- Node runtime for the first production path. Worker/serverless deployment can be evaluated after auth, streaming, object storage, and MCP constraints are proven.
- Optional managed hosting recipes for Cloudflare, Fly.io, Railway, Render, or Vercel.

The app should not require any single vendor to run.
