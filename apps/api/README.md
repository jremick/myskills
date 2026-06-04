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
- `POST /v1/auth/login` email/password login for active verified users, returning an MFA challenge when TOTP is enabled
- `POST /v1/auth/mfa/verify` MFA challenge verification with TOTP or recovery code
- `GET /v1/auth/mfa` session-only MFA status
- `POST /v1/auth/mfa/totp/enroll` session-only TOTP enrollment bootstrap with password reauth
- `POST /v1/auth/mfa/totp/confirm` session-only TOTP confirmation and one-time recovery code issuance
- `POST /v1/auth/logout` current-session revocation
- `GET /v1/auth/api-tokens` session-only scoped API token list
- `POST /v1/auth/api-tokens` session-only scoped API token creation
- `DELETE /v1/auth/api-tokens/:id` session-only scoped API token revocation
- `GET /v1/admin/registration` MFA-verified admin registration-mode read
- `PUT /v1/admin/registration` MFA-verified admin registration-mode update
- `GET /v1/admin/users` MFA-verified admin safe user list
- `POST /v1/admin/users/:id/actions` MFA-verified admin user status actions: `approve`, `activate`, `disable`, `delete`
- `GET /v1/admin/audit?limit=...` MFA-verified admin audit event list
- `GET /v1/me` bearer-session or scoped API-token current user response
- `GET /v1/mcp/session` API-token-only MCP auth check requiring `skills:read`
- `POST /v1/submissions` authenticated package intake with strict root-manifest/package-file integrity checks and scan evidence
- `GET /v1/review/submissions` maintainer review queue
- `POST /v1/review/submissions/:id/actions` maintainer `approve` and `publish`
- `GET /v1/skills` public approved skill search
- `GET /v1/skills/:slug` public approved skill detail
- `GET /v1/skills/:slug/releases/:version` public approved release metadata
- `GET /v1/skills/:slug/releases/:version/bundle?platform=...` public approved package payload delivery
- Drizzle Postgres schema and migrations
- synthetic seed data for one owner and one approved public skill

Public search, detail, release metadata, and bundle delivery all require the same safe release state: public skill, approved lifecycle, approved review, passed security status, non-null `publishedAt`, and artifact metadata. Review and publish actions require `owner`, `admin`, or `maintainer` and an MFA-verified session or MFA-bound API token.

Admin routes require an interactive MFA-verified `owner` or `admin` session. API tokens cannot manage users or registration settings. Disable and delete actions revoke the target user's active sessions and API tokens, and self-disable/self-delete is blocked.

Admin registration and user-status mutations write sanitized audit events. Audit listing is newest-first, bounded to a maximum of 100 events per request, and returns only the event id, actor id, action, decision, resource reference, sanitized details, and timestamp.

API tokens are hashed at rest and returned in plaintext only on creation. Token management routes require an interactive session, not another API token. Current token scopes are `profile:read`, `skills:read`, `skills:submit`, `review:read`, and `review:write`; route checks require both the user role and the token scope. Owner, admin, and maintainer accounts must create review-scoped API tokens from an MFA-verified session.

TOTP secrets are encrypted before storage with `AUTH_SECRET`. Production startup fails if `AUTH_SECRET` is missing or shorter than 32 bytes.

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
