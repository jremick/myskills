# Data Model

Version: 0.1.0
Last updated: 2026-06-04

This is the initial logical model. M1 tables are implemented as Drizzle/Postgres migrations and will keep evolving with the product surface.

## Milestone Scope

M1 tables are the thin backend proof. M2 tables harden auth and submissions. Later tables wait until product semantics are clearer.

## Identity

- M1 `users`: primary application users with normalized email uniqueness.
- M1 `password_credentials`: first-party email/password credentials.
- M2 `identities`: linked external provider identities such as OIDC, SAML, GitHub, Google, or Cloudflare Access.
- M1 `auth_sessions`: hashed opaque bearer sessions.
- M2 `auth_action_tokens`: hashed single-use email verification and password reset tokens with purpose, recipient, expiry, and consumed timestamp.
- M2 `mfa_factors`: TOTP, passkey, recovery-code, and future factors.
- M1 `api_tokens`: scoped hashed tokens for CLI, automation, and MCP clients, with non-secret display prefixes, expiry, revocation, and last-used tracking.
- M1 `roles`: global and scoped roles.
- M1 `role_assignments`: user to role mappings, initially instance-scoped.

## Registry

- M1 `skills`: stable skill identity, slug, title, summary, owner, visibility, and lifecycle.
- M1 `skill_versions`: semantic versions and release notes.
- M1 `skill_platform_variants`: target runtime metadata such as Codex, Claude, ChatGPT, generic prompt pack, or MCP resource bundle.
- M1 `skill_artifacts`: generated opaque storage references, checksums, sizes, content type, and legacy/dev normalized text package payloads. Production package bytes live in S3-compatible object storage, while Postgres remains the system of record for artifact metadata and release policy.
- Later `skill_dependencies`: optional relationships between skills.
- Later `skill_examples`: examples and expected use cases.
- M1 `skill_tags`: searchable taxonomy.

## Submissions And Review

- M2 `drafts`: private author workspace records.
- M2 `submissions`: review queue entries.
- M2 `submission_artifacts`: uploaded package archive and extracted normalized files.
- M2 `reviews`: maintainer decisions, requested changes, comments, and approvals.
- M2 `lifecycle_events`: approve, publish, deprecate, revoke, archive, delete, restore.
- M1 `scan_runs`: validation and security scan executions.
- M1 `scan_findings`: structured validation, secret, safety, dependency, and policy findings.

## Usage And Audit

- Later `install_records`: user, skill version, platform, target, status, and client metadata.
- Later `download_events`: package delivery records.
- Later `mcp_clients`: optional registered clients.
- Later `mcp_tool_events`: tool calls and decisions.
- M1 `audit_events`: security-relevant events with sanitized details.
- Later `notifications`: user-facing events and delivery status.

## Instance Settings

- M1 `settings`: registration mode, public browsing policy, default retention, upload limits.
- M2 `provider_configs`: non-secret provider metadata. Secrets live in secret stores.
- M2 `provider_role_mappings`: explicit claim-to-role mappings.
- Later `storage_configs`: object storage metadata.

Organization and team scoped visibility are intentionally deferred until the ownership model is designed. The first implementation uses single-instance roles plus public, authenticated, and private visibility.

## Key Constraints

- Skill slugs are unique per instance.
- Skill versions are unique per skill.
- Artifact objects are immutable after creation.
- Object-backed artifact reads verify byte size and SHA-256 before publication or delivery.
- Approved releases point only at scan-passed artifacts.
- Revoked skills are not discoverable through search and are blocked at delivery.
- Authorization denial should avoid revealing whether a restricted skill exists unless instance policy explicitly allows that visibility.
