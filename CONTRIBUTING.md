# Contributing

AI Skills Share is in public alpha. Contributions are welcome when they keep the project self-hostable, public-safe, and aligned across API, web, CLI, and MCP surfaces.

## Development Principles

- Keep the product self-hostable and portable.
- Do not add organization-specific assumptions to public code or docs.
- Keep the API, CLI, web app, and MCP tools aligned around the same backend authorization decisions.
- Add verification for behavioral changes.

## Local Checks

```bash
npm run check
```

For package examples, also run:

```bash
npm run build
node apps/cli/dist/index.js validate --path examples/skills/release-notes-helper
node apps/cli/dist/index.js scan --path examples/skills/release-notes-helper
```

## Security

Do not include secrets, customer data, private company context, production tokens, or local machine state in issues, commits, test fixtures, examples, docs, or generated artifacts.

Do not file public issues for suspected vulnerabilities. Use the reporting path in [SECURITY.md](SECURITY.md).
