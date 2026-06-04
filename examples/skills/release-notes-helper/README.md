# Release Notes Helper

Public-safe example skill package for AI Skills Share.

This example mirrors the seeded demo skill. It is intentionally small so package validation, scanning, submission, review, export, and install workflows have a clean fixture that does not depend on private context.

## Validate

```bash
npm run build
node apps/cli/dist/index.js validate --path examples/skills/release-notes-helper
node apps/cli/dist/index.js scan --path examples/skills/release-notes-helper
```
