# API App

Backend API service and trust boundary for AI Skills Share.

Planned responsibilities:

- authentication and sessions
- authorization decisions
- skill search and detail
- package submission, review, publication, and delivery
- object storage access
- audit events
- admin operations
- MCP gateway support where appropriate

The API must use the database as system of record. It must not treat Git as canonical storage.

## Current Slice

Implemented:

- `GET /health`
- `POST /v1/auth/register` admin-policy-gated self registration
- `POST /v1/auth/login` email/password login for active verified users
- `POST /v1/auth/logout` current-session revocation
- `GET /v1/me` bearer-session current user response
- `POST /v1/submissions` authenticated package intake with scan evidence
- `GET /v1/review/submissions` maintainer review queue
- `POST /v1/review/submissions/:id/actions` maintainer `approve` and `publish`
- `GET /v1/skills` public approved skill search
- `GET /v1/skills/:slug` public approved skill detail
- `GET /v1/skills/:slug/releases/:version` public approved release metadata
- `GET /v1/skills/:slug/releases/:version/bundle?platform=...` public approved package payload delivery
- Drizzle Postgres schema and migrations
- synthetic seed data for one owner and one approved public skill

Public search, detail, release metadata, and bundle delivery all require the same safe release state: public skill, approved lifecycle, approved review, passed security status, non-null `publishedAt`, and artifact metadata. Review and publish actions require `owner`, `admin`, or `maintainer`.

Run locally:

```bash
npm install
cp .env.example .env
npm run docker:up
npm run db:migrate
npm run db:seed
npm run dev:api
```

The seed command creates a verified owner account from `SEED_OWNER_EMAIL` and `SEED_OWNER_PASSWORD` in `.env`.
