# ADR 0003: TypeScript Monorepo

Version: 0.1.0
Last updated: 2026-06-04

## Status

Proposed.

## Context

The product needs a backend API, web UI, CLI, MCP gateway, package validation logic, auth contracts, and shared domain types.

## Decision

Use a TypeScript monorepo with `apps/*` for deployable surfaces and `packages/*` for shared logic.

## Consequences

- Shared authorization and package validation can be reused by API, CLI, and MCP.
- The repo can add framework-specific dependencies only when implementation begins.
- The monorepo should keep package boundaries strict enough that CLI and MCP do not import web-only code.

