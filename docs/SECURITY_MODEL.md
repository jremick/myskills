# Security Model

Version: 0.1.0
Last updated: 2026-06-04

## Main Risks

- Unauthorized users discovering restricted skills.
- Uploaded packages containing secrets, unsafe instructions, harmful scripts, or private data.
- CLI or MCP clients bypassing server-side authorization.
- Provider claims granting roles too broadly.
- Object storage exposing artifacts directly.
- Audit logs leaking tokens, package contents, or private data.

## Required Controls

### Authentication

- Password hashes are never stored on the user record.
- Session tokens are opaque and stored only as hashes.
- API tokens are opaque, scoped, stored only as hashes, and returned in plaintext only once.
- API token management requires a session; API tokens cannot create, list, or revoke other tokens.
- CLI login tokens are stored locally by normalized API URL with user-only file permissions; platform keychain storage remains the target hardening path.
- Login uses normalized email lookup and generic invalid-credential denial.
- Existing sessions are denied when the user is no longer active or email verified.
- Login and registration are throttled before repeated expensive auth work.
- Email verification before normal account use.
- Rate limits on auth endpoints.
- TOTP MFA uses encrypted authenticator secrets, short-lived challenge tokens, session-bound verification timestamps, and hashed single-use recovery codes.
- Review and publish actions require MFA for owner, admin, and maintainer identities; review-scoped API tokens must be issued from an MFA-verified session.
- User and registration administration requires an MFA-verified owner/admin session; API tokens cannot call admin routes.
- User disable/delete revokes the target user's sessions and API tokens and blocks self-lockout.
- Session revocation and all-session logout.
- Admin bootstrap flow that cannot be repeated after setup.

### Authorization

- Server-side authorization for every registry result and artifact delivery.
- API-token access requires both local user roles and explicit token scopes.
- Role checks for submission review, package publication, lifecycle changes, audit, and user management.
- Generic denial responses where existence should not be revealed.
- Tests for allow and deny paths across API, web, CLI, and MCP.

### Package Safety

- Public search and detail expose only approved, scan-passed, published releases with artifact records.
- Submission intake accepts normalized package text entries or base64 `.zip` archive uploads; the API does not accept server-local paths or URLs.
- Submission intake requires a strict root package manifest file that matches the submitted manifest metadata; publish revalidates stored artifact manifests before release.
- Submission is role-gated to owner, admin, maintainer, and author accounts in the current slice; MFA enforcement for admin/maintainer submission remains a remaining hardening item.
- Server code generates artifact hashes, sizes, content type, and storage keys instead of trusting client-supplied values.
- Blocking scan findings reject the submission before skill, version, or artifact records are created.
- Warning findings remain reviewable but unpublished.
- Submitting a new unreviewed version must not mutate or hide an already approved public release.
- Public bundle delivery uses the same approved/public/passed/published predicate as public search and detail.
- Reject archive traversal, absolute paths, symlinks, encrypted archives, unsupported compression, excessive size, and excessive file count.
- Scan for secrets, private keys, tokens, credentials, risky shell commands, dependency install hooks, generated binaries, and unsafe prompt instructions.
- Require maintainer approval and an explicit publish action before publication.
- Store immutable artifact hashes.

### Audit

- Record auth events, access decisions, package delivery, submissions, reviews, lifecycle actions, admin changes, and MCP calls.
- Admin registration and user-status mutations write sanitized audit events; admin audit listing is MFA-verified session-only and bounded.
- Redact tokens, cookies, passwords, provider secrets, package contents, and overly long free-text fields.
- Export audit reports with spreadsheet formula injection defenses.

### MCP

- Authenticate every MCP request.
- Default to read-only tools.
- Keep package contents out of MCP results unless a future explicit, audited delivery tool is designed.
- Role-gate maintainer and admin tools.

## Minimum Security Tests

- Unauthenticated access is denied.
- Unauthorized restricted skill search, info, bundle, CLI, and MCP paths do not leak existence or contents.
- Revoked tokens stop working.
- API tokens without the required scope cannot submit or review even when the user has the matching role.
- MFA enrollment, challenge verification, recovery-code replay prevention, MFA-bound review token creation, and review-action MFA enforcement work.
- Package parser rejects unsafe archives.
- Scanner blocks known secret and unsafe-command fixtures.
- Audit sanitizer redacts sensitive fields.
- A newer unreviewed or unsafe version cannot displace a previously approved public release.
