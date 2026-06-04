# Security Policy

AI Skills Share is currently in public alpha. The project is suitable for evaluation and early self-hosting, but it is not yet a business-critical production platform.

## Supported Versions

Only the latest `main` branch and latest tagged alpha release receive security attention during alpha.

## Reporting A Vulnerability

Report vulnerabilities through GitHub private vulnerability reporting for this repository. Do not open public issues for suspected vulnerabilities, exposed secrets, bypasses, or package-safety escapes.

If GitHub does not show a private reporting button, contact the maintainer through their GitHub profile and request a private security channel before sharing details.

Include:

- affected commit or release tag
- affected component: API, web, CLI, MCP, package parser, deployment, or docs
- reproduction steps or proof of impact
- whether the report involves private data, credentials, or package contents

Expected response during alpha: best-effort triage, no SLA.

## Security Principles

- Keep secrets out of the repo.
- Keep uploaded packages isolated until validation and security scanning pass.
- Keep authorization checks server-side.
- Do not expose unauthorized package existence, metadata, or artifact contents through API, web, CLI, or MCP surfaces.
- Add tests for every access-control path.
