---
name: mcp-build
description: "Use for Model Context Protocol server work: build, review, deploy, extend, TypeScript SDK, Cloudflare Workers/Agents, stdio, and control-plane tools."
metadata:
  version: "1.1.3"
  last_updated: "2026-09-29"
---

# MCP Build

Version: 1.1.3
Last updated: 2026-09-29

Use this skill when the task involves MCP server design, implementation, security review, deployment, or reusable MCP project scaffolding.

## Core Defaults

- Treat `@modelcontextprotocol/sdk` as a project dependency, not a Codex skill. The reusable skill captures build conventions around the SDK.
- Use explicit schemas for all tool inputs, preferably `zod`.
- Prefer narrow, intent-based tools over generic API proxy tools.
- Keep tool outputs concise and structured for client compatibility.
- For TypeScript projects, declare `@modelcontextprotocol/sdk` directly instead of relying on transitive dependencies.
- Separate tool registration, integration clients, normalization, policy checks, and runtime entrypoints once a server has more than one tool or one upstream integration.

## Security Defaults

- Authenticate remote MCP servers at the server boundary, not only through an aggregator or portal.
- For Cloudflare MCP portals, remember that portal policies do not secure the upstream server's direct URL. Protect the upstream MCP server too before adding write/admin tools.
- Treat read-only, write, admin, and destructive actions as separate risk classes.
- Add a central action-risk registry before write/admin tools. Unknown actions must fail closed.
- Require server-side confirmation or a server-validated approval token for write/admin actions; do not rely only on model wording.
- Do not expose raw upstream APIs as MCP tools.
- Redact secrets in errors and logs, including raw and URL-encoded tokens.
- Keep health checks shallow by default. Put upstream/deep readiness behind auth.

## Stdio Defaults

- Keep stdio MCP servers stdout-clean. Do not document `npm start` as the MCP client command if lifecycle banners can reach stdout.
- Prefer build first, then direct `node dist/index.js` for stdio client configuration.
- Send logs and diagnostics to stderr.

## Cloudflare Remote MCP Defaults

- Load `~/.codex/skills/cloudflare-deploy/SKILL.md` and use `cf` for Cloudflare deployment and account/resource management. MCP server application code remains separate from the management interface.

- Check current Cloudflare docs before implementing auth or portal behavior.
- For Workers/Agents, validate the deployed route, bindings, secrets, and MCP endpoint.
- Use Cloudflare Access or OAuth-provider patterns when the MCP server is reachable over the internet.
- When using a Cloudflare MCP Portal, test both:
  - unauthenticated portal initialize returns `401 invalid_token`
  - direct upstream server does not bypass the intended auth boundary
- Use shallow `/health`; use authenticated `/ready` for upstream checks.

## Cloudflare MCP Hardening Checklist

Apply this checklist before treating an internet-reachable Cloudflare MCP server as ready for pilot use:

- Public unauthenticated `/mcp` must return `401` or the intended auth challenge.
- Public dynamic client registration should be disabled unless there is a deliberate approved-client workflow; public `/register` should normally return `404`.
- Local or dev MCP routes such as `/dev/mcp` must return `404` on public hostnames.
- Do not store upstream app client secrets in per-user grant props, session state, or KV records. Read them from Worker secrets at refresh/use time.
- Verify tenant, space, or resource scope before fetching large or sensitive upstream bodies.
- Redact Bearer tokens, Basic tokens, authorization codes, and secret-bearing query parameters from errors and logs.
- Disable persistent Worker logs or sampling on OAuth callback and token routes unless there is a reviewed retention reason.
- Keep notification/send quotas separate from authentication-email or magic-link abuse throttles.
- Run live route probes after deploy and record the expected status contract in project documentation or the approved local control plane.
- Keep residual hardening items explicit, especially authenticated rate limiting, approved-client registration, and write-tool exposure.

## Verification Checklist

Run the checks that fit the project:

- Type-check and lint.
- Unit tests for validation, normalization, policy gates, and error redaction.
- Negative tests for malformed IDs, path traversal, missing secrets, and unauthorized calls.
- MCP smoke test that initializes, lists/calls tools, and validates expected output.
- Dependency audit or equivalent lockfile check.
- Deployment dry-run or bundle check.
- Post-deploy smoke test against the real endpoint.

## Documentation Checklist

Update docs when behavior changes:

- Runtime topology and trust boundaries.
- Required secrets and bindings.
- MCP client connection method.
- Auth model and known direct-access risks.
- Tool list and risk class.
- Validation commands and expected outputs.
