# Business-Safe Production Release Goal

Version: 0.1.0-alpha.0
Last updated: 2026-06-04

## Goal

Turn the public alpha into a business-safe, production-ready open-source release that teams can operate with clear trust boundaries, setup paths, deployment guidance, security posture, auditability, and upgrade expectations.

## Success Criteria

- A fresh operator can deploy API, web, MCP HTTP, Postgres, and object storage from documented steps.
- Identity, registration, MFA, provider mapping, token, and role lifecycles are safe under common business use.
- Auth throttling survives restarts and multiple API replicas.
- Package submission, scanning, review, publication, artifact delivery, install, update, and rollback have durable integrity checks and audit evidence.
- Skill evals provide durable behavior, safety, compatibility, and regression evidence for submitted and published versions.
- API, web, CLI, and MCP enforce the same authorization decisions.
- Threat-model findings above accepted alpha risk are fixed, tested, or explicitly documented as unsupported.
- Releases are reproducible and publish the agreed artifacts: source, checksums, optional images, and release notes.
- Backup, restore, upgrade, rollback, monitoring, logging, and incident-response procedures are documented and rehearsed.

## Required Workstreams

### Identity And Admin Safety

- Provider login/linking and external identity lifecycle.
- Distributed auth rate limits with ingress throttling guidance and abuse alerts.
- Admin registration/invite flows beyond local owner bootstrap.
- Clear account recovery and MFA recovery operations.
- Business-safe role change audit and last-owner safeguards across all admin paths.

### Package And Artifact Safety

- Background scan jobs with durable status transitions, retries, and immutable scan evidence.
- Version-aware skill eval suites, durable eval runs, and reviewer-visible eval evidence.
- Signed or direct object delivery that keeps authorization, integrity verification, and audit intact.
- Stronger package policy fixtures for secrets, risky commands, install hooks, binaries, generated files, and prompt-injection patterns.
- Reviewer diff views that make package changes inspectable before approval.
- Version deprecate, revoke, and migration paths.

### MCP And Agent Surface

- Authoritative per-tool MCP audit events.
- Role-gated maintainer/admin MCP tools.
- Client compatibility matrix for stdio and HTTP transports.
- Explicit policy for whether MCP can ever retrieve package contents.

### CLI And Install Experience

- Platform keychain storage for CLI credentials.
- Browser or web session storage hardening for production mode.
- Browser login or device-code style login.
- Platform-specific install adapters.
- Archive creation and reproducible local packaging.
- Integration tests against a local API for install/update/rollback.

### Deployment And Operations

- Production-like deployment rehearsal.
- Backup/restore and migration runbooks.
- Monitoring/logging guidance for auth, package submission, review, artifact delivery, MCP, and background jobs.
- Container image publishing policy and upgrade notes.
- Release provenance with SHA-pinned actions, digest-pinned base images, SBOMs, signatures, and protected release tags.
- Managed-target deployment guide beyond Compose.

### Sharing And Authorization Model

- Ownership/grant model for authenticated, organization, team, private, and explicit-user package visibility.
- Uniform non-public visibility enforcement across search, detail, release metadata, bundle delivery, CLI, and MCP.
- Negative tests proving unauthorized users cannot infer restricted package existence or content.

## Release Gates

- `npm run check` passes.
- Fresh clone and production-like deploy rehearsals pass.
- Security review and threat model are refreshed after the production hardening work.
- All public docs describe the supported and unsupported production posture without alpha-only caveats.
- A release candidate tag is cut and the release workflow succeeds.
