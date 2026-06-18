# API App

Backend API service and trust boundary for MySkills.

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
- `POST /v1/auth/email-verification/request` generic email verification token request
- `POST /v1/auth/email-verification/confirm` single-use email verification token confirmation
- `POST /v1/auth/password-reset/request` generic password reset token request
- `POST /v1/auth/password-reset/confirm` single-use password reset confirmation with credential revocation
- `POST /v1/auth/email-change/confirm` single-use new-email verification with credential revocation
- `POST /v1/auth/account/password` session-only password change with current-password reauth and credential revocation
- `POST /v1/auth/account/email-change` session-only email-change request with current-password reauth
- `POST /v1/auth/mfa/verify` MFA challenge verification with TOTP or recovery code
- `GET /v1/auth/mfa` session-only MFA status
- `POST /v1/auth/mfa/totp/enroll` session-only TOTP enrollment bootstrap with password reauth
- `POST /v1/auth/mfa/totp/confirm` session-only TOTP confirmation and one-time recovery code issuance
- `DELETE /v1/auth/mfa/totp` session-only TOTP removal with current-password reauth and credential revocation
- `POST /v1/auth/logout` current-session revocation
- `GET /v1/auth/api-tokens` session-only scoped API token list
- `POST /v1/auth/api-tokens` session-only scoped API token creation
- `DELETE /v1/auth/api-tokens/:id` session-only scoped API token revocation
- `GET /v1/admin/api-tokens` MFA-verified admin safe API token inventory
- `DELETE /v1/admin/api-tokens/:id` MFA-verified admin API token revocation
- `GET /v1/admin/registration` MFA-verified admin registration-mode read
- `PUT /v1/admin/registration` MFA-verified admin registration-mode update
- `GET /v1/admin/providers` MFA-verified admin provider config and role mapping list
- `PUT /v1/admin/providers/:key` MFA-verified admin non-secret provider config and role mapping upsert
- `GET /v1/admin/users` MFA-verified admin safe user list
- `POST /v1/admin/users/:id/actions` MFA-verified admin user status actions: `approve`, `activate`, `disable`, `delete`
- `PUT /v1/admin/users/:id/roles` MFA-verified admin user role update with owner-only privileged-role safeguards
- `GET /v1/admin/audit?limit=...` MFA-verified admin audit event list
- `GET /v1/me` bearer-session or scoped API-token current user response
- `GET /v1/mcp/session` API-token-only MCP auth check requiring `skills:read` with sanitized allow/deny audit events
- `GET /v1/submissions/mine` session-only submitted skill version list for the current user
- `GET /v1/submissions/:id/bundle` session-only package export for user-owned submitted versions
- `POST /v1/submissions/:id/actions` session-only author `withdraw`
- `POST /v1/submissions` authenticated package intake with strict root-manifest/package-file integrity checks, JSON text-entry payloads, JSON base64 `.zip` archive payloads, server-side archive extraction, and scan evidence
- `GET /v1/review/submissions` maintainer review queue, including approved unpublished submissions awaiting publish
- `POST /v1/review/submissions/:id/actions` maintainer `approve`, `request-changes`, `reject`, and `publish`
- `GET /v1/skills` public approved skill search
- `GET /v1/skills/:slug` public approved skill detail
- `GET /v1/skills/:slug/releases` owner/admin/maintainer release lifecycle summary
- `PUT /v1/skills/:slug` owner/admin/maintainer mutable skill metadata update
- `POST /v1/skills/:slug/actions` owner/admin/maintainer skill `archive`, `restore`, and `delete`
- `GET /v1/skills/:slug/releases/:version` public approved release metadata
- `POST /v1/skills/:slug/releases/:version/actions` owner/admin/maintainer release `deprecate`, `unpublish`, `revoke`, `restore`, and `delete`
- `GET /v1/skills/:slug/releases/:version/bundle?platform=...` public approved package payload delivery
- Drizzle Postgres schema and migrations
- synthetic seed data for one owner and one approved public skill

