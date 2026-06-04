# Legacy Prototype Review

Version: 0.1.0
Last updated: 2026-06-04

This is a public-safe summary of the prior internal prototype review. Exact private repo names, URLs, identities, and organization-specific details are intentionally omitted from committed files.

## What Was Reviewed

The most relevant source was a private CLI and registry service prototype for controlled AI skill discovery and installation. A separate private skill-content repository represented the old storage source.

The prototype test suite passed locally during review:

```text
157 tests passing
```

## Useful Product Lessons

- A registry service should be the trust boundary.
- CLI, web, API, and MCP access should share the same authorization checks.
- Unauthorized packages should not be visible or inferable by default.
- Package manifests need owner, version, lifecycle, review, security, platform, compatibility, install policy, examples, and test evidence.
- CLI workflows should include init, validate, scan, search, info, install, export, update, rollback, submit, and admin/review commands.
- MCP should start read-only with search/info/install-guidance tools.
- Package parsing needs defenses against unsafe zip paths, symlinks, excessive expansion, unsupported compression, and nested package confusion; the current local package tooling implements those core `.zip` defenses, while API archive upload remains a future boundary.
- Audit logs need strong sanitization.

## What Must Not Be Carried Forward

- Company-specific identity, domain, group, or wiki assumptions.
- Git-hosted content as the canonical backend.
- Private deployment URLs, secret names, users, policy mappings, or repository paths.
- Private skill content or internal examples.
- Source code copied from the prototype without a deliberate public-license review.

## Product Pivot

The open-source version should rebuild the backend around:

- Postgres system of record.
- Object storage for immutable package artifacts.
- First-party user management.
- Optional external identity-provider mappings.
- Public-safe package examples and tests.
