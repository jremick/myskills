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

- Email verification before normal account use.
- Rate limits on auth endpoints.
- MFA support for admins and maintainers.
- Session revocation and all-session logout.
- Admin bootstrap flow that cannot be repeated after setup.

### Authorization

- Server-side authorization for every registry result and artifact delivery.
- Role checks for submission review, package publication, lifecycle changes, audit, and user management.
- Generic denial responses where existence should not be revealed.
- Tests for allow and deny paths across API, web, CLI, and MCP.

### Package Safety

- Reject archive traversal, absolute paths, symlinks, encrypted archives, unsupported compression, excessive size, and excessive file count.
- Scan for secrets, private keys, tokens, credentials, risky shell commands, dependency install hooks, generated binaries, and unsafe prompt instructions.
- Require maintainer approval before publication.
- Store immutable artifact hashes.

### Audit

- Record auth events, access decisions, package delivery, submissions, reviews, lifecycle actions, admin changes, and MCP calls.
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
- MFA enforcement works for admin-required actions.
- Package parser rejects unsafe archives.
- Scanner blocks known secret and unsafe-command fixtures.
- Audit sanitizer redacts sensitive fields.

