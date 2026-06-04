# ADR 0001: Use A Proper Application Backend

Version: 0.1.0
Last updated: 2026-06-04

## Status

Accepted.

## Context

MySkills needs a backend that can safely model users, roles, submissions, reviews, package artifacts, audit events, API tokens, and lifecycle policy. Source-control hosting can remain a useful compatibility and publishing workflow, but registry permissions, review decisions, artifact state, and audit history need an application-owned trust boundary.

## Decision

MySkills will use Postgres as the canonical system of record and object storage for package artifacts.

Source-control integrations may be added for import, export, review packets, changelog sync, or release automation, but they are optional workflows around the registry rather than the registry itself.

## Consequences

- The data model can support real users, roles, submissions, reviews, audit, tokens, package versions, and analytics.
- Self-hosters are not forced to grant the app broad repository access.
- Package review can still integrate with source-control workflows later.
- The first implementation milestone must include migrations, seed data, object storage abstraction, and backend tests.
