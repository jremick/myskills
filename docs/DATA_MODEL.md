# Data Model

Version: 0.1.0
Last updated: 2026-06-04

This is the initial logical model. It should become migrations once the implementation stack is selected.

## Identity

- `users`: primary application users.
- `identities`: linked provider identities such as email/password, OIDC, SAML, GitHub, Google, or Cloudflare Access.
- `sessions`: browser and API sessions.
- `mfa_factors`: TOTP, passkey, recovery-code, and future factors.
- `api_tokens`: scoped tokens for CLI, automation, and MCP clients.
- `roles`: global and scoped roles.
- `role_assignments`: user to role mappings, optionally scoped to organization, team, or skill.

## Registry

- `skills`: stable skill identity, slug, title, summary, owner, visibility, and lifecycle.
- `skill_versions`: semantic versions and release notes.
- `skill_platform_variants`: target runtime metadata such as Codex, Claude, ChatGPT, generic prompt pack, or MCP resource bundle.
- `skill_artifacts`: object storage references, checksums, sizes, content type, and retention metadata.
- `skill_dependencies`: optional relationships between skills.
- `skill_examples`: examples and expected use cases.
- `skill_tags`: searchable taxonomy.

## Submissions And Review

- `drafts`: private author workspace records.
- `submissions`: review queue entries.
- `submission_artifacts`: uploaded package archive and extracted normalized files.
- `reviews`: maintainer decisions, requested changes, comments, and approvals.
- `lifecycle_events`: approve, publish, deprecate, revoke, archive, delete, restore.
- `scan_runs`: validation and security scan executions.
- `scan_findings`: structured validation, secret, safety, dependency, and policy findings.

## Usage And Audit

- `install_records`: user, skill version, platform, target, status, and client metadata.
- `download_events`: package delivery records.
- `mcp_clients`: optional registered clients.
- `mcp_tool_events`: tool calls and decisions.
- `audit_events`: security-relevant events with sanitized details.
- `notifications`: user-facing events and delivery status.

## Instance Settings

- `settings`: registration mode, public browsing policy, default retention, upload limits.
- `provider_configs`: non-secret provider metadata. Secrets live in secret stores.
- `provider_role_mappings`: explicit claim-to-role mappings.
- `storage_configs`: object storage metadata.

## Key Constraints

- Skill slugs are unique per instance.
- Skill versions are unique per skill.
- Artifact objects are immutable after creation.
- Approved releases point only at scan-passed artifacts.
- Revoked skills are not discoverable through search and are blocked at delivery.
- Authorization denial should avoid revealing whether a restricted skill exists unless instance policy explicitly allows that visibility.

