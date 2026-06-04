# Project Learnings

Version: 0.1.0
Last updated: 2026-06-04

Record only durable lessons that should affect future work in this repo.

## 2026-06-04

- Keep the open-source product clean-room by default. Prior internal prototypes may inform feature inventory and risks, but public files should not copy private code, private content, identity assumptions, deployment URLs, or organization-specific terminology.
- The new backend must use a proper application data model. Postgres is the initial system of record; object storage holds package artifacts; GitHub is optional workflow integration rather than canonical storage.
- The auth model is first-party users first: email/password, email verification, admin-controlled registration, roles, sessions, MFA, account recovery, and optional external identity-provider mapping.
- Public account recovery and verification requests must preserve account-existence privacy even during notification delivery failures; known, unknown, and temporarily undeliverable accounts should receive the same generic response.
