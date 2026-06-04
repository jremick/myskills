# Authentication Strategy

Version: 0.1.0
Last updated: 2026-06-04

## Direction

AI Skills Share should own its user model directly. External providers can help users sign in, but local users, roles, registration policy, sessions, MFA state, audit, and authorization remain application-owned.

## Candidate Library

Better Auth is the current candidate for the TypeScript implementation. Its current docs show support for:

- email/password authentication
- email verification and password reset flows
- admin, roles, and permissions plugins
- two-factor authentication
- passkeys
- social providers
- account linking
- database-backed auth with Postgres

This is a planning decision, not a permanent lock-in. The first implementation milestone should spike Better Auth against the selected API/web runtime before committing broadly.

Spike acceptance:

- Works with the Node/Fastify API runtime or has a clean boundary through a dedicated auth handler.
- Uses Postgres without forcing a second canonical user store.
- Supports email/password, verification, password reset, admin/role controls, and two-factor plugins.
- Can coexist with CLI/API token flows.
- Does not make an external provider the source of application authorization.

## Required Product Behavior

### Registration

Admins can choose:

- closed registration: admins invite users
- request registration: users request access and admins approve
- open registration: anyone can register, optionally restricted by email domain

Every registration path should support email verification and audit events.

### Authentication

Required:

- email and password
- email verification
- secure password reset
- session management
- logout from current session and all sessions
- rate limiting on login, registration, reset, MFA, and token endpoints

Recommended for first public release:

- TOTP MFA
- recovery codes
- passkeys as optional second factor or passwordless sign-in

### Authorization

Use application roles and scopes:

- `user`: browse and install visible approved skills
- `author`: create private drafts and submit packages
- `maintainer`: review submissions and approve releases in assigned scopes
- `admin`: manage users, settings, provider mappings, and global lifecycle actions
- `owner`: initial instance owner with break-glass controls

Provider groups, Cloudflare Access claims, OIDC claims, or SAML attributes can map into local roles only through explicit admin configuration.

### API And CLI Tokens

CLI login should use browser-based device or authorization-code flow where possible, then store a scoped application token locally.

Token rules:

- store CLI tokens in the platform secret store by default
- support token revocation and rotation
- expose token names, scopes, last used time, and expiry in account settings
- never store provider refresh tokens on the CLI
- use short-lived access tokens plus refresh or session-bound tokens where practical

### Cloudflare Integration

Cloudflare should be optional:

- Cloudflare Access can protect an instance or admin area.
- Cloudflare Access identity can map to a local user after verification.
- Cloudflare Turnstile can protect public registration and reset flows.
- Cloudflare R2 can be an object storage option.
- Cloudflare Workers can be a deployment target if framework and auth constraints fit.

No Cloudflare feature should be required for the core open-source app.

## Auth Verification Checks

- Email/password signup, verification, login, logout, and reset tests.
- Admin registration modes tested for allow and deny paths.
- MFA setup, challenge, recovery, disable, and lockout tests.
- Provider mapping tests for unmapped, mapped, downgraded, and revoked identities.
- CLI token tests for storage, refresh, revocation, and scope denial.
- API, web, and MCP authorization parity tests.
