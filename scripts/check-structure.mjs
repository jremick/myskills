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
  "apps/api/migrations/0001_auth_foundation.sql",
  "apps/api/migrations/0002_identity_constraints.sql",
  "apps/api/src/app.ts",
  "apps/api/src/auth/rate-limit.ts",
  "apps/api/src/auth/service.ts",
  "apps/api/src/auth/postgres-auth-store.ts",
  "apps/api/src/db/schema.ts",
  "apps/api/test/auth-routes.test.ts",
  "apps/cli/package.json",
  "apps/web/README.md",
  "apps/cli/README.md",
  "apps/cli/src/cli.ts",
  "apps/cli/test/cli.test.ts",
  "apps/mcp/README.md",
  "packages/core/README.md",
  "packages/auth/README.md",
  "packages/auth/src/password.ts",
  "packages/auth/src/session-token.ts",
  "packages/auth/test/password.test.ts",
  "packages/skill-package/src/package-path.ts",
  "packages/skill-package/test/package-path.test.ts",
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
