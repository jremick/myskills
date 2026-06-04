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
- `GET /v1/me` authentication-required response
- `GET /v1/skills` public approved skill search
- Drizzle Postgres schema and initial migration
- synthetic seed data for one owner and one approved public skill

Run locally:

```bash
npm install
cp .env.example .env
npm run docker:up
npm run db:migrate
npm run db:seed
npm run dev:api
```
