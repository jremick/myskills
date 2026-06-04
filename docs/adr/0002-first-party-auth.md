# ADR 0002: First-Party User Management

Version: 0.1.0
Last updated: 2026-06-04

## Status

Accepted.

## Context

The open-source product cannot depend on a single external company identity provider or wiki group model. Self-hosted instances need direct user management and optional provider integration.

## Decision

MySkills will own its user, role, session, MFA, and registration model.

Email/password authentication is required. Admins can configure registration mode. MFA is required for production-ready admin and maintainer workflows. External providers are optional adapters that link to local users and local authorization decisions.

## Consequences

- The app can run for individuals, teams, companies, and communities.
- Provider integration becomes portable and optional.
- Auth work must be treated as a first-class implementation milestone, not a deployment detail.