Public search, detail, release metadata, and bundle delivery all require the same safe release state: public skill, skill lifecycle `approved` or `deprecated`, version lifecycle `approved` or `deprecated`, approved review, passed security status, non-null `publishedAt`, non-deleted version row, and artifact metadata. Deprecated releases remain visible and installable; unpublished, revoked, archived, and deleted releases are hidden from public install/export paths. Submission is open to `author` and above; `owner`, `admin`, and `maintainer` submitters require an MFA-verified session or MFA-bound API token. Review, publish, and lifecycle actions require `owner`, `admin`, or `maintainer` and an MFA-verified session or MFA-bound API token. The review queue returns only safe metadata and excludes package file contents.

Package artifacts are stored through an S3-compatible object storage abstraction when `ARTIFACT_STORAGE_MODE=s3`. The API generates opaque object keys, hashes, byte sizes, and content types; submission requests cannot provide artifact metadata. Production startup defaults to S3 mode and rejects DB payload mode. Development can use `ARTIFACT_STORAGE_MODE=db`, but object-backed rows fail closed when object bytes are missing, invalid, or do not match stored metadata.

Admin routes require an interactive MFA-verified `owner` or `admin` session. API tokens cannot manage users, registration settings, provider configs, provider mappings, or role assignments. Disable and delete actions revoke the target user's active sessions and API tokens, and self-disable/self-delete is blocked. Role updates are audited, self-role changes are blocked, non-owner admins cannot grant or modify `owner`/`admin` roles, and at least one active owner is preserved.

Provider configs store only non-secret metadata and explicit claim-to-role mappings. Provider secrets must stay in deployment secret stores. External provider mappings currently allow only `user`, `author`, and `maintainer`; `admin` and `owner` remain local/manual roles. Provider mapping changes do not mutate existing local user role assignments.

Admin registration, provider config changes, user-status mutations, role mutations, and MCP session authorization decisions write sanitized audit events. Audit listing is newest-first, bounded to a maximum of 100 events per request, and returns only the event id, actor id, action, decision, resource reference, sanitized details, and timestamp.

API tokens are hashed at rest and returned in plaintext only on creation. Token management routes require an interactive session, not another API token. Current token scopes are `profile:read`, `skills:read`, `skills:submit`, `review:read`, and `review:write`; route checks require both the user role and the token scope. Owner, admin, and maintainer accounts must create review-scoped API tokens from an MFA-verified session. MFA-verified admins can list safe API token metadata across users and revoke tokens without seeing token hashes or plaintext.

TOTP secrets are encrypted before storage with `AUTH_SECRET`. Production startup fails if `AUTH_SECRET` is missing or shorter than 32 bytes.

Email verification, password reset, and email-change action tokens are opaque, short-lived, single-use, and stored only as SHA-256 hashes. Request endpoints return the same `202 { "status": "pending" }` body for known and unknown accounts, including delivery failures. Password reset, password change, email change, and MFA removal revoke the user's active sessions and API tokens and require a normal login/MFA flow afterward.

Auth notification delivery is configured with `AUTH_NOTIFICATION_MODE`:

- `console`: local development only; writes fragment-token action links to the process logger.
- `smtp`: production mode; sends via SMTP using `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`, optional `SMTP_USER`/`SMTP_PASSWORD`, and TLS settings.
- `resend`: production mode; sends through the Resend HTTPS API using `RESEND_API_KEY` and `RESEND_FROM`.
- `disabled`: local development only; no verification or reset delivery.

Production defaults to `smtp` for backward compatibility, rejects `console` and `disabled`, requires `APP_BASE_URL` to use HTTPS, rejects `SMTP_TLS_REJECT_UNAUTHORIZED=false` when SMTP is selected, and builds links only from the configured `APP_BASE_URL`.

Run locally:

```bash
npm install
cp .env.example .env
npm run docker:up
npm run db:migrate
npm run db:seed
npm run dev:api
```

`npm run docker:up` starts Postgres, MinIO, and a one-shot bucket initializer for `S3_BUCKET`. The seed command creates a verified owner account from `SEED_OWNER_EMAIL` and `SEED_OWNER_PASSWORD` in `.env`.
