#!/usr/bin/env node

import { existsSync } from "node:fs";

const requiredPaths = [
  "README.md",
  "AGENTS.md",
  "LEARNING.md",
  ".env.example",
  "docker-compose.yml",
  "tsconfig.base.json",
  "docs/PRODUCT_BRIEF.md",
  "docs/ARCHITECTURE.md",
  "docs/AUTH_STRATEGY.md",
  "docs/DATA_MODEL.md",
  "docs/API_MCP_CLI_PLAN.md",
  "docs/ROADMAP.md",
  "docs/SECURITY_MODEL.md",
  "docs/adr/0001-proper-backend.md",
  "docs/adr/0002-first-party-auth.md",
  "apps/api/README.md",
  "apps/api/drizzle.config.ts",
  "apps/api/migrations/0000_initial_foundation.sql",
  "apps/api/src/app.ts",
  "apps/api/src/db/schema.ts",
  "apps/web/README.md",
  "apps/cli/README.md",
  "apps/mcp/README.md",
  "packages/core/README.md",
  "packages/auth/README.md",
  "packages/skill-package/README.md",
];

const missing = requiredPaths.filter((path) => !existsSync(path));

if (missing.length > 0) {
  console.error("Structure check failed. Missing paths:");
  for (const path of missing) {
    console.error(`- ${path}`);
  }
  process.exit(1);
}

console.log("Structure check passed.");
